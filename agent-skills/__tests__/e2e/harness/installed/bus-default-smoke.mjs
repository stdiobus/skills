/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Installed-package "default bus" smoke driver (live-E2E harness, Task B6.3 / B6.2).
 *
 * UNLIKE the retired hand-copied worker harness, this driver does NOT re-implement the worker
 * dispatch loop. It is a CONSUMER COMPOSITION driver: it composes a bus-backed runtime through
 * the package's OWN PUBLIC API (`@stdiobus/skills/runtime` → `createRuntimeFromRegistry({ kind:
 * 'stdio-bus', ... })`), which selects `BusSkillsRuntime` and lazily brings up the package's own
 * `createDefaultBus` on first dispatch — spawning the SHIPPED `out/dist/bus-worker.mjs` with
 * `process.execPath`, resolved relative to the installed runtime bundle (Task B6.2). NOTHING is
 * hand-spawned, NOTHING is mocked: this is exactly how a clean consumer selects the bus
 * transport from the installed package.
 *
 * It performs ONE bundled `skills.read.v1` and writes the typed `SkillResponse` as a single JSON
 * line to stdout (the protocol channel for the driving test); all diagnostics go to stderr. A
 * native-kernel/transport startup failure is RETURNED (never thrown) by `BusSkillsRuntime` as a
 * `provider_error` carrying the `bus:<pool>` origin marker — the driving test treats THAT marker
 * (and only that) as "native bus unavailable in this environment" and skips honestly; any other
 * shape (wrong body, wrong fqid) is a real regression the test MUST fail on.
 */

import { createRuntimeFromRegistry, SkillProviderRegistry } from '@stdiobus/skills/runtime';

const POOL = 'skills';
const BUNDLED_SKILL = 'runtime-concepts';

function log(msg) {
  process.stderr.write(`[bus-default-smoke] ${msg}\n`);
}

async function main() {
  // For the stdio-bus transport the client-side provider list is unused (skill resolution
  // happens in the worker), so an EMPTY registry is correct here — the worker hosts the
  // in-process runtime over the bundled provider it resolves itself.
  const registry = new SkillProviderRegistry([]);
  const runtime = createRuntimeFromRegistry({ kind: 'stdio-bus', pool: POOL }, registry);

  let resp;
  try {
    // First dispatch triggers the lazy bring-up of the package's own default bus.
    resp = await runtime.read({ ref: { kind: 'name', name: BUNDLED_SKILL } });
  } finally {
    // The default bus is owned by BusSkillsRuntime; stop it so no worker handle leaks.
    if (typeof runtime.stop === 'function') {
      try {
        await runtime.stop();
      } catch (e) {
        log(`stop() failed: ${String(e)}`);
      }
    }
  }

  // One marked JSON line = the typed SkillResponse. The marker isolates our payload from any
  // native-kernel stdout chatter; flushing via the write callback BEFORE process.exit avoids
  // truncating this (large) line — `process.exit` does not wait for buffered stdout to drain.
  await new Promise((res) => {
    process.stdout.write(`SMOKE_RESULT ${JSON.stringify(resp)}\n`, () => res(undefined));
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log(`fatal: ${String(err?.stack ?? err)}`);
    process.exit(1);
  });
