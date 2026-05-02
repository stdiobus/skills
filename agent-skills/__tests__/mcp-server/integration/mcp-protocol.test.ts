/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Integration Test: MCP Protocol Compliance
// Feature: mcp-skills-server
// Purpose: Starts the MCP server as a child process and verifies full protocol
//          compliance over stdio — handshake, tool discovery, tool invocation,
//          and error handling via JSON-RPC 2.0 / NDJSON.
// Validates: Requirements 1.1, 1.2, 1.3, 1.4, 9.1, 9.4, 10.1, 10.4, 12.2, 12.3
// =============================================================================

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const MCP_SERVER_PATH = path.resolve(__dirname, '..', '..', '..', '..', 'out', 'dist', 'mcp-server.mjs');
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/** The 5 expected tool names exposed by the MCP server. */
const EXPECTED_TOOL_NAMES = [
  'list_skills',
  'read_skill',
  'list_references',
  'read_reference',
  'search_skills',
].sort();

/**
 * Helper: manages a child process running the MCP server and provides
 * JSON-RPC request/response communication over stdin/stdout.
 */
class McpTestClient {
  private process: ChildProcess | null = null;
  private buffer = '';
  private pendingResponses: Map<number, {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = new Map();
  private nextId = 1;
  private allStdoutLines: string[] = [];
  private rawStdoutReceived = false;

  /** Start the MCP server process. Returns when the process is spawned. */
  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.process = spawn('node', [MCP_SERVER_PATH], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: PACKAGE_ROOT,
        env: { ...process.env, NODE_ENV: 'test' },
      });

      this.process.stdout!.on('data', (chunk: Buffer) => {
        this.rawStdoutReceived = true;
        this.buffer += chunk.toString('utf-8');
        this.processBuffer();
      });

      // Drain stderr to prevent buffer blocking
      this.process.stderr!.on('data', () => { });

      this.process.on('error', (err) => {
        reject(new Error(`Failed to start MCP server: ${err.message}`));
      });

      // Give the process a moment to start
      setTimeout(() => resolve(), 200);
    });
  }

  /** Process the NDJSON buffer, resolving pending requests. */
  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      this.allStdoutLines.push(trimmed);

      try {
        const msg = JSON.parse(trimmed);
        if (msg.id !== undefined && this.pendingResponses.has(msg.id)) {
          const pending = this.pendingResponses.get(msg.id)!;
          clearTimeout(pending.timer);
          this.pendingResponses.delete(msg.id);
          pending.resolve(msg);
        }
      } catch {
        // Non-JSON line
      }
    }
  }

  /** Send a JSON-RPC request and wait for the response. */
  async sendRequest(method: string, params?: any, timeoutMs = 15_000): Promise<any> {
    if (!this.process?.stdin) {
      throw new Error('MCP server process not started');
    }

    const id = this.nextId++;
    const request: any = { jsonrpc: '2.0', id, method };
    if (params !== undefined) {
      request.params = params;
    }

    const responsePromise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingResponses.has(id)) {
          this.pendingResponses.delete(id);
          reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
        }
      }, timeoutMs);

      this.pendingResponses.set(id, { resolve, reject, timer });
    });

    this.process.stdin.write(JSON.stringify(request) + '\n');
    return responsePromise;
  }

  /** Send a JSON-RPC notification (no id, no response expected). */
  sendNotification(method: string, params?: any): void {
    if (!this.process?.stdin) {
      throw new Error('MCP server process not started');
    }

    const notification: any = { jsonrpc: '2.0', method };
    if (params !== undefined) {
      notification.params = params;
    }

    this.process.stdin.write(JSON.stringify(notification) + '\n');
  }

  /** Send raw text to stdin (for malformed request testing). */
  sendRaw(text: string): void {
    if (!this.process?.stdin) {
      throw new Error('MCP server process not started');
    }
    this.process.stdin.write(text + '\n');
  }

  /** Whether any stdout data was received. */
  hasReceivedStdout(): boolean {
    return this.rawStdoutReceived;
  }

  /** Get all stdout lines received so far. */
  getStdoutLines(): string[] {
    return [...this.allStdoutLines];
  }

  /** Stop the MCP server process. */
  async stop(): Promise<void> {
    if (!this.process) return;

    // Clear all pending response timers and reject
    for (const [, pending] of this.pendingResponses) {
      clearTimeout(pending.timer);
      pending.reject(new Error('MCP server stopped'));
    }
    this.pendingResponses.clear();

    const proc = this.process;
    this.process = null;

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 2000);

      proc.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      proc.kill('SIGTERM');
    });
  }
}

/**
 * Perform the MCP protocol handshake (initialize + initialized).
 * Returns the initialize response for assertions.
 */
