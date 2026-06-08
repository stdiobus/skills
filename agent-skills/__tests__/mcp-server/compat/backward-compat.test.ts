/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Backward-Compatibility Regression Tests (Migration Safety Net)
// Feature: federated-skills-runtime — Task 5.1
//
// Purpose: Capture the PRE-migration MCP contract so the Task 5.2 adapter
//          rewrite cannot silently break published consumers. These tests
//          MUST pass against the current server and MUST continue passing
//          after the adapter is rewritten to delegate to the SkillsRuntime.
//
// Captured contract:
//   1. The five tool names, their input parameter sets, and response shapes.
//   2. `read_skill` of a published name returns SKILL.md BYTE-FOR-BYTE.
//   3. `skills-manifest.json` is served with identical content.
//   4. The `SkillName` export retains the same members.
//
// Design notes:
//   - Part A (deterministic, no spawn) pins byte-for-byte SKILL.md content,
//     manifest content, and SkillName membership using the FileResolver
//     (reused unchanged per Req 3.6) and the `SkillName` export (kept per
//     Req 9.3). These sources survive the adapter rewrite.
//   - Part B captures the externally observable MCP surface (tool names,
//     input-parameter key sets, and response shapes) by driving the built
//     server over stdio — the true consumer-facing contract that the rewrite
//     must preserve. It deliberately does not assert the *type* of the
//     `skill` schema (enum vs string), because Task 5.2 changes the validator
//     while keeping the parameter set unchanged.
//
// Validates: Requirements 9.1, 9.2, 9.3, 9.8
// =============================================================================

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

import { SkillName } from '../../../types';
import { createFileResolver } from '../../../lib/file-resolver';
import type { SkillManifest } from '../../../types';

// Repo root: .../agent-skills/__tests__/mcp-server/compat -> up 4 levels.
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const AGENT_SKILLS_DIR = path.join(PACKAGE_ROOT, 'agent-skills');
const MANIFEST_PATH = path.join(AGENT_SKILLS_DIR, 'skills-manifest.json');
const MCP_SERVER_PATH = path.join(PACKAGE_ROOT, 'out', 'dist', 'mcp-server.mjs');

/** A published skill name used for byte-for-byte assertions. */
const PUBLISHED_SKILL = 'runtime-concepts';
/** A second published skill from the other collection, for robustness. */
const PUBLISHED_SKILL_2 = 'stdiobus-sdk-node';

// -----------------------------------------------------------------------------
// Golden contract snapshots — the frozen pre-migration surface.
// -----------------------------------------------------------------------------

/**
 * The five tool names mapped to their input parameter key sets.
 * This is the consumer-facing input contract; the rewrite may change the
 * validator (e.g. `z.enum` -> `z.string`) but MUST NOT change these keys.
 */
const TOOL_PARAM_KEYS: Record<string, string[]> = {
  list_skills: [],
  read_skill: ['skill'],
  list_references: ['skill'],
  read_reference: ['skill', 'reference'],
  search_skills: ['query'],
};

const EXPECTED_TOOL_NAMES = Object.keys(TOOL_PARAM_KEYS).sort();

/**
 * The exact `SkillName` members (name -> value) at migration time. Frozen so
 * any accidental addition, removal, rename, or value typo is caught.
 */
const EXPECTED_SKILL_NAME_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ['RuntimeConcepts', 'runtime-concepts'],
  ['RuntimeLifecycle', 'runtime-lifecycle'],
  ['RuntimeApiCore', 'runtime-api-core'],
  ['RuntimeApiIntegrations', 'runtime-api-integrations'],
  ['RuntimePatternsHttp', 'runtime-patterns-http'],
  ['RuntimePatternsAsync', 'runtime-patterns-async'],
  ['RuntimePatternsDataEvents', 'runtime-patterns-data-events'],
  ['RuntimeSsrAndWeb', 'runtime-ssr-and-web'],
  ['RuntimeMultiplatform', 'runtime-multiplatform'],
  ['RuntimeAccelerator', 'runtime-acceleration'],
  ['RuntimeConstraintsAndGuardrails', 'runtime-constraints-and-guardrails'],
  ['RuntimeErrorsAndDiagnostics', 'runtime-errors-and-diagnostics'],
  ['RuntimeVersioningAndMigration', 'runtime-versioning-and-migration'],
  ['RuntimeValidationAndCi', 'runtime-validation-and-ci'],
  ['StdiobusSdkCpp', 'stdiobus-sdk-cpp'],
  ['StdiobusSdkNode', 'stdiobus-sdk-node'],
  ['StdiobusSdkRust', 'stdiobus-sdk-rust'],
];

