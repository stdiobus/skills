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

import * as path from 'path';
import * as readline from 'readline';
import { fileURLToPath } from 'url';
import { InProcessSkillsRuntime } from '../in-process-runtime.js';
import { FilesystemSkillProvider } from '../providers/filesystem-provider.js';
import { HttpSkillProviderBlueprint } from '../providers/http-skill-provider.js';
import { AdmissionCapabilities, SkillsCapabilities } from '../capabilities.js';
import { MutableProviderView } from '../registry.js';
import { AdmissionController } from '../admission/admission-controller.js';
import { AdmissionCapabilityHandler } from '../admission/admission-capabilities.js';
import { ProviderBlueprintRegistry } from '../admission/blueprint-registry.js';
import { NamespaceOwnershipTable } from '../admission/namespace-ownership.js';
import { OperationBudget } from '../admission/operation-budget.js';
import { Sha256ContentHasher } from '../admission/content-hasher.js';
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

// transport/ sits at the same depth as __spike__/ under runtime/, so the package root
// is still three levels up (transport -> runtime -> agent-skills -> packageRoot).
const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..', '..', '..');

/**
 * Default per-operation admission budget, in milliseconds (Task 9.2).
 *
 * Bounds the WHOLE admission pipeline (`discover → … → register`) under one linked signal,
 * so a slow/unavailable external origin cannot hang the worker (Req 12.1). Interim/policy
 * value, not frozen; the HTTPS provider also arms its own finite per-fetch timeout.
 */
const ADMISSION_BUDGET_MS = 30_000;

// ─── Admission wiring — NO new worker, NO additional StdioBus (Task 9.2) ──────────────
//
// The admitted provider is materialized IN-PROCESS in this same worker's runtime. The
// filesystem provider seeds a MutableProviderView; the runtime reads from THAT view, and the
// AdmissionController's `register` stage admits (copy-on-write) into the SAME view — so an
// admitted provider becomes visible to the next runtime operation with nothing new spawned.
//
// Baseline preservation (Req 15.1, 15.2): seeding a MutableProviderView with the single
// filesystem provider yields the identical `providers()` snapshot a ConstantProviderView
// would (same reference identity, same order), so the proven single-bundled-provider path is
// byte-for-byte unchanged; the runtime already accepts any ProviderView.
const fsProvider = new FilesystemSkillProvider({ packageRoot });
const providerView = new MutableProviderView([fsProvider]);
const namespaces = new NamespaceOwnershipTable();
const runtime = new InProcessSkillsRuntime(providerView);

// The single admission authority over the SAME view (no new pool/bus). The HTTPS blueprint is
// the one external factory M-002 ships; the no-credential adapter is the default (public
// origins). The runtime above and this controller share `providerView` and `namespaces`.
const blueprints = new ProviderBlueprintRegistry();
blueprints.register(new HttpSkillProviderBlueprint());
const admissionController = new AdmissionController(
  blueprints,
  providerView,
  namespaces,
  new OperationBudget(ADMISSION_BUDGET_MS),
  new Sha256ContentHasher(),
);
const admissionHandler = new AdmissionCapabilityHandler(admissionController);

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
 * `StdioBus`; admission mutates the SAME in-process `providerView` this worker's runtime
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
