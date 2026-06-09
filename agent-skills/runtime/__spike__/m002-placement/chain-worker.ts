/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SPIKE (throwaway) — Variant C: the bus-to-bus CHAIN worker (the collision test).
 *
 * This worker is hosted by an OUTER StdioBus A (it speaks NDJSON JSON-RPC on its OWN
 * stdin/stdout to busA's kernel). It ALSO constructs an INNER `StdioBus` B that spawns a
 * `provider-worker`, and forwards each `skills.read` to busB.request(...). Topology:
 *
 *   driver -> busA -> THIS chain-worker -> busB -> provider-worker -> (response back up)
 *
 * This is the honest reproduction of the user's "request → bus → bus → response" risk: a
 * process that must keep its own stdin/stdout PURE for the parent protocol while running a
 * nested bus that spawns its own child workers over child-process pipes. Collision failure
 * modes we are hunting: inner-bus diagnostics leaking onto THIS worker's protocol stdout,
 * inner bus consuming/blocking THIS worker's stdin, deadlock under nested synchronous
 * requests, or orphaned inner provider-workers after stop.
 *
 * STDOUT IS PROTOCOL-ONLY; diagnostics to stderr. NOT production.
 */

import * as path from 'path';
import * as readline from 'readline';
import { fileURLToPath } from 'url';
import StdioBus from '@stdiobus/node';

const here = path.dirname(fileURLToPath(import.meta.url));
const tsxBin = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
const providerWorkerPath = path.join(here, 'provider-worker.ts');

function diag(msg: string): void {
  process.stderr.write(`[chain-worker pid=${process.pid}] ${msg}\n`);
}

function writeResult(id: string | number, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function writeRpcError(id: string | number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\n');
}

// INNER bus B — spawns the provider-worker over CHILD pipes (not this worker's own stdio).
const innerBus = new StdioBus({
  config: { pools: [{ id: 'inner-provider', command: tsxBin, args: [providerWorkerPath, '--tag=inner'], instances: 1 }] },
  backend: 'native',
  logLevel: 2, // WARN — keep inner-bus chatter off; must NOT reach this worker's stdout
});

async function main(): Promise<void> {
  await innerBus.start();
  diag(`inner bus B started (workers=${innerBus.getWorkerCount()})`);

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: { id?: string | number; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      diag(`unparseable line: ${trimmed.slice(0, 80)}`);
      return;
    }
    if (msg.id === undefined || msg.method === undefined) return;

    const { id, method, params = {} } = msg as {
      id: string | number;
      method: string;
      params?: Record<string, unknown>;
    };
    diag(`forward id=${id} method=${method} -> inner bus`);

    // Forward to inner bus B. A nested synchronous request: this is exactly the chain that
    // could deadlock or collide if the bus implementation is not reentrant across processes.
    innerBus
      .request(method, params, { timeout: 10_000 })
      .then((result) => writeResult(id, result))
      .catch((e) => writeRpcError(id, `inner bus error: ${String(e)}`));
  });

  process.on('SIGTERM', () => {
    innerBus
      .stop(5)
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });

  diag('ready');
}

main().catch((e) => {
  diag(`fatal: ${e}`);
  process.exit(1);
});
