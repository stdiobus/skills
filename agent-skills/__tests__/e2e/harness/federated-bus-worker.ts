/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Federated stdio Bus worker (e2e harness — run by the native bus kernel via `tsx`).
 *
 * Mirrors the production `runtime/transport/bus-worker.ts` exactly — NDJSON JSON-RPC 2.0
 * over stdin/stdout, {@link ParamCodec.decode} ingress validation as the single
 * transport-boundary check, and a dispatch table keyed by the capability `method` wire
 * strings — but hosts the FEDERATED registry (bundled + developer-sandbox provider) over
 * the real in-process runtime instead of the bundled provider alone. This proves a
 * federated sandbox skill resolves over a REAL serialized bus boundary (typed
 * `SkillResponse`), and an unknown name returns a typed `not_found`.
 *
 * The sandbox package root is supplied via a `--sandbox=<path>` argv argument (the bus pool
 * config appends it to the worker args). STDOUT is the protocol channel — ALL diagnostics
 * go to STDERR.
 */

import * as path from 'path';
import * as readline from 'readline';
import { fileURLToPath } from 'url';
import { createRuntimeFromRegistry, SkillProviderRegistry } from '../../../runtime/registry.js';
import { FilesystemSkillProvider } from '../../../runtime/providers/filesystem-provider.js';
import { bundledTrustPolicy } from '../../../runtime/trust.js';
import { SkillsCapabilities } from '../../../runtime/capabilities.js';
import { ParamCodec } from '../../../runtime/transport/param-codec.js';
import type {
  GetReferencesInput,
  ListSkillsInput,
  ReadReferenceInput,
  ReadSkillInput,
  SearchSkillsInput,
  SkillResponse,
  SkillsRuntime,
} from '../../../runtime/contract.js';

function readArg(flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function log(msg: string): void {
  process.stderr.write(`[federated-bus-worker] ${msg}\n`);
}

// packageRoot is four levels up: harness -> e2e -> __tests__ -> agent-skills -> packageRoot.
const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..', '..', '..', '..');
const sandboxRoot = readArg('sandbox');

if (!sandboxRoot) {
  log('fatal: missing required --sandbox=<path> argument');
  process.exit(2);
}

// Federated registry [bundled, sandbox] over the real in-process runtime. The sandbox
// provider uses the list+substring search fallback (resilient to the broken-skill edge),
// exactly like the federated MCP harness.
const registry = new SkillProviderRegistry([
  {
    provider: new FilesystemSkillProvider({ search: true, packageRoot }),
    trust: bundledTrustPolicy(packageRoot),
  },
  {
    provider: new FilesystemSkillProvider({ id: 'sandbox', packageRoot: sandboxRoot, search: false }),
    trust: bundledTrustPolicy(sandboxRoot),
  },
]);
const runtime: SkillsRuntime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

/** Dispatch table over the proven core capabilities, keyed by wire `method` strings. */
const DISPATCH: Record<string, (input: unknown) => Promise<SkillResponse<unknown>>> = {
  [SkillsCapabilities.read.method]: (input) => runtime.read(input as ReadSkillInput),
  [SkillsCapabilities.list.method]: (input) => runtime.list(input as ListSkillsInput),
  [SkillsCapabilities.search.method]: (input) => runtime.search(input as SearchSkillsInput),
  [SkillsCapabilities.listReferences.method]: (input) =>
    runtime.getReferences(input as GetReferencesInput),
  [SkillsCapabilities.readReference.method]: (input) =>
    runtime.readReference(input as ReadReferenceInput),
};

function writeResult(id: string | number, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: { id?: string | number; method?: string; params?: unknown };
  try {
    msg = JSON.parse(trimmed);
  } catch {
    log(`unparseable line: ${trimmed.slice(0, 80)}`);
    return;
  }

  if (msg.id === undefined || msg.method === undefined) return; // notification — ignore

  const { id, method, params } = msg as { id: string | number; method: string; params?: unknown };
  log(`request id=${id} method=${method}`);

  // Single validation point at ingress — runs BEFORE any provider is invoked.
  const decoded = ParamCodec.decode(method, params);
  if (!decoded.ok) {
    writeResult(id, { ok: false, error: decoded.error });
    return;
  }

  const handler = DISPATCH[method];
  if (!handler) {
    writeResult(id, { ok: false, error: { code: 'unsupported', capability: method } });
    return;
  }

  handler(decoded.input)
    .then((result) => writeResult(id, result))
    .catch((err) => {
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: String(err) } }) + '\n',
      );
    });
});

process.on('SIGTERM', () => process.exit(0));
log(`ready (packageRoot=${packageRoot}, sandbox=${sandboxRoot})`);
