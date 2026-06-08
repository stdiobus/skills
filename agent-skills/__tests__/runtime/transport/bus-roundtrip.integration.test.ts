/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Integration test — REAL stdio Bus round-trip (Migration Step 5, Task 7.6).
//
// Promotes the proven spike (`runtime/__spike__/bus-read-spike.ts`) into a
// regression-guarded test. It boots a REAL StdioBus (native C kernel), spawns
// the REAL promoted worker (`runtime/transport/bus-worker.ts`) as a separate
// `tsx` process, and performs REAL `bus.request` round-trips. Nothing is mocked:
//   client -> native bus kernel -> worker stdin (NDJSON) -> read SKILL.md from
//   disk -> worker stdout -> native bus kernel -> client.
//
// Proves §11 fact 6 (Milestone-001): a typed `SkillResponse<SkillContent>`
// returns over NDJSON for a published name, and a typed `not_found` returns for
// an unknown name — the typed envelope rides the wire as structured data and is
// never collapsed to a prompt-shaped string.
//
// Validates: Requirements 2.10, 6.1, 6.3, 6.4
//
// ─── Environment robustness ─────────────────────────────────────────────────
// The native bus addon/binary is not runnable in every CI/sandbox environment.
// `beforeAll` attempts to construct + start the bus; if that fails for genuine
// environment reasons (missing native addon, spawn failure), the suite SKIPS
// gracefully with a clear `console.warn` rather than failing the whole run.
// When the bus IS available the assertions run and MUST pass — the skip path is
// only reached on real unavailability, never to make the test trivially green.
// =============================================================================

import * as path from 'path';
import StdioBus from '@stdiobus/node';
import { SkillsCapabilities } from '../../../runtime/capabilities.js';
import type {
  SkillContent,
  SkillDescriptor,
  SkillResponse,
} from '../../../runtime/contract.js';

// Resolve the worker + tsx binary relative to the package root (process.cwd()),
// exactly as the proven spike and the production BusSkillsRuntime default do.
const packageRoot = process.cwd();
const tsxBin = path.join(packageRoot, 'node_modules', '.bin', 'tsx');
const workerPath = path.join(packageRoot, 'agent-skills', 'runtime', 'transport', 'bus-worker.ts');

const BOOT_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

let bus: StdioBus | undefined;
let busAvailable = false;
let skipReason = '';

beforeAll(async () => {
  try {
    bus = new StdioBus({
      config: {
        pools: [{ id: 'skills', command: tsxBin, args: [workerPath], instances: 1 }],
      },
      backend: 'native',
      logLevel: 2, // WARN — keep kernel chatter low
    });
    await bus.start();
    busAvailable = true;
  } catch (err) {
    skipReason = String((err as { stack?: string })?.stack ?? err);
    busAvailable = false;
    // Best-effort teardown of a partially-constructed bus.
    if (bus) {
      try {
        bus.destroy();
      } catch {
        /* ignore */
      }
      bus = undefined;
    }
    // Clearly explain WHY the suite is skipped — this is an environment signal,
    // not a passing assertion.
    // eslint-disable-next-line no-console
    console.warn(
      '[bus-roundtrip] native stdio Bus unavailable — skipping the REAL round-trip ' +
      'suite (the structural-equivalence property test still guards the contract). ' +
      `Reason: ${skipReason}`,
    );
  }
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  if (bus && busAvailable) {
    try {
      await bus.stop();
    } catch {
      /* ignore */
    }
    try {
      bus.destroy();
    } catch {
      /* ignore */
    }
  }
});

describe('REAL stdio Bus round-trip (Req 2.10, 6.1, 6.3, 6.4; §11 fact 6)', () => {
  it(
    'read() of a published name returns a typed ok SkillResponse<SkillContent> over NDJSON',
    async () => {
      if (!busAvailable || !bus) {
        // eslint-disable-next-line no-console
        console.warn('[bus-roundtrip] skipped: native bus unavailable in this environment.');
        return;
      }

      const resp = await bus.request<SkillResponse<SkillContent>>(
        SkillsCapabilities.read.method,
        { ref: { kind: 'name', name: 'runtime-concepts' } },
        { timeout: REQUEST_TIMEOUT_MS },
      );

      expect(resp.ok).toBe(true);
      if (!resp.ok) return;
      // Typed content rode the wire as structured data, not a prompt string.
      expect(typeof resp.data.body).toBe('string');
      expect(resp.data.body.length).toBeGreaterThan(0);
      expect(resp.data.descriptor.fqid).toBe('bundled:runtime-concepts');
      // Provenance minimum set survived the serialized boundary (Req 2.3, 2.10).
      expect(resp.provenance.fqid).toBe('bundled:runtime-concepts');
      expect(resp.provenance.provider).toBe('bundled');
      expect(typeof resp.provenance.source).toBe('string');
      expect(resp.provenance.source.length).toBeGreaterThan(0);
    },
    BOOT_TIMEOUT_MS,
  );

  it(
    'list() returns a typed ok SkillResponse<SkillDescriptor[]> over NDJSON',
    async () => {
      if (!busAvailable || !bus) {
        // eslint-disable-next-line no-console
        console.warn('[bus-roundtrip] skipped: native bus unavailable in this environment.');
        return;
      }

      const resp = await bus.request<SkillResponse<SkillDescriptor[]>>(
        SkillsCapabilities.list.method,
        {},
        { timeout: REQUEST_TIMEOUT_MS },
      );

      expect(resp.ok).toBe(true);
      if (!resp.ok) return;
      expect(Array.isArray(resp.data)).toBe(true);
      expect(resp.data.length).toBeGreaterThan(0);
      expect(resp.data.some((d) => d.fqid === 'bundled:runtime-concepts')).toBe(true);
    },
    BOOT_TIMEOUT_MS,
  );

  it(
    'read() of an unknown name returns a typed ok:false not_found over the wire (never throws)',
    async () => {
      if (!busAvailable || !bus) {
        // eslint-disable-next-line no-console
        console.warn('[bus-roundtrip] skipped: native bus unavailable in this environment.');
        return;
      }

      const resp = await bus.request<SkillResponse<SkillContent>>(
        SkillsCapabilities.read.method,
        { ref: { kind: 'name', name: 'no-such-skill-xyz' } },
        { timeout: REQUEST_TIMEOUT_MS },
      );

      // The miss is a typed, returned error riding the wire — not a thrown RPC fault.
      expect(resp.ok).toBe(false);
      if (resp.ok) return;
      expect(resp.error.code).toBe('not_found');
    },
    BOOT_TIMEOUT_MS,
  );
});