// =============================================================================
// PART A — Deterministic contract (no process spawn)
// =============================================================================

describe('backward-compat: SkillName export membership (Req 9.3)', () => {
  it('exposes exactly the pre-migration members in the same order', () => {
    expect(Object.entries(SkillName)).toEqual(
      EXPECTED_SKILL_NAME_ENTRIES.map(([k, v]) => [k, v]),
    );
  });

  it('exposes the same set of member values (set semantics)', () => {
    const values = Object.values(SkillName).sort();
    const expected = EXPECTED_SKILL_NAME_ENTRIES.map(([, v]) => v).sort();
    expect(values).toEqual(expected);
  });

  it('every published skill name has a backing directory on disk', () => {
    for (const [, name] of EXPECTED_SKILL_NAME_ENTRIES) {
      const skillMd = path.join(AGENT_SKILLS_DIR, name, 'SKILL.md');
      expect(fs.existsSync(skillMd)).toBe(true);
    }
  });
});

describe('backward-compat: read_skill returns byte-for-byte SKILL.md (Req 9.2)', () => {
  const resolver = createFileResolver();

  it.each([PUBLISHED_SKILL, PUBLISHED_SKILL_2])(
    'resolver.readSkill("%s") is byte-for-byte identical to the on-disk file',
    async (skillName) => {
      const served = await resolver.readSkill(skillName);
      const onDisk = fs.readFileSync(
        path.join(AGENT_SKILLS_DIR, skillName, 'SKILL.md'),
        'utf-8',
      );
      expect(served).toBe(onDisk);
      // Guard against silent truncation / empty reads.
      expect(served.length).toBeGreaterThan(0);
    },
  );
});

describe('backward-compat: skills-manifest.json is served identically (Req 9.8)', () => {
  const resolver = createFileResolver();
  const diskText = fs.readFileSync(MANIFEST_PATH, 'utf-8');
  const diskParsed = JSON.parse(diskText) as SkillManifest;

  it('the resolved manifest deep-equals the on-disk manifest', async () => {
    const manifest = await resolver.readManifest();
    expect(manifest).toEqual(diskParsed);
  });

  it('the served manifest serialization is identical to the current contract', async () => {
    // The pre-migration server serves `JSON.stringify(manifest, null, 2)`.
    const manifest = await resolver.readManifest();
    const served = JSON.stringify(manifest, null, 2);
    expect(served).toBe(JSON.stringify(diskParsed, null, 2));
  });

  it('preserves the published version and full skill set', async () => {
    const manifest = await resolver.readManifest();
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.skills.map((s) => s.name).sort()).toEqual(
      EXPECTED_SKILL_NAME_ENTRIES.map(([, v]) => v).sort(),
    );
  });
});

// =============================================================================
// PART B — Externally observable MCP surface (built server over stdio)
// =============================================================================

/**
 * Minimal NDJSON / JSON-RPC client over a spawned MCP server child process.
 * Self-contained so this safety net does not depend on other test internals.
 */
class McpClient {
  private proc: ChildProcess | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  async start(): Promise<void> {
    this.proc = spawn('node', [MCP_SERVER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: PACKAGE_ROOT,
      env: { ...process.env, NODE_ENV: 'test' },
    });
    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8');
      this.drain();
    });
    this.proc.stderr!.on('data', () => {
      /* diagnostics — ignored */
    });
    await new Promise((r) => setTimeout(r, 200));
  }

  private drain(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          p.resolve(msg);
        }
      } catch {
        /* non-JSON line */
      }
    }
  }

  request(method: string, params?: unknown, timeoutMs = 15_000): Promise<any> {
    if (!this.proc?.stdin) throw new Error('server not started');
    const id = this.nextId++;
    const req: any = { jsonrpc: '2.0', id, method };
    if (params !== undefined) req.params = params;
    const promise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.proc.stdin.write(JSON.stringify(req) + '\n');
    return promise;
  }

  notify(method: string, params?: unknown): void {
    if (!this.proc?.stdin) throw new Error('server not started');
    const n: any = { jsonrpc: '2.0', method };
    if (params !== undefined) n.params = params;
    this.proc.stdin.write(JSON.stringify(n) + '\n');
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('server stopped'));
    }
    this.pending.clear();
    const proc = this.proc;
    this.proc = null;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 2000);
      proc.on('exit', () => {
        clearTimeout(t);
        resolve();
      });
      proc.kill('SIGTERM');
    });
  }
}

