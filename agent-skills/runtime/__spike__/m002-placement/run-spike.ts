/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SPIKE (throwaway) — M-002 provider-placement driver.
 *
 * Executes the placement variants for the SECOND (external) provider and prints a findings
 * summary. Anti-false-pass battery on every bus variant (companion's rule): ≥2 concurrent
 * requests, a 32 KB payload, a forced timeout, a post-timeout success, routingErrors===0, and a
 * clean stop. NOT production; promote findings, not code.
 *
 *   A) in-process real HTTPS
 *   B) worker-hosted provider over one bus (deterministic battery + one real HTTPS)
 *   C) nested bus-to-bus chain (the collision test; deterministic battery + one real HTTPS)
 *   D) sibling worker pools on one bus (federation-over-bus without nesting)
 *
 * Run: yarn tsx agent-skills/runtime/__spike__/m002-placement/run-spike.ts
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import StdioBus from '@stdiobus/node';
import { httpsFetch } from './https-fetch.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tsxBin = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
const providerWorker = path.join(here, 'provider-worker.ts');
const chainWorker = path.join(here, 'chain-worker.ts');

/** A stable, public HTTPS skill-content source (Apache-2.0 LICENSE of a real public repo). */
const REAL_URL = 'https://raw.githubusercontent.com/stdiobus/workers-registry/main/LICENSE';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ''));
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

type Resp = { ok?: boolean; data?: { body?: string } } | undefined;

/** The anti-false-pass battery against a started bus, for a given wire method. */
async function battery(name: string, bus: StdioBus, method: string): Promise<void> {
  console.log(`\n── ${name}: battery (method=${method}) ──`);

  // 1) concurrency — two simultaneous reads must not cross-wire.
  try {
    const [a, b] = (await Promise.all([
      bus.request<Resp>(method, { skill: 'alpha' }, { timeout: 8000 }),
      bus.request<Resp>(method, { skill: 'beta' }, { timeout: 8000 }),
    ]));
    const aOk = a?.ok === true && a.data?.body?.includes('alpha') === true && !a.data?.body?.includes('beta');
    const bOk = b?.ok === true && b.data?.body?.includes('beta') === true && !b.data?.body?.includes('alpha');
    check(`${name}: 2 concurrent reads resolve, not cross-wired`, Boolean(aOk && bOk));
  } catch (e) {
    check(`${name}: 2 concurrent reads resolve, not cross-wired`, false, String(e));
  }

  // 2) nontrivial payload — 32 KB body round-trips intact (framing/backpressure).
  try {
    const r = await bus.request<Resp>(method, { skill: 'big', sizeBytes: 32768 }, { timeout: 8000 });
    check(`${name}: 32 KB payload round-trips intact`, r?.ok === true && r.data?.body?.length === 32768, `len=${r?.data?.body?.length}`);
  } catch (e) {
    check(`${name}: 32 KB payload round-trips intact`, false, String(e));
  }

  // 3) forced timeout — slow provider must time out predictably (not hang forever).
  let timedOut = false;
  try {
    await bus.request<Resp>(method, { skill: 'slow', delayMs: 3000 }, { timeout: 600 });
    check(`${name}: slow request times out predictably`, false, 'expected timeout, got response');
  } catch {
    timedOut = true;
    check(`${name}: slow request times out predictably`, true);
  }

  // 4) post-timeout health — a later normal request still succeeds (no poisoning).
  try {
    const r = await bus.request<Resp>(method, { skill: 'after' }, { timeout: 8000 });
    check(`${name}: normal request succeeds AFTER a timeout`, r?.ok === true && r.data?.body?.includes('after') === true, timedOut ? '' : '(no prior timeout)');
  } catch (e) {
    check(`${name}: normal request succeeds AFTER a timeout`, false, String(e));
  }

  // 5) real HTTPS once — acquisition over a real public origin through this placement.
  try {
    const r = await bus.request<Resp>(method, { skill: 'license', url: REAL_URL }, { timeout: 12000 });
    const body = r?.data?.body ?? '';
    check(`${name}: real HTTPS fetch through placement`, r?.ok === true && /Apache License/i.test(body), `bytes=${body.length}`);
  } catch (e) {
    check(`${name}: real HTTPS fetch through placement`, false, String(e));
  }

  // 6) routing integrity.
  const stats = bus.getStats();
  check(`${name}: routingErrors === 0`, stats.routingErrors === 0, `in=${stats.messagesIn} out=${stats.messagesOut} bytesOut=${stats.bytesOut} routingErrors=${stats.routingErrors}`);
}

