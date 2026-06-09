/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Installed-package stdio Bus worker (live-E2E harness, Task 11.2).
 *
 * Copied into the clean consumer and run with `node` (cwd = consumer). It imports ONLY from the
 * INSTALLED package (`@stdiobus/skills/runtime`) and MIRRORS the production
 * `runtime/transport/bus-worker.ts` EXACTLY — NDJSON JSON-RPC 2.0 over stdin/stdout,
 * {@link ParamCodec.decode} as the single transport-boundary validation point, and a dispatch
 * table keyed by the capability `method` wire strings (the five core capabilities PLUS the
 * `skills.add.v1` admission extension). It does NOT invent a parallel protocol.
 *
 * The live-E2E test plays the role the native stdio Bus kernel plays in production: it spawns
 * this worker and drives it line-by-line over stdin/stdout. No additional StdioBus and no extra
 * worker pool are created; an admitted provider is materialized IN-PROCESS in this worker's own
 * runtime via the SAME MutableProviderView the AdmissionController's `register` stage mutates.
 *
 * STDOUT is the protocol channel; ALL diagnostics go to STDERR.
 */

import * as readline from 'readline';
import {
  AdmissionCapabilities,
  AdmissionCapabilityHandler,
  AdmissionController,
  FilesystemSkillProvider,
  HttpSkillProviderBlueprint,
  InProcessSkillsRuntime,
  MutableProviderView,
  NamespaceOwnershipTable,
  OperationBudget,
  ParamCodec,
  ProviderBlueprintRegistry,
  Sha256ContentHasher,
  SkillsCapabilities,
} from '@stdiobus/skills/runtime';

const ADMISSION_BUDGET_MS = 30_000;

function readArg(flag) {
  const prefix = `--${flag}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function log(msg) {
  process.stderr.write(`[bus-admit-worker] ${msg}\n`);
}

const packageRoot = readArg('packageRoot');
if (!packageRoot) {
  log('fatal: missing required --packageRoot=<path> argument');
  process.exit(2);
}

// --- Admission wiring — NO new worker, NO additional StdioBus (mirrors production) ---
const bundled = new FilesystemSkillProvider({ search: true, packageRoot });
const view = new MutableProviderView([bundled]);
const namespaces = new NamespaceOwnershipTable();
// Mirror production: share the SAME namespace-ownership table with the runtime (3rd ctor arg)
// so the per-operation anti-spoofing boundary (Req 5.4, 5.5) is live in this harness too.
const runtime = new InProcessSkillsRuntime(view, undefined, namespaces);

const blueprints = new ProviderBlueprintRegistry();
blueprints.register(new HttpSkillProviderBlueprint());
const controller = new AdmissionController(
  blueprints,
  view,
  namespaces,
  new OperationBudget(ADMISSION_BUDGET_MS),
  new Sha256ContentHasher(),
);
const admissionHandler = new AdmissionCapabilityHandler(controller);

/** Dispatch table over the five core capabilities + the skills.add.v1 admission extension. */
const DISPATCH = {
  [SkillsCapabilities.read.method]: (input) => runtime.read(input),
  [SkillsCapabilities.list.method]: (input) => runtime.list(input),
  [SkillsCapabilities.search.method]: (input) => runtime.search(input),
  [SkillsCapabilities.listReferences.method]: (input) => runtime.getReferences(input),
  [SkillsCapabilities.readReference.method]: (input) => runtime.readReference(input),
  [AdmissionCapabilities.add.method]: (input) => admissionHandler.handle(input),
};

function writeResult(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    log(`unparseable line: ${trimmed.slice(0, 80)}`);
    return;
  }

  if (msg.id === undefined || msg.method === undefined) return; // notification — ignore

  const { id, method, params } = msg;
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
log(`ready (packageRoot=${packageRoot})`);
