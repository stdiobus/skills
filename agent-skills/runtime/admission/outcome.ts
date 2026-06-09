/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Admission result data — `AdmittedProvider` + `AdmissionOutcome`
 * (Milestone-002, Task 8.1; design §"Components" 2 / "Data Models"; Req 8.2, 9.2).
 *
 * These are the VALUE shapes the {@link AdmissionController} (Task 8.2) returns; the behavior
 * lives in the stage classes and the controller. They are kept in their own module (not in
 * `stage.ts`) because `stage.ts` is the shared returned-error VOCABULARY seam introduced
 * early for the ownership table, whereas these two types belong to the controller's public
 * result and reference the runtime's {@link SkillDescriptor} identity.
 *
 * ─── HASH IS RECORD-ONLY (Req 8.2) ─────────────────────────────────────────────────
 *
 * {@link AdmittedProvider.contentHash} is provenance recorded on success; it plays NO part
 * in equality, dedupe, or conflict detection (design fix 8). It is the digest the
 * `hash-record` stage computed over the acquired bytes, surfaced so a client can record what
 * was admitted — nothing more.
 *
 * ─── THE OUTCOME NAMES THE REJECTING STAGE (Req 9.2) ───────────────────────────────
 *
 * A failed {@link AdmissionOutcome} carries BOTH the rejecting `stage` and the authoritative
 * typed `error` (`bad_request`, `content_too_large`, `provider_error`, …). The capability
 * edge (Task 9.2) renders this into the `quarantined` envelope, preserving both the `stage`
 * and the typed `cause` on the wire. This task returns the underlying typed errors directly;
 * the `quarantined` envelope code itself is added in Task 9.2, not here.
 */

import type { SkillDescriptor, SkillRuntimeError } from '../contract.js';
import type { AdmissionStageName } from './stage.js';

/**
 * The success payload of `skills.add.v1` — the admitted provider's runtime-resolved identity
 * plus the record-only content hash (design §"Data Models"; Req 8.2).
 */
export interface AdmittedProvider {
  /** The runtime-resolved descriptor identity of the admitted skill. */
  readonly descriptor: SkillDescriptor;
  /** SHA-256 (interim) over the acquired bytes — record-only provenance (Req 8.2). */
  readonly contentHash: string;
}

/**
 * The total result of an admission run (design §"Components" 2; Req 9.1, 9.2).
 *
 * - `{ ok: true; admitted }` — the provider was registered; `admitted` carries its identity
 *   and the record-only content hash.
 * - `{ ok: false; stage; error }` — the pipeline short-circuited at `stage` (Req 9.2) with
 *   the authoritative typed `error` (returned, never thrown — Req 9.1). The registry is left
 *   unchanged on this branch (Req 9.3).
 */
export type AdmissionOutcome =
  | { ok: true; admitted: AdmittedProvider }
  | { ok: false; stage: AdmissionStageName; error: SkillRuntimeError };
