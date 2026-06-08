/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SPIKE — REAL stdio Bus end-to-end.
 *
 * Boots a real `StdioBus` (native C kernel), spawns a real worker process
 * (`bus-worker.ts`) that serves the SkillsRuntime, and performs real `bus.request`
 * round-trips. Nothing here is mocked: client -> bus kernel -> worker stdin ->
 * read SKILL.md from disk -> worker stdout -> bus kernel -> client.
 *
 * Run: `yarn tsx agent-skills/runtime/__spike__/bus-read-spike.ts`
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import StdioBus, { BusState } from '@stdiobus/node';
import type { SkillContent, SkillDescriptor, SkillResponse } from '../contract.js';
import { SkillsCapabilities } from '../capabilities.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..', '..', '..');
const tsxBin = path.join(packageRoot, 'node_modules', '.bin', 'tsx');
// The worker was promoted out of __spike__ into the production transport/ folder
// (Task 7.2); resolve it at its new location so this spike still spawns it.
const workerPath = path.join(here, '..', 'transport', 'bus-worker.ts');

function line(s = ''): void {
  process.stdout.write(s + '\n');
}

async function main(): Promise<void> {
  const bus = new StdioBus({
    config: {
      pools: [{ id: 'skills', command: tsxBin, args: [workerPath], instances: 1 }],
    },
    backend: 'native',
    logLevel: 2, // WARN — keep kernel chatter low
  });

  line(`state before start: ${bus.getState()} (CREATED=${BusState.CREATED})`);
  line(`backend: ${bus.getBackendType()}`);

  await bus.start();
  line(`state after start:  ${bus.getState()} (RUNNING=${BusState.RUNNING})`);
  line(`workers running:     ${bus.getWorkerCount()}`);
  line('');

  // 1) REAL read round-trip over the bus.
  const read = await bus.request<SkillResponse<SkillContent>>(
    SkillsCapabilities.read.method,
    { ref: { kind: 'name', name: 'runtime-concepts' } },
    { timeout: 30_000 },
  );
  line('--- skills.read.v1 (over the bus) ---');
  if (read.ok) {
    line(`ok: ${read.data.body.length} bytes`);
    line(`provenance: ${JSON.stringify(read.provenance)}`);
    line(`body head: ${JSON.stringify(read.data.body.slice(0, 60))}`);
  } else {
    line(`error: ${JSON.stringify(read.error)}`);
  }
  line('');

  // 2) REAL list round-trip.
  const list = await bus.request<SkillResponse<SkillDescriptor[]>>(
    SkillsCapabilities.list.method,
    {},
    { timeout: 30_000 },
  );
  line('--- skills.list.v1 (over the bus) ---');
  line(list.ok ? `ok: ${list.data.length} skills, e.g. ${list.data.slice(0, 3).map((d) => d.fqid).join(', ')}` : `error: ${JSON.stringify(list.error)}`);
  line('');

  // 3) REAL open-world miss over the bus (typed not_found, not a thrown error).
  const miss = await bus.request<SkillResponse<SkillContent>>(
    SkillsCapabilities.read.method,
    { ref: { kind: 'name', name: 'no-such-skill-xyz' } },
    { timeout: 30_000 },
  );
  line('--- skills.read.v1 unknown (over the bus) ---');
  line(!miss.ok ? `typed error over the wire: ${JSON.stringify(miss.error)}` : 'unexpectedly ok');
  line('');

  const stats = bus.getStats();
  line('--- bus stats (real traffic) ---');
  line(`messagesIn=${stats.messagesIn} messagesOut=${stats.messagesOut} bytesIn=${stats.bytesIn} bytesOut=${stats.bytesOut} routingErrors=${stats.routingErrors}`);

  await bus.stop();
  line(`\nstate after stop:    ${bus.getState()} (STOPPED=${BusState.STOPPED})`);
  bus.destroy();

  const held = read.ok && read.data.body.length > 0 && list.ok && !miss.ok && stats.messagesOut > 0;
  line(`\n${held ? 'REAL BUS ROUND-TRIP HELD' : 'BUS ROUND-TRIP FAILED'}`);
  process.exit(held ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`bus spike crashed: ${err?.stack ?? err}\n`);
  process.exit(2);
});