async function callTool(client: McpClient, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.request('tools/call', { name, arguments: args });
  return res.result;
}

function expectTextResult(result: any): string {
  expect(result).toBeDefined();
  expect(Array.isArray(result.content)).toBe(true);
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe('text');
  expect(typeof result.content[0].text).toBe('string');
  return result.content[0].text;
}

describe('backward-compat: MCP tool surface and response shapes (Req 9.1, 9.2, 9.8)', () => {
  let client: McpClient;
  let toolsList: any;

  beforeAll(async () => {
    if (!fs.existsSync(MCP_SERVER_PATH)) {
      throw new Error(
        `MCP server bundle not found at ${MCP_SERVER_PATH}. Run "yarn build" first.`,
      );
    }
    client = new McpClient();
    await client.start();
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'compat-test', version: '1.0.0' },
    });
    client.notify('notifications/initialized');
    await new Promise((r) => setTimeout(r, 50));
    toolsList = await client.request('tools/list');
  }, 20_000);

  afterAll(async () => {
    await client?.stop();
  });

  it('exposes exactly the five pre-migration tool names', () => {
    const names = toolsList.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(EXPECTED_TOOL_NAMES);
  });

  it('each tool retains its exact input parameter key set', () => {
    for (const tool of toolsList.result.tools) {
      const expectedKeys = TOOL_PARAM_KEYS[tool.name];
      expect(expectedKeys).toBeDefined();
      const props = (tool.inputSchema && tool.inputSchema.properties) || {};
      expect(Object.keys(props).sort()).toEqual([...expectedKeys].sort());
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('list_skills returns a single text result with no error', async () => {
    const result = await callTool(client, 'list_skills', {});
    expect(result.isError).toBeFalsy();
    const text = expectTextResult(result);
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('list_skills serves manifest content identical to the current contract', async () => {
    const result = await callTool(client, 'list_skills', {});
    const text = expectTextResult(result);
    const diskParsed = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    // Parsed equality (content) ...
    expect(JSON.parse(text)).toEqual(diskParsed);
    // ... and exact served serialization (the pre-migration byte contract).
    expect(text).toBe(JSON.stringify(diskParsed, null, 2));
  });

  it.each([PUBLISHED_SKILL, PUBLISHED_SKILL_2])(
    'read_skill("%s") returns byte-for-byte identical SKILL.md content',
    async (skillName) => {
      const result = await callTool(client, 'read_skill', { skill: skillName });
      expect(result.isError).toBeFalsy();
      const text = expectTextResult(result);
      const onDisk = fs.readFileSync(
        path.join(AGENT_SKILLS_DIR, skillName, 'SKILL.md'),
        'utf-8',
      );
      expect(text).toBe(onDisk);
    },
  );

  it('list_references returns a JSON array of reference paths', async () => {
    const result = await callTool(client, 'list_references', { skill: PUBLISHED_SKILL });
    expect(result.isError).toBeFalsy();
    const text = expectTextResult(result);
    const refs = JSON.parse(text);
    expect(Array.isArray(refs)).toBe(true);
  });

  it('read_reference returns a single text result for a valid reference', async () => {
    const result = await callTool(client, 'read_reference', {
      skill: PUBLISHED_SKILL,
      reference: 'domain-model.md',
    });
    expect(result.isError).toBeFalsy();
    const text = expectTextResult(result);
    expect(text.length).toBeGreaterThan(0);
  });

  it('search_skills returns a JSON array result', async () => {
    const result = await callTool(client, 'search_skills', { query: 'lambda http api' });
    expect(result.isError).toBeFalsy();
    const text = expectTextResult(result);
    expect(Array.isArray(JSON.parse(text))).toBe(true);
  });
});
