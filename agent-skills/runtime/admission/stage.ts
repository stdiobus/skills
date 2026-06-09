/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Admission stage seam — shared `StageResult<T>` + stage names
 * (Milestone-002; design §"Components" 2).
 *
 * This module is the single home for the admission pipeline's returned-error vocabulary.
 * It is introduced early (alongside the {@link NamespaceOwnershipTable}, Task 3) so the
 * ownership table and every later stage speak the SAME result type, and is deliberately
 * MINIMAL: it declares only the shapes that more than one component shares.
 *
 *   - {@link StageResult} — the per-stage returned-never-thrown result (the same
 *     `{ ok: true; value } | { ok: false; error }` discipline as the runtime contract).
 *   - {@link AdmissionStageName} — the closed set of pipeline stage names, used by the
 *     `quarantined` envelope to name the rejecting stage (Req 9.2).
 *
 * ─── EXTENDED BY THE ADMISSION CONTROLLER (Task 8) ─────────────────────────────────
 *
 * The first-class `AdmissionStage<TIn, TOut>` interface, the `AdmissionOutcome` type, and
 * the `AdmissionController` that composes the fixed stage sequence are added by Task 8 and
 * BUILD ON the types declared here — they do not redefine them. Keeping `StageResult` here
 * means a stage's success/failure shape is fixed once, at the seam, not per stage.
 *
 * ─── RETURNED, NEVER THROWN ────────────────────────────────────────────────────────
 *
 * Every admission stage is total: it returns a {@link StageResult}; it does not throw to
 * signal a rejection (Req 2.3, 2.4). A `{ ok: false }` carries a typed
 * {@link SkillRuntimeError} the controller renders into the `quarantined` envelope, so a
 * client distinguishes a config rejection from a namespace rejection by switching on the
 * typed `error.code` (and, at the controller edge, the rejecting `stage`).
 */

import type { SkillRuntimeError } from '../contract.js';

/**
 * The closed, ordered set of admission pipeline stage names (design §"Components" 2).
 *
 * The pipeline runs these in exactly this order; the FIRST failing stage short-circuits to
 * a quarantine outcome naming that stage (Req 2.1, 2.3, 9.2). Namespace-ownership rejection
 * (this task's {@link NamespaceOwnershipTable.claim}) surfaces under the `'admit'` stage.
 */
export type AdmissionStageName =
  | 'discover'
  | 'validate'
  | 'acquire'
  | 'hash-record'
  | 'admit'
  | 'register';

/**
 * The result of a single admission stage — returned, never thrown (Req 2.3, 2.4).
 *
 * - `{ ok: true; value }` — the stage succeeded; `value` is its typed artifact (for a
 *   side-effecting stage with no artifact, `TOut` is `void`).
 * - `{ ok: false; error }` — the stage rejected; `error` is the authoritative typed
 *   {@link SkillRuntimeError} the controller wraps in the `quarantined` envelope.
 */
export type StageResult<TOut> =
  | { ok: true; value: TOut }
  | { ok: false; error: SkillRuntimeError };

/**
 * A single admission pipeline stage — a first-class actor behind a binding generic seam
 * (design §"Components" 2; architecture standard §§6, 9; added by Task 8.1).
 *
 * Each stage is a class transforming a typed input context `TIn` into a typed output `TOut`,
 * returning a {@link StageResult} (returned, never thrown — Req 2.2, 2.3). The
 * `AdmissionController` (Task 8.2) composes a fixed, explicitly-typed sequence of stages
 * whose outputs thread into the next stage's input, and runs every stage under the
 * per-operation budget `signal` (Req 12). The FIRST failing stage short-circuits to a
 * quarantine outcome naming that stage (`{@link AdmissionStage.name}`; Req 2.3, 9.2).
 *
 * The type parameters refine the admission context as it accrues (each stage's `TOut`
 * carries everything the downstream stages need), so the controller cannot wire the stages
 * out of order without a type error — the pipeline shape is enforced by the compiler, not by
 * runtime convention.
 *
 * @typeParam TIn - the accumulated context this stage consumes.
 * @typeParam TOut - the context this stage produces (consumed by the next stage).
 */
export interface AdmissionStage<TIn, TOut> {
  /** The stage's name; the quarantine outcome names this stage on the first failure. */
  readonly name: AdmissionStageName;

  /**
   * Run the stage under the per-operation cancel `signal` (Req 12).
   *
   * @param ctx - the accumulated input context.
   * @param signal - the budget's linked {@link AbortSignal}; an I/O-bound stage honors it.
   * @returns a {@link StageResult}: `{ ok: true; value }` to continue, or `{ ok: false; error }`
   *   to short-circuit to a quarantine. Stages return their rejection; the controller's
   *   outer catch maps an unexpected throw to a `provider_error` quarantine (admission is total).
   */
  run(ctx: TIn, signal: AbortSignal): Promise<StageResult<TOut>>;
}