async function variantA(): Promise<void> {
  console.log('\n══ Variant A — in-process real HTTPS ══');
  const r = await httpsFetch(REAL_URL, { timeoutMs: 12000, maxBytes: 1_000_000 });
  check('A: in-process real HTTPS fetch', r.ok && /Apache License/i.test(r.body ?? ''), `status=${r.status} bytes=${r.bytes}`);
}

async function variantB(): Promise<void> {
  console.log('\n══ Variant B — worker-hosted provider over one bus ══');
  const bus = new StdioBus({
    config: { pools: [{ id: 'b-provider', command: tsxBin, args: [providerWorker, '--tag=B'], instances: 1 }] },
    backend: 'native',
    logLevel: 2,
  });
  await bus.start();
  check('B: bus started, worker present', bus.isRunning() && bus.getWorkerCount() >= 1, `workers=${bus.getWorkerCount()}`);
  await battery('B', bus, 'skills.read');
  await bus.stop(5);
  check('B: clean stop (resolved)', !bus.isRunning());
}

async function variantC(): Promise<void> {
  console.log('\n══ Variant C — nested bus-to-bus chain (collision test) ══');
  const bus = new StdioBus({
    config: { pools: [{ id: 'c-chain', command: tsxBin, args: [chainWorker], instances: 1 }] },
    backend: 'native',
    logLevel: 2,
  });
  await bus.start();
  check('C: outer bus started, chain-worker present', bus.isRunning() && bus.getWorkerCount() >= 1, `workers=${bus.getWorkerCount()}`);
  // Give the chain-worker a moment to start its inner bus B.
  await new Promise((r) => setTimeout(r, 1500));
  await battery('C', bus, 'skills.read');
  await bus.stop(8);
  check('C: clean stop (resolved)', !bus.isRunning());
}

async function variantD(): Promise<void> {
  console.log('\n══ Variant D — sibling worker pools on one bus ══');
  const bus = new StdioBus({
    config: {
      pools: [
        { id: 'd-alpha', command: tsxBin, args: [providerWorker, '--tag=Dalpha', '--method=alpha.read'], instances: 1 },
        { id: 'd-beta', command: tsxBin, args: [providerWorker, '--tag=Dbeta', '--method=beta.read'], instances: 1 },
      ],
    },
    backend: 'native',
    logLevel: 2,
  });
  await bus.start();
  check('D: bus started, two workers present', bus.isRunning() && bus.getWorkerCount() >= 2, `workers=${bus.getWorkerCount()}`);
  try {
    const [a, b] = await Promise.all([
      bus.request<Resp>('alpha.read', { skill: 'alpha' }, { timeout: 8000 }),
      bus.request<Resp>('beta.read', { skill: 'beta' }, { timeout: 8000 }),
    ]);
    check('D: two sibling pools answer their own methods', a?.ok === true && b?.ok === true && a.data?.body?.includes('Dalpha') === true && b.data?.body?.includes('Dbeta') === true);
  } catch (e) {
    check('D: two sibling pools answer their own methods', false, String(e));
  }
  const stats = bus.getStats();
  check('D: routingErrors === 0', stats.routingErrors === 0, `routingErrors=${stats.routingErrors}`);
  await bus.stop(5);
  check('D: clean stop (resolved)', !bus.isRunning());
}

async function main(): Promise<void> {
  const variant = (process.argv.find((a) => a.startsWith('--variant='))?.slice('--variant='.length) ?? 'A').toUpperCase();
  console.log(`\nM-002 placement spike — variant=${variant} pid=${process.pid}\n(real HTTPS target: ${REAL_URL})`);
  // NOTE (finding): @stdiobus/node StdioBus is a per-process singleton ("Bus already created" on a
  // second construction, even after stop()). So each variant runs in its OWN process.
  const map: Record<string, () => Promise<void>> = { A: variantA, B: variantB, C: variantC, D: variantD };
  const fn = map[variant];
  if (!fn) {
    console.error(`unknown variant ${variant} (expected A|B|C|D)`);
    process.exit(2);
  }
  try {
    await fn();
  } catch (e) {
    check(`Variant ${variant}: did not crash the driver`, false, String(e));
  }
  console.log(`\n${'─'.repeat(56)}\n  variant ${variant}:  ✓ ${passed} passed   ✗ ${failed} failed`);
  if (failed > 0) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`    • ${f}`);
  }
  console.log('');
}

main().catch((e) => {
  console.error(`\nFATAL driver error: ${e}\n`);
  process.exit(1);
});
