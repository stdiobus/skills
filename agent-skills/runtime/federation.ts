/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Federation aggregate envelope — the diagnostics the runtime attaches to aggregated
 * `list` / `search` results, carried INSIDE the existing provenance envelope under an
 * explicitly named key (Requirement 4.5; design §4b).
 *
 * ─── Single-skill shape is untouched ───────────────────────────────────────────────
 *
 * This module adds NO new field to `SkillResponse<T>` and does NOT edit `contract.ts`.
 * The aggregate diagnostics ride the `[key: string]: unknown` index signature that
 * already exists on {@link Provenance}, under one explicitly named key
 * ({@link AGGREGATE_DIAGNOSTICS_KEY}) — i.e. `provenance.aggregateDiagnostics`. The
 * single-skill `SkillResponse` envelope therefore stays structurally identical; only
 * aggregated operations populate the key (Req 4.5).
 *
 * ─── Scope of THIS task (8.1) ──────────────────────────────────────────────────────
 *
 * This file defines the TYPE and the named-key CARRIER only (the shape + attach/read
 * helpers). The deterministic aggregation ALGORITHM that fills these fields in
 * `list` / `search` is Task 8.2.
 *
 * ─── NON-BLOCKING NOTE — open-item D (final aggregate shape) ────────────────────────
 *
 * The named-key carrier is the documented INTERIM placeholder, NOT the final aggregate
 * provenance specification (design §"Open Items", open-item D). When the final aggregate
 * shape lands, it changes only the value carried under this single named key; because the
 * diagnostics ride the `Provenance` index signature, the single-skill contract never
 * changes and `SkillResponse<T>` needs no edit. Nothing in this task depends on the final
 * shape being decided.
 */

import type { Provenance, SkillRuntimeError } from './contract.js';

/**
 * Per-source and conflict diagnostics for an aggregated `list` / `search` operation.
 *
 * - `sources` records one entry per participating provider: whether it succeeded, an
 *   optional result `count`, or the returned {@link SkillRuntimeError} on failure
 *   (Req 4.1, 4.3). A failing provider is captured here, never propagated as a throw.
 * - `conflicts` records the same-FQID-differing-content clashes the runtime refuses to
 *   silently resolve (Req 4.2, 4.4): each entry names the shared `fqid` and the providers
 *   that disagreed.
 * - `fallbacksApplied` records runtime fallbacks used to satisfy the operation — e.g. a
 *   provider lacking `search` served by a list+substring fallback (Req 3.3).
 *
 * INTERIM shape (open-item D): the field set is forward-compatible and may grow; it is
 * carried under {@link AGGREGATE_DIAGNOSTICS_KEY} so the single-skill contract is unaffected.
 */
export interface AggregateDiagnostics {
  sources: Array<{ provider: string; ok: boolean; count?: number; error?: SkillRuntimeError }>;
  conflicts: Array<{ fqid: string; providers: string[] }>;
  fallbacksApplied?: string[];
}

/**
 * The explicitly named provenance key under which {@link AggregateDiagnostics} is carried,
 * i.e. `provenance.aggregateDiagnostics`. Defining it as a single named constant keeps the
 * carrier in one place rather than scattering the string literal across the runtime.
 */
export const AGGREGATE_DIAGNOSTICS_KEY = 'aggregateDiagnostics' as const;

/**
 * A {@link Provenance} envelope that is known to carry {@link AggregateDiagnostics} under
 * the named key. This is a refinement of `Provenance` (it rides the existing index
 * signature), so an `AggregateProvenance` is always assignable where a `Provenance` is
 * expected — the single-skill shape is never widened.
 */
export type AggregateProvenance = Provenance & {
  [AGGREGATE_DIAGNOSTICS_KEY]: AggregateDiagnostics;
};

/**
 * Attach aggregate diagnostics to a provenance envelope under the named key.
 *
 * Returns a NEW envelope (the input is not mutated) with
 * `provenance.aggregateDiagnostics` set, narrowed to {@link AggregateProvenance}. This is
 * the single write point for the carrier; the aggregation algorithm (Task 8.2) calls it
 * once it has computed the diagnostics.
 */
export function attachAggregateDiagnostics(
  provenance: Provenance,
  diagnostics: AggregateDiagnostics,
): AggregateProvenance {
  return { ...provenance, [AGGREGATE_DIAGNOSTICS_KEY]: diagnostics };
}

/**
 * Read aggregate diagnostics from a provenance envelope, or `undefined` when the named key
 * is absent (e.g. a single-skill result, which never carries it).
 *
 * This is the single read point for the carrier. It reads through the `Provenance` index
 * signature (typed `unknown`) and returns the value under the named key without further
 * structural validation — the runtime is the sole writer via
 * {@link attachAggregateDiagnostics}, so the value is well-formed by construction.
 */
export function readAggregateDiagnostics(
  provenance: Provenance,
): AggregateDiagnostics | undefined {
  const value = provenance[AGGREGATE_DIAGNOSTICS_KEY];
  return value === undefined ? undefined : (value as AggregateDiagnostics);
}