async function performHandshake(client: McpTestClient): Promise<any> {
  const initResponse = await client.sendRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  });

  client.sendNotification('notifications/initialized');

  // Small delay to let the server process the notification
  await new Promise((r) => setTimeout(r, 50));

  return initResponse;
}

describe('MCP Protocol Integration Tests', () => {
  let client: McpTestClient;

  beforeAll(() => {
    // Verify the server bundle exists
    if (!fs.existsSync(MCP_SERVER_PATH)) {
      throw new Error(
        `MCP server bundle not found at ${MCP_SERVER_PATH}. Run "yarn build" first.`,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // Requirement 9.4: No stdout output before first request
  // ---------------------------------------------------------------------------
  describe('stdout reservation', () => {
    afterEach(async () => {
      await client?.stop();
    });

    it('produces no stdout output before the first request', async () => {
      client = new McpTestClient();
      await client.start();

      // Wait to see if anything appears on stdout unprompted
      await new Promise((r) => setTimeout(r, 500));

      expect(client.hasReceivedStdout()).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Main test suite: uses a shared server instance for efficiency
  // ---------------------------------------------------------------------------
  describe('with initialized server', () => {
    let initResponse: any;

    beforeAll(async () => {
      client = new McpTestClient();
      await client.start();
      initResponse = await performHandshake(client);
    }, 15_000);

    afterAll(async () => {
      await client?.stop();
    });

    // -------------------------------------------------------------------------
    // Requirements 1.1, 1.2: MCP protocol handshake
    // -------------------------------------------------------------------------
    describe('protocol handshake', () => {
      it('responds to initialize with server name and version', () => {
        expect(initResponse.jsonrpc).toBe('2.0');
        expect(initResponse.result).toBeDefined();
        expect(initResponse.result.serverInfo).toBeDefined();
        expect(initResponse.result.serverInfo.name).toBe('@stdiobus/skills');
        expect(initResponse.result.serverInfo.version).toBe('1.0.0');
      });

      it('includes protocol version in initialize response', () => {
        expect(initResponse.result.protocolVersion).toBeDefined();
        expect(typeof initResponse.result.protocolVersion).toBe('string');
      });

      it('reports tools capability in initialize response', () => {
        expect(initResponse.result.capabilities).toBeDefined();
        expect(initResponse.result.capabilities.tools).toBeDefined();
      });
    });

    // -------------------------------------------------------------------------
    // Requirements 1.3, 1.4: Tool discovery via tools/list
    // -------------------------------------------------------------------------
    describe('tool discovery', () => {
      let toolsResponse: any;

      beforeAll(async () => {
        toolsResponse = await client.sendRequest('tools/list');
      });

      it('returns exactly 5 tool definitions', () => {
        expect(toolsResponse.result).toBeDefined();
        expect(toolsResponse.result.tools).toBeDefined();
        expect(toolsResponse.result.tools).toHaveLength(5);
      });

      it('returns the correct tool names', () => {
        const toolNames = toolsResponse.result.tools.map((t: any) => t.name).sort();
        expect(toolNames).toEqual(EXPECTED_TOOL_NAMES);
      });

      it('each tool definition has name, description, and inputSchema', () => {
        for (const tool of toolsResponse.result.tools) {
          expect(typeof tool.name).toBe('string');
          expect(tool.name.length).toBeGreaterThan(0);
          expect(typeof tool.description).toBe('string');
          expect(tool.description.length).toBeGreaterThan(0);
          expect(tool.inputSchema).toBeDefined();
          expect(tool.inputSchema.type).toBe('object');
        }
      });
    });

    // -------------------------------------------------------------------------
    // Requirement 2: list_skills tool
    // -------------------------------------------------------------------------
    describe('tools/call — list_skills', () => {
      it('returns the full skills manifest with 12 entries', async () => {
        const response = await client.sendRequest('tools/call', {
          name: 'list_skills',
          arguments: {},
        });

        expect(response.result).toBeDefined();
        expect(response.result.isError).toBeUndefined();
        expect(response.result.content).toHaveLength(1);
        expect(response.result.content[0].type).toBe('text');

        const manifest = JSON.parse(response.result.content[0].text);
        expect(manifest.version).toBe('1.0.0');
        expect(manifest.skills).toHaveLength(12);
        expect(manifest.skills[0].name).toBeDefined();
        expect(manifest.skills[0].layer).toBeDefined();
      });
    });

    // -------------------------------------------------------------------------
    // Requirement 3: read_skill tool
    // -------------------------------------------------------------------------
    describe('tools/call — read_skill', () => {
      it('returns SKILL.md content for a valid skill name', async () => {
        const response = await client.sendRequest('tools/call', {
          name: 'read_skill',
          arguments: { skill: 'runtime-concepts' },
        });

        expect(response.result).toBeDefined();
        expect(response.result.isError).toBeUndefined();
        expect(response.result.content).toHaveLength(1);
        expect(response.result.content[0].type).toBe('text');

        const content = response.result.content[0].text;
        expect(content).toMatch(/^---\n/);
        expect(content).toContain('runtime-concepts');
      });

      it('returned content matches the actual SKILL.md file on disk', async () => {
        const response = await client.sendRequest('tools/call', {
          name: 'read_skill',
          arguments: { skill: 'runtime-concepts' },
        });

        const diskContent = fs.readFileSync(
          path.join(PACKAGE_ROOT, 'agent-skills', 'runtime-concepts', 'SKILL.md'),
          'utf-8',
        );

        expect(response.result.content[0].text).toBe(diskContent);
      });

      it('returns isError for invalid skill name via Zod validation', async () => {
        const response = await client.sendRequest('tools/call', {
          name: 'read_skill',
          arguments: { skill: 'not-a-real-skill' },
        });

        expect(response.result).toBeDefined();
        expect(response.result.isError).toBe(true);
        expect(response.result.content).toHaveLength(1);
        expect(response.result.content[0].type).toBe('text');
      });
    });

    // -------------------------------------------------------------------------
    // Requirement 4: list_references tool
    // -------------------------------------------------------------------------
    describe('tools/call — list_references', () => {
      it('returns a JSON array of reference file paths', async () => {
        const response = await client.sendRequest('tools/call', {
          name: 'list_references',
          arguments: { skill: 'runtime-concepts' },
        });

        expect(response.result).toBeDefined();
        expect(response.result.isError).toBeUndefined();
        expect(response.result.content).toHaveLength(1);
        expect(response.result.content[0].type).toBe('text');

        const references: string[] = JSON.parse(response.result.content[0].text);
        expect(Array.isArray(references)).toBe(true);
        expect(references.length).toBeGreaterThan(0);

        // No .gitkeep files
        for (const ref of references) {
          expect(ref).not.toBe('.gitkeep');
          expect(ref).not.toMatch(/\.gitkeep$/);
        }
      });

      it('includes nested subdirectory paths for pattern skills', async () => {
        const response = await client.sendRequest('tools/call', {
          name: 'list_references',
          arguments: { skill: 'runtime-patterns-async' },
        });

        const references: string[] = JSON.parse(response.result.content[0].text);
        const templatePaths = references.filter((r) => r.startsWith('templates/'));
        expect(templatePaths.length).toBeGreaterThan(0);
      });
    });

    // -------------------------------------------------------------------------
    // Requirement 5: read_reference tool
    // -------------------------------------------------------------------------
    describe('tools/call — read_reference', () => {
      it('returns file content for a valid skill and reference path', async () => {
        const response = await client.sendRequest('tools/call', {
          name: 'read_reference',
          arguments: { skill: 'runtime-concepts', reference: 'domain-model.md' },
        });

        expect(response.result).toBeDefined();
        expect(response.result.isError).toBeUndefined();
        expect(response.result.content).toHaveLength(1);
        expect(response.result.content[0].type).toBe('text');
        expect(response.result.content[0].text.length).toBeGreaterThan(0);
      });

      it('returned content matches the actual reference file on disk', async () => {
        const response = await client.sendRequest('tools/call', {
          name: 'read_reference',
          arguments: { skill: 'runtime-concepts', reference: 'domain-model.md' },
        });

        const diskContent = fs.readFileSync(
          path.join(PACKAGE_ROOT, 'agent-skills', 'runtime-concepts', 'references', 'domain-model.md'),
          'utf-8',
        );

        expect(response.result.content[0].text).toBe(diskContent);
      });

      it('rejects directory traversal attempts with isError: true', async () => {
        const response = await client.sendRequest('tools/call', {
          name: 'read_reference',
          arguments: { skill: 'runtime-concepts', reference: '../../../package.json' },
        });

        expect(response.result).toBeDefined();
        expect(response.result.isError).toBe(true);
        expect(response.result.content[0].text).toContain('directory traversal');
      });

      it('returns isError: true for a non-existent reference file', async () => {
        const response = await client.sendRequest('tools/call', {
          name: 'read_reference',
          arguments: { skill: 'runtime-concepts', reference: 'nonexistent-file.md' },
        });

        expect(response.result).toBeDefined();
        expect(response.result.isError).toBe(true);
        expect(response.result.content[0].type).toBe('text');
      });
    });

    // -------------------------------------------------------------------------
    // Requirement 6: search_skills tool
    // -------------------------------------------------------------------------
    describe('tools/call — search_skills', () => {
      it('returns search results sorted by score descending', async () => {
        const response = await client.sendRequest('tools/call', {
          name: 'search_skills',
          arguments: { query: 'lambda http api' },
        });

        expect(response.result).toBeDefined();
        expect(response.result.isError).toBeUndefined();
        expect(response.result.content).toHaveLength(1);
        expect(response.result.content[0].type).toBe('text');

        const results = JSON.parse(response.result.content[0].text);
        expect(Array.isArray(results)).toBe(true);
        expect(results.length).toBeGreaterThan(0);

        // Verify descending score order
        for (let i = 1; i < results.length; i++) {
          expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
        }

        // Each result has expected fields
        for (const result of results) {
          expect(result.skill).toBeDefined();
          expect(typeof result.score).toBe('number');
          expect(result.score).toBeGreaterThan(0);
          expect(result.description).toBeDefined();
          expect(typeof result.layer).toBe('number');
          expect(result.layerName).toBeDefined();
        }
      });

      it('returns empty array for a query with no matches', async () => {
        const response = await client.sendRequest('tools/call', {
          name: 'search_skills',
          arguments: { query: 'xyzzyplughtwisty' },
        });

        const results = JSON.parse(response.result.content[0].text);
        expect(Array.isArray(results)).toBe(true);
        expect(results).toHaveLength(0);
      });
    });

    // -------------------------------------------------------------------------
    // Requirement 10.4: Diagnostic output — stdout is valid JSON-RPC only
    // -------------------------------------------------------------------------
    describe('diagnostic output', () => {
      it('stdout contains only valid JSON-RPC messages', () => {
        const lines = client.getStdoutLines();
        expect(lines.length).toBeGreaterThan(0);

        for (const line of lines) {
          expect(() => JSON.parse(line)).not.toThrow();
          const parsed = JSON.parse(line);
          expect(parsed.jsonrpc).toBe('2.0');
        }
      });
    });

    // -------------------------------------------------------------------------
    // Requirement 10.1: Error handling — malformed JSON-RPC
    // The MCP SDK's StdioServerTransport silently drops malformed JSON
    // (parse errors are caught internally). We verify the server remains
    // operational after receiving malformed input.
    // -------------------------------------------------------------------------
    describe('error handling', () => {
      it('server remains operational after receiving malformed JSON', async () => {
        // Send malformed JSON
        client.sendRaw('this is not valid json{{{');

        // Small delay to let the server process the malformed input
        await new Promise((r) => setTimeout(r, 200));

        // Server should still respond to valid requests
        const response = await client.sendRequest('tools/call', {
          name: 'list_skills',
          arguments: {},
        });

        expect(response.result).toBeDefined();
        expect(response.result.isError).toBeUndefined();
        const manifest = JSON.parse(response.result.content[0].text);
        expect(manifest.skills).toHaveLength(12);
      });
    });

    // -------------------------------------------------------------------------
    // Requirement 12.3: End-to-end round-trip
    // -------------------------------------------------------------------------
    describe('end-to-end round-trip', () => {
      it('list_skills → read_skill → list_references → read_reference full flow', async () => {
        // Step 1: List all skills
        const listResponse = await client.sendRequest('tools/call', {
          name: 'list_skills',
          arguments: {},
        });
        const manifest = JSON.parse(listResponse.result.content[0].text);
        expect(manifest.skills).toHaveLength(12);

        // Step 2: Read the first skill
        const firstSkill = manifest.skills[0].name;
        const readResponse = await client.sendRequest('tools/call', {
          name: 'read_skill',
          arguments: { skill: firstSkill },
        });
        expect(readResponse.result.isError).toBeUndefined();
        const skillContent = readResponse.result.content[0].text;
        expect(skillContent).toMatch(/^---\n/);

        // Verify content matches disk
        const diskSkillContent = fs.readFileSync(
          path.join(PACKAGE_ROOT, 'agent-skills', firstSkill, 'SKILL.md'),
          'utf-8',
        );
        expect(skillContent).toBe(diskSkillContent);

        // Step 3: List references for that skill
        const refsResponse = await client.sendRequest('tools/call', {
          name: 'list_references',
          arguments: { skill: firstSkill },
        });
        expect(refsResponse.result.isError).toBeUndefined();
        const references: string[] = JSON.parse(refsResponse.result.content[0].text);
        expect(references.length).toBeGreaterThan(0);

        // Step 4: Read the first reference
        const firstRef = references[0];
        const refResponse = await client.sendRequest('tools/call', {
          name: 'read_reference',
          arguments: { skill: firstSkill, reference: firstRef },
        });
        expect(refResponse.result.isError).toBeUndefined();
        const refContent = refResponse.result.content[0].text;
        expect(refContent.length).toBeGreaterThan(0);

        // Verify reference content matches disk
        const diskRefContent = fs.readFileSync(
          path.join(PACKAGE_ROOT, 'agent-skills', firstSkill, 'references', firstRef),
          'utf-8',
        );
        expect(refContent).toBe(diskRefContent);
      });
    });
  });
});
