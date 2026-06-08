/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reusable hand-rolled MCP stdio client (NDJSON / JSON-RPC 2.0 over a child process).
 *
 * Generalizes the internal `McpTestClient` from the `mcp-protocol` integration test into a
 * standalone harness used by every e2e suite. It speaks the MCP wire protocol directly over
 * a spawned child's stdin/stdout — deliberately NOT via the `@modelcontextprotocol/sdk`
 * `Client` class, because that class is ESM-only and breaks under the ts-jest CommonJS
 * transform. This client is pure `child_process` + line framing, so it runs unchanged under
 * CommonJS while talking to a REAL MCP server over a REAL process boundary.
 *
 * Responses are correlated strictly by JSON-RPC `id`, so multiple in-flight requests never
 * cross-talk: each `sendRequest` resolves with exactly the response carrying its own id.
 */

import { ChildProcess, spawn } from 'child_process';

/** Options for {@link McpStdioClient.start}. */
export interface StartOptions {
  /** Working directory for the spawned child. */
  cwd?: string;
  /** Environment for the spawned child (defaults to the parent environment). */
  env?: NodeJS.ProcessEnv;
}

/** A pending request awaiting its correlated JSON-RPC response. */
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A minimal, dependency-free MCP client over a spawned server process.
 *
 * Lifecycle: {@link start} → {@link initialize} → {@link callTool} / {@link listTools} /
 * {@link sendRequest} → {@link stop}. Every spawned child MUST be stopped (the suites call
 * `stop()` in `afterAll`/`afterEach`) to avoid leaked handles.
 */
export class McpStdioClient {
  private process: ChildProcess | null = null;
  private buffer = '';
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readonly stdoutLines: string[] = [];
  private rawStdoutReceived = false;
  private exited = false;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  /**
   * Spawn the server process. Resolves shortly after spawn (a small settle delay), or
   * rejects if the child emits an `error` (e.g. command not found) before settling.
   *
   * @param command - executable to run (e.g. the tsx binary, or `node`).
   * @param args - process arguments (e.g. the harness script path + flags).
   * @param options - working directory and environment.
   */
  async start(command: string, args: string[], options: StartOptions = {}): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      this.process = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: options.cwd,
        env: options.env ?? process.env,
      });

      this.process.stdout!.on('data', (chunk: Buffer) => {
        this.rawStdoutReceived = true;
        this.buffer += chunk.toString('utf-8');
        this.drain();
      });

      // Drain stderr so the child's diagnostics never block on a full pipe.
      this.process.stderr!.on('data', () => {
        /* diagnostics — intentionally ignored */
      });

      this.process.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(new Error(`failed to spawn "${command}": ${err.message}`));
        }
      });

      this.process.on('exit', (code, signal) => {
        this.exited = true;
        this.exitInfo = { code, signal };
      });

      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, 250);
    });
  }

  /** Process the NDJSON buffer, resolving any request whose response id has arrived. */
  private drain(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.stdoutLines.push(trimmed);
      try {
        const msg = JSON.parse(trimmed) as { id?: number };
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const pending = this.pending.get(msg.id)!;
          clearTimeout(pending.timer);
          this.pending.delete(msg.id);
          pending.resolve(msg);
        }
      } catch {
        /* non-JSON line — not a protocol message */
      }
    }
  }

  /** Send a JSON-RPC request and resolve with the full response message (correlated by id). */
  sendRequest(method: string, params?: unknown, timeoutMs = 15_000): Promise<any> {
    if (!this.process?.stdin) {
      return Promise.reject(new Error('MCP server process not started'));
    }
    const id = this.nextId++;
    const request: Record<string, unknown> = { jsonrpc: '2.0', id, method };
    if (params !== undefined) request.params = params;

    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout waiting for response to ${method} (id=${id})`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });

    this.process.stdin.write(JSON.stringify(request) + '\n');
    return promise;
  }

  /** Send a JSON-RPC notification (no id, no response expected). */
  sendNotification(method: string, params?: unknown): void {
    if (!this.process?.stdin) throw new Error('MCP server process not started');
    const notification: Record<string, unknown> = { jsonrpc: '2.0', method };
    if (params !== undefined) notification.params = params;
    this.process.stdin.write(JSON.stringify(notification) + '\n');
  }

  /** Perform the MCP `initialize` handshake and the `initialized` notification. */
  async initialize(timeoutMs = 15_000): Promise<any> {
    const initResponse = await this.sendRequest(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'e2e-client', version: '1.0.0' },
      },
      timeoutMs,
    );
    this.sendNotification('notifications/initialized');
    await new Promise((r) => setTimeout(r, 50));
    return initResponse;
  }

  /** Call `tools/list` and return the array of tool definitions. */
  async listTools(timeoutMs = 15_000): Promise<Array<{ name: string;[k: string]: unknown }>> {
    const response = await this.sendRequest('tools/list', undefined, timeoutMs);
    return response.result.tools;
  }

  /** Call a tool by name and return its `result` (the MCP tool-call result envelope). */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs = 15_000,
  ): Promise<any> {
    const response = await this.sendRequest('tools/call', { name, arguments: args }, timeoutMs);
    return response.result;
  }

  /** Whether any raw stdout data has been received from the child. */
  hasReceivedStdout(): boolean {
    return this.rawStdoutReceived;
  }

  /** A snapshot of every non-empty stdout line received so far. */
  getStdoutLines(): string[] {
    return [...this.stdoutLines];
  }

  /** Whether the child has exited, and with what code/signal. */
  getExit(): { exited: boolean; code: number | null; signal: NodeJS.Signals | null } {
    return {
      exited: this.exited,
      code: this.exitInfo?.code ?? null,
      signal: this.exitInfo?.signal ?? null,
    };
  }

  /** Terminate the child process and reject any still-pending requests. Idempotent. */
  async stop(): Promise<void> {
    if (!this.process) return;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('MCP server stopped'));
    }
    this.pending.clear();

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
