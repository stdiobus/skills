/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// BusSkillsRuntime unit tests (Migration Step 5, Task 7.3; design §3a/§3b).
//
// Subject: the CLIENT side of the bus transport. The REAL end-to-end round-trip
// is proven by the native integration test (`bus-roundtrip.integration.test.ts`,
// skipped where the native bus is unavailable) and the structural-equivalence
// property test. This suite pins the DETERMINISTIC client-side branches that do
// not need a native kernel, using an INJECTED (caller-owned) stub bus:
//
//   - returned-error totality at the transport boundary (Req 6.7): a transport
//     failure maps to a typed `provider_error` carrying the `bus:<pool>` origin,
//     RETURNED never thrown, never a prompt string;
//   - per-request timeout selection (configured vs default);
//   - total, lifecycle-free capability introspection (no bus round-trip);
//   - typed extension dispatch via `request(cap, input)`;
//   - injected-bus lifecycle: `stop()` is a no-op for the caller-owned bus.
//
// Validates: Requirements 6.1, 6.5, 6.6, 6.7
// =============================================================================

import type StdioBus from '@stdiobus/node';
import { BusSkillsRuntime } from '../../../runtime/transport/bus-runtime.js';
import { CORE_CAPABILITIES, SkillsCapabilities } from '../../../runtime/capabilities.js';
import type { ReadSkillInput, SkillResponse } from '../../../runtime/contract.js';

/** One recorded `bus.request` invocation. */
interface BusCall {
  method: string;
  params: unknown;
  timeout: number | undefined;
}

interface RecordingBus {
  bus: StdioBus;
  calls: BusCall[];
  state: { stopCalls: number };
}

/**
 * A request-only stub bus that records calls. It is INJECTED, so the runtime treats it as
 * caller-owned and never calls `start()`/`stop()` on it — `start()` here throws to prove
 * that invariant, and `stop()` only increments a counter.
 */
function makeRecordingBus(respond: (call: BusCall) => unknown | Promise<unknown>): RecordingBus {
  const calls: BusCall[] = [];
  const state = { stopCalls: 0 };
  const bus = {
    async request(method: string, params: unknown, opts?: { timeout?: number }): Promise<unknown> {
      const call: BusCall = { method, params, timeout: opts?.timeout };
      calls.push(call);
      return respond(call);
    },
    async start(): Promise<void> {
      throw new Error('injected bus must never be started by the runtime');
    },
    async stop(): Promise<void> {
      state.stopCalls += 1;
    },
  };
  return { bus: bus as unknown as StdioBus, calls, state };
}

const readInput: ReadSkillInput = { ref: { kind: 'name', name: 'runtime-concepts' } };
const notFoundWire: SkillResponse<unknown> = { ok: false, error: { code: 'not_found', ref: readInput.ref } };

describe('BusSkillsRuntime: returned-error totality at the transport boundary (Req 6.7)', () => {
  it('maps a thrown transport failure to a typed provider_error preserving the bus:<pool> origin', async () => {
    const { bus } = makeRecordingBus(() => {
      throw new Error('bus down');
    });
    const runtime = new BusSkillsRuntime({ pool: 'skills' }, bus);

    const resp = await runtime.read(readInput);

    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error.code).toBe('provider_error');
    if (resp.error.code !== 'provider_error') return;
    // Origin is preserved as the synthetic bus:<pool> marker (interim mapping).
    expect(resp.error.provider).toBe('bus:skills');
    expect(resp.error.message).toContain('bus down');
  });

  it('maps a rejected request the same way (never throws across the contract boundary)', async () => {
    const { bus } = makeRecordingBus(() => Promise.reject(new Error('rpc timeout')));
    const runtime = new BusSkillsRuntime({ pool: 'pool-7' }, bus);

    // Must resolve to a value, not reject.
    const resp = await runtime.list();
    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error.code).toBe('provider_error');
    if (resp.error.code !== 'provider_error') return;
    expect(resp.error.provider).toBe('bus:pool-7');
    expect(resp.error.message).toContain('rpc timeout');
  });
});

describe('BusSkillsRuntime: per-request timeout selection', () => {
  it('uses the configured timeoutMs when provided', async () => {
    const { bus, calls } = makeRecordingBus(() => notFoundWire);
    const runtime = new BusSkillsRuntime({ pool: 'skills', timeoutMs: 1234 }, bus);

    await runtime.read(readInput);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe(SkillsCapabilities.read.method);
    expect(calls[0].timeout).toBe(1234);
  });

  it('falls back to the default timeout when none is configured', async () => {
    const { bus, calls } = makeRecordingBus(() => notFoundWire);
    const runtime = new BusSkillsRuntime({ pool: 'skills' }, bus);

    await runtime.read(readInput);

    expect(calls[0].timeout).toBe(30_000);
  });
});

describe('BusSkillsRuntime: introspection and extension dispatch', () => {
  it('capabilities() enumerates the core capabilities without a bus round-trip', async () => {
    const { bus, calls } = makeRecordingBus(() => {
      throw new Error('capabilities() must not touch the bus');
    });
    const runtime = new BusSkillsRuntime({ pool: 'skills' }, bus);

    const caps = await runtime.capabilities();

    expect(caps).toHaveLength(CORE_CAPABILITIES.length);
    expect(caps.map((c) => c.method)).toContain(SkillsCapabilities.read.method);
    // No bus traffic for pure introspection.
    expect(calls).toHaveLength(0);
  });

  it('request(cap, input) routes the capability method over the bus and decodes the response', async () => {
    const { bus, calls } = makeRecordingBus(() => notFoundWire);
    const runtime = new BusSkillsRuntime({ pool: 'skills' }, bus);

    const resp = await runtime.request(SkillsCapabilities.read, readInput);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe(SkillsCapabilities.read.method);
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('not_found');
  });
});

describe('BusSkillsRuntime: injected-bus lifecycle', () => {
  it('stop() is a no-op for a caller-owned (injected) bus', async () => {
    const rec = makeRecordingBus(() => notFoundWire);
    const runtime = new BusSkillsRuntime({ pool: 'skills' }, rec.bus);

    await runtime.read(readInput);
    await expect(runtime.stop()).resolves.toBeUndefined();
    // The runtime never starts or stops a bus it does not own.
    expect(rec.state.stopCalls).toBe(0);
  });
});
