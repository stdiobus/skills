/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Operation budget — per-operation timeout + cancellation seam
 * (Milestone-002, Task 5; design §"Components" 6; Req 12).
 *
 * A slow or unavailable provider must not be able to hang the runtime (Req 12.1). The
 * {@link OperationBudget} owns the timeout policy and the cancellation seam: it runs an
 * operation under a fresh {@link AbortSignal}, arms a finite timeout, optionally LINKS that
 * signal to a caller-supplied parent signal, and maps a timeout expiry or an explicit
 * cancellation to a TYPED, RETURNED error — it never throws across its boundary for those
 * two cases (Req 12.1, 12.2).
 *
 * ─── LINKED SIGNAL ─────────────────────────────────────────────────────────────────
 *
 * {@link run} builds an internal {@link AbortController} and passes its signal to the
 * operation `fn`. The signal aborts when EITHER the timeout fires OR the optional parent
 * signal aborts, so a single signal threaded into `fn` (e.g. into `fetch`) honors both the
 * deadline and an external cancellation. The operation is responsible for OBSERVING the
 * signal (passing it to `fetch`, polling `signal.aborted`); the budget guarantees the
 * signal fires, not that an ill-behaved `fn` returns promptly.
 *
 * ─── RETURNED, NEVER THROWN (for expiry / cancel) ──────────────────────────────────
 *
 * On timeout expiry or explicit cancellation, {@link run} returns
 * `{ ok: false; error }` carrying a typed {@link SkillRuntimeError} (`provider_error`,
 * the only existing contract code that expresses an I/O-bound provider call failing — no
 * timeout-specific code exists and none is added in this milestone). The `message`
 * distinguishes a deadline expiry from a cancellation. Any OTHER rejection thrown by `fn`
 * (a genuine provider fault unrelated to the signal) is NOT swallowed here — it propagates
 * so the caller (e.g. the AdmissionController, Task 8) can attribute and wrap it with the
 * stage context only it knows.
 *
 * ─── BACKWARD-COMPATIBLE NO-BUDGET PATH ────────────────────────────────────────────
 *
 * The seam is optional (Req 12.3): when the effective timeout is non-positive or
 * non-finite AND no parent signal is supplied, no timer is armed and `run` is the IDENTITY
 * baseline — it awaits `fn` under a never-aborting signal and returns its value, exactly as
 * a direct in-process call would. This keeps in-process providers on the proven baseline.
 *
 * ─── NO OPEN HANDLES ───────────────────────────────────────────────────────────────
 *
 * The timer is always cleared and the parent-signal listener always removed in a `finally`,
 * on every path (success, returned error, propagated throw), and the timer is `unref`-ed so
 * it never keeps the event loop alive. The suite runs under `--detectOpenHandles`.
 */

import type { SkillRuntimeError } from '../contract.js';

/** Success / failure shape of a budgeted run (returned, never thrown for expiry/cancel). */
export type BudgetResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SkillRuntimeError };

/**
 * Owns the per-operation timeout policy and the cancellation seam (design §"Components" 6).
 *
 * Construct once with the finite default timeout the operation should not exceed when the
 * caller supplies none; a non-positive / non-finite default makes the budget opt-out by
 * default (the identity baseline) until a caller passes an explicit positive `timeoutMs`.
 */
export class OperationBudget {
  /**
   * Stable provider label for the typed `provider_error` a timeout / cancellation maps to.
   * The budget is provider-agnostic (it wraps an arbitrary operation), so it attributes the
   * failure to the budget seam; the `message` carries the deadline / cancellation detail.
   */
  private static readonly PROVIDER_LABEL = 'operation-budget';

  constructor(private readonly defaultTimeoutMs: number) { }

  /**
   * Run `fn` under a timeout + linked {@link AbortSignal} (Req 12.1, 12.2, 12.3).
   *
   * The signal passed to `fn` aborts on the FIRST of: the timeout firing, or `parentSignal`
   * aborting. On either, `run` returns a typed `provider_error` (never throws for those two
   * cases). A `fn` rejection unrelated to the signal propagates unchanged.
   *
   * @typeParam T - the operation's success value type.
   * @param fn - the operation; receives the linked abort signal and should honor it.
   * @param timeoutMs - per-call timeout override; defaults to the constructor default. A
   *   non-positive / non-finite effective timeout arms no timer (no-budget path).
   * @param parentSignal - optional external signal; aborting it cancels the operation.
   * @returns `{ ok: true; value }` on success, or `{ ok: false; error }` on expiry / cancel.
   */
  async run<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    timeoutMs?: number,
    parentSignal?: AbortSignal,
  ): Promise<BudgetResult<T>> {
    const effectiveTimeoutMs = timeoutMs ?? this.defaultTimeoutMs;
    const armTimer = Number.isFinite(effectiveTimeoutMs) && effectiveTimeoutMs > 0;

    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Link the parent signal: an already-aborted parent cancels immediately; otherwise
    // forward a future parent abort onto the internal controller.
    const onParentAbort = (): void => controller.abort();
    if (parentSignal) {
      if (parentSignal.aborted) {
        controller.abort();
      } else {
        parentSignal.addEventListener('abort', onParentAbort, { once: true });
      }
    }

    if (armTimer && !controller.signal.aborted) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, effectiveTimeoutMs);
      // Do not keep the event loop alive purely for this timer.
      timer.unref?.();
    }

    try {
      const value = await fn(controller.signal);
      return { ok: true, value };
    } catch (err) {
      // Only a timeout expiry or an (external) cancellation is mapped to a typed error.
      // Any other fault is a genuine operation error the caller must attribute itself.
      if (controller.signal.aborted) {
        return { ok: false, error: this.abortError(timedOut, effectiveTimeoutMs) };
      }
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
    }
  }

  /** Build the typed error for an aborted run, distinguishing expiry from cancellation. */
  private abortError(timedOut: boolean, effectiveTimeoutMs: number): SkillRuntimeError {
    const message = timedOut
      ? `operation exceeded its ${effectiveTimeoutMs}ms budget`
      : 'operation was cancelled';
    return { code: 'provider_error', provider: OperationBudget.PROVIDER_LABEL, message };
  }
}
