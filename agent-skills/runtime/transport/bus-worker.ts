/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real stdio Bus worker (promoted from the proven spike — Migration Step 5, Task 7.2).
 *
 * This process is spawned by the stdio Bus kernel (native C). It speaks NDJSON
 * JSON-RPC 2.0 over stdin/stdout and serves the SkillsRuntime core capabilities by
 * delegating to the in-process runtime + filesystem provider.
 *
 * Protocol (per @stdiobus/node worker contract):
 *   stdin  <- {"jsonrpc":"2.0","id":"..","method":"skills.read.v1","params":{...}}
 *   stdout -> {"jsonrpc":"2.0","id":"..","result":<SkillResponse>}
 *
 * stdout is the protocol channel — ALL diagnostics go to stderr.
 *
 * Ingress validation (Req 10.2, 10.3, 10.4, 10.5):
 *   {@link ParamCodec.decode} runs at ingress, BEFORE the dispatch table invokes the
 *   runtime, so NO provider ever receives unvalidated input. Decode is the single
 *   transport-boundary validation point:
 *     - non-object / malformed params  → `bad_request` (Req 10.5);
 *     - unknown capability `method`     → `unsupported` (Req 3.4; decode owns this);
 *     - schema-invalid input            → `bad_request` naming the field(s) (Req 10.4).
 *   On any decode failure the worker writes the typed error inside the JSON-RPC
 *   `result` as a returned `SkillResponse`, invokes NO provider, and leaves runtime
 *   state unchanged.
 *
 * Dispatch (extension seam):
 *   A dispatch table keyed by the capability `method` strings (from `SkillsCapabilities`
 *   and `AdmissionCapabilities`) replaces the former hand-written switch, so adding a
 *   capability does not require editing control flow here. The five proven core capabilities
 *   plus the `skills.add.v1` admission extension are wired (Task 9.2). `skills.add.v1`
 *   normalizes the decoded RAW descriptor and admits it through the in-process
 *   AdmissionController over the SAME provider view this worker's runtime reads from — NO new
 *   worker pool and NO additional `StdioBus` are created.
 */

import * as readline from 'readline';
import { composeSkillsRuntime } from '../compose.js';
import { AdmissionCapabilities, SkillsCapabilities } from '../capabilities.js';
import { ParamCodec } from './param-codec.js';
import type { RawProviderDescriptor } from '../admission/provider-descriptor.js';
import type {
  GetReferencesInput,
  ListSkillsInput,
  ReadReferenceInput,
  ReadSkillInput,
  SearchSkillsInput,
  SkillResponse,
} from '../contract.js';

// ─── Composition root — the ONE shared production factory (Task U1) ───────────────────
//
// This worker PROCESS is its own composition root: it calls `composeSkillsRuntime()` exactly
// once when the bus kernel spawns the worker and the module body runs, and owns the returned
// graph for the process's lifetime. The factory is the SAME one `mcp-server.ts` calls, so the
// two production entrypoints can never drift in provider set, native search ranking, trust,
// namespaces, or admission (the split-brain M-001 §5.5 forbids). The returned instances are
// NOT a singleton breach: none is `export`ed, no static accessor exposes them, and no other
// module imports this entrypoint, so no instance is reachable as shared global mutable state.
//
// `runtime` reads from the same provider view the admission `register` stage mutates and is
// wired with the in-process admission seam; `admissionHandler` is the single admission handler
// over that SAME controller. No new worker pool and no additional StdioBus are created.
const { runtime, admissionHandler, packageRoot } = composeSkillsRuntime();

function log(msg: string): void {
  process.stderr.write(`[bus-worker] ${msg}\n`);
}

/**
 * Dispatch table over the proven core capabilities PLUS the `skills.add.v1` extension
 * (Task 9.2). Keyed by the SAME wire `method` strings the bus carries (`skills.read.v1`,
 * `skills.add.v1`, ...), tying each entry to its capability descriptor rather than to a
 * literal switch arm. Each handler receives the input that {@link ParamCodec.decode} has
 * already validated; the `unknown`→typed cast is sound because decode parsed the value
 * against that capability's schema.
 *
 * The `skills.add.v1` entry follows the design data-flow exactly: the decoded RAW descriptor
 * is normalized and admitted via the {@link AdmissionCapabilityHandler} (normalize →
 * `controller.admit` → `toSkillResponse`). It adds NO new worker pool and NO additional
 * `StdioBus`; admission mutates the SAME in-process provider view this worker's runtime
 * reads from, so a subsequently-admitted provider is reachable over this very transport.
 */
const DISPATCH: Record<string, (input: unknown) => Promise<SkillResponse<unknown>>> = {
  [SkillsCapabilities.read.method]: (input) => runtime.read(input as ReadSkillInput),
  [SkillsCapabilities.list.method]: (input) => runtime.list(input as ListSkillsInput),
  [SkillsCapabilities.search.method]: (input) => runtime.search(input as SearchSkillsInput),
  [SkillsCapabilities.listReferences.method]: (input) =>
    runtime.getReferences(input as GetReferencesInput),
  [SkillsCapabilities.readReference.method]: (input) =>
    runtime.readReference(input as ReadReferenceInput),
  [AdmissionCapabilities.add.method]: (input) =>
    admissionHandler.handle(input as RawProviderDescriptor),
};

/** Write a JSON-RPC result envelope to the protocol channel (stdout). */
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
    // Typed error rides inside `result` as a returned SkillResponse; no provider invoked,
    // runtime state unchanged (Req 10.3, 10.4, 10.5). Unknown method already surfaced here
    // as `unsupported` by decode (Req 3.4).
    writeResult(id, { ok: false, error: decoded.error });
    return;
  }

  const handler = DISPATCH[method];
  if (!handler) {
    // Total safety net: decode already returns `unsupported` for any method without a
    // schema, so this is unreachable for the core set — kept so the worker is total.
    writeResult(id, { ok: false, error: { code: 'unsupported', capability: method } });
    return;
  }

  handler(decoded.input)
    .then((result) => {
      writeResult(id, result);
    })
    .catch((err) => {
      // The contract is returned-error (never thrown); this guards the transport itself.
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: String(err) },
        }) + '\n',
      );
    });
});

process.on('SIGTERM', () => process.exit(0));
log(`ready (packageRoot=${packageRoot})`);
