/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal NDJSON JSON-RPC client for a stdio Bus worker (e2e harness).
 *
 * The production stdio Bus worker speaks raw JSON-RPC 2.0 capability calls over stdin/stdout
 * (NOT the MCP `initialize` handshake), so this client is deliberately simpler than
 * {@link McpStdioClient}: it spawns the worker, writes one `{ jsonrpc, id, method, params }`
 * request per call, and resolves with the worker's `result` (a typed `SkillResponse`),
 * correlated strictly by JSON-RPC `id`. In the live E2E this client plays the role the native
 * stdio Bus kernel plays in production — it drives the worker line-by-line. Every spawned
 * worker MUST be {@link stop}ped to avoid leaked handles.
 */

import { ChildProcess, spawn } from 'child_process';

/** A pending capability call awaiting its correlated response. */
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A minimal, dependency-free JSON-RPC client over a spawned stdio Bus worker process. */
export class BusStdioClient {
  private process: ChildProcess | null = null;
  private buffer = '';
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  /**
   * Spawn the worker process. Resolves after a short settle delay, or rejects if the child
   * emits an `error` (e.g. command not found) before settling.
   */
  async start(command: string, args: string[], cwd?: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      this.process = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
        env: process.env,
      });

      this.process.stdout!.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString('utf-8');
        this.drain();
      });
      this.process.stderr!.on('data', () => {
        /* diagnostics — intentionally ignored */
      });
      this.process.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(new Error(`failed to spawn "${command}": ${err.message}`));
        }
      });

      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, 250);
    });
  }

  /** Process the NDJSON buffer, resolving any call whose response id has arrived. */
  private drain(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as { id?: number; result?: unknown; error?: unknown };
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const pending = this.pending.get(msg.id)!;
          clearTimeout(pending.timer);
          this.pending.delete(msg.id);
          // The worker wraps a typed SkillResponse in `result`; a transport-level JSON-RPC
          // `error` (the worker's last-resort catch) is surfaced as a rejection.
          if (msg.error !== undefined && msg.result === undefined) {
            pending.reject(new Error(`worker transport error: ${JSON.stringify(msg.error)}`));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch {
        /* non-JSON line — not a protocol message */
      }
    }
  }

  /**
   * Send a capability `method` with `params` and resolve with the worker's typed
   * `SkillResponse` (the JSON-RPC `result`), correlated by id.
   */
  request<T = unknown>(method: string, params: unknown, timeoutMs = 40_000): Promise<T> {
    if (!this.process?.stdin) {
      return Promise.reject(new Error('bus worker process not started'));
    }
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout waiting for response to ${method} (id=${id})`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return promise as Promise<T>;
  }

  /** Terminate the worker and reject any still-pending calls. Idempotent. */
  async stop(): Promise<void> {
    if (!this.process) return;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('bus worker stopped'));
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
