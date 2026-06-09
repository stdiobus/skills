/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Unit tests — OperationBudget: per-operation timeout + cancellation seam
// (Milestone-002, Task 5; design §"Components" 6; Req 12.1, 12.2, 12.3).
//
// Subject under test:
//   - runtime/admission/operation-budget.ts
//       OperationBudget.run<T>(fn(signal), timeoutMs?, parentSignal?):
//         - timeout fires             → typed provider_error (returned, not thrown)
//         - explicit (parent) abort   → typed provider_error (returned, not thrown)
//         - a fast fn resolves        → { ok: true; value }
//         - no-budget path            → identity baseline (value passthrough, no timer)
//
// Behavior verified additionally:
//   - the linked signal is aborted inside fn on timeout / cancel
//   - a non-abort rejection from fn propagates (the budget does not swallow it)
//   - the timer is cleaned up on every path (suite runs with --detectOpenHandles)
//
// Validates: Requirements 12.1, 12.2, 12.3
// =============================================================================

import { OperationBudget } from '../../../runtime/admission/operation-budget.js';

/** A promise that rejects when the supplied signal aborts (a well-behaved operation). */
function abortable(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

describe('OperationBudget.run — timeout expiry (Req 12.1)', () => {
  it('returns a typed provider_error when the timeout fires (never throws)', async () => {
    const budget = new OperationBudget(10);

    const result = await budget.run((signal) => abortable(signal));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a returned error');
    expect(result.error.code).toBe('provider_error');
    if (result.error.code !== 'provider_error') throw new Error('narrowing');
    expect(result.error.message).toContain('budget');
    expect(result.error.message).toContain('10');
  });

  it('aborts the signal handed to fn when the deadline passes', async () => {
    const budget = new OperationBudget(10);
    let observedAborted = false;

    const result = await budget.run(async (signal) => {
      try {
        await abortable(signal);
      } finally {
        observedAborted = signal.aborted;
      }
      return 'unreachable';
    });

    expect(result.ok).toBe(false);
    expect(observedAborted).toBe(true);
  });
});

describe('OperationBudget.run — explicit cancellation (Req 12.2)', () => {
  it('returns a typed provider_error when an external parent signal aborts', async () => {
    const budget = new OperationBudget(10_000); // large: cancellation must win, not the timer
    const parent = new AbortController();

    const pending = budget.run((signal) => abortable(signal), undefined, parent.signal);
    parent.abort();
    const result = await pending;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a returned error');
    expect(result.error.code).toBe('provider_error');
    if (result.error.code !== 'provider_error') throw new Error('narrowing');
    expect(result.error.message).toBe('operation was cancelled');
  });

  it('cancels immediately when the parent signal is already aborted', async () => {
    const budget = new OperationBudget(10_000);
    const parent = new AbortController();
    parent.abort();

    const result = await budget.run((signal) => abortable(signal), undefined, parent.signal);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a returned error');
    expect(result.error.code).toBe('provider_error');
  });
});

describe('OperationBudget.run — success (Req 12.1)', () => {
  it('resolves with the value of a fast fn', async () => {
    const budget = new OperationBudget(1_000);

    const result = await budget.run(async () => 42);

    expect(result).toEqual({ ok: true, value: 42 });
  });

  it('passes a live, non-aborted signal to a fast fn', async () => {
    const budget = new OperationBudget(1_000);

    const result = await budget.run(async (signal) => signal.aborted);

    expect(result).toEqual({ ok: true, value: false });
  });
});

describe('OperationBudget.run — no-budget identity baseline (Req 12.3)', () => {
  it('a non-positive timeout arms no timer and returns the value unchanged', async () => {
    const budget = new OperationBudget(0);

    const result = await budget.run(async () => 'baseline');

    expect(result).toEqual({ ok: true, value: 'baseline' });
  });

  it('an explicit timeoutMs of 0 overrides a positive default to the identity path', async () => {
    const budget = new OperationBudget(50);

    // A fn that resolves only after a delay LONGER than the default would time out if a
    // timer were armed; with timeoutMs=0 no timer is armed, so it resolves normally.
    const result = await budget.run(
      () => new Promise<string>((resolve) => setTimeout(() => resolve('slow-ok'), 80)),
      0,
    );

    expect(result).toEqual({ ok: true, value: 'slow-ok' });
  });
});

describe('OperationBudget.run — non-abort faults propagate (focused responsibility)', () => {
  it('rethrows an error that is not caused by the signal aborting', async () => {
    const budget = new OperationBudget(1_000);

    await expect(
      budget.run(async () => {
        throw new Error('genuine provider fault');
      }),
    ).rejects.toThrow('genuine provider fault');
  });
});
