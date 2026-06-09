/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `skills.add.v1` capability handler — normalize + delegate + map, NO admission logic
 * (Milestone-002, Task 9.1; design §"Components" 7; Req 1.1, 1.5, 15.1, 15.3).
 *
 * The handler is the thin edge between the `request<TInput,TOutput>` capability seam (and,
 * in Task 9.2, the existing stdio Bus worker dispatch) and the {@link AdmissionController}.
 * It does EXACTLY three things and holds NO admission logic of its own (Req 1.5):
 *
 *   1. NORMALIZE — apply the decode-time defaults to the wire {@link RawProviderDescriptor}
 *      via the pure {@link normalizeDescriptor} (so the controller never sees a maybe-trust
 *      descriptor — design §"Components" 1 / companion fix 1).
 *   2. DELEGATE  — hand the normalized {@link ProviderDescriptor} to the single admission
 *      authority {@link AdmissionController.admit} (Req 1.5, 2.5). All staging, validation,
 *      acquisition, hashing, namespace claiming, and registration live there — never here.
 *   3. MAP       — render the returned {@link AdmissionOutcome} into the wire-facing
 *      {@link SkillResponse} via the pure {@link admissionOutcomeToResponse}.
 *
 * ─── SURFACE PLACEMENT (Req 15.1, 15.3) ────────────────────────────────────────────
 *
 * `skills.add.v1` is an EXTENSION capability ({@link AdmissionCapabilities.add}), NOT a core
 * method and NOT a default MCP tool: the production MCP adapter still registers only the five
 * bundled tools. This handler is reached solely through the `request` seam (and the bus-worker
 * dispatch added in Task 9.2). It is wired into no default tool surface here.
 *
 * ─── OUTCOME → RESPONSE MAPPING ────────────────────────────────────────────────────
 *
 * - SUCCESS (`{ ok: true; admitted }`) → a `SkillResponse` success whose `data` is the
 *   {@link AdmittedProvider} and whose `provenance` is built from the admitted descriptor,
 *   carrying the record-only `contentHash` (Req 1.2, 8.2).
 * - QUARANTINE (`{ ok: false; stage; error }`) → a `SkillResponse` failure whose typed error
 *   is the `quarantined` ENVELOPE `{ code: 'quarantined'; stage; cause }` (Task 9.2; design
 *   §"Error Handling"). The envelope is a THIN wrapper: the rejecting `stage` is recorded and
 *   the authoritative typed `cause` (`bad_request`, `content_too_large`, `provider_error`, …)
 *   is preserved unchanged, so both `stage` and `cause.code` survive on the wire. Because
 *   `'quarantined'` is a KNOWN wire error code, the bus wire-response validator accepts the
 *   quarantine as a structurally valid `SkillResponse` (Req 9.4).
 */

import type { Provenance, SkillResponse } from '../contract.js';
import type { AdmissionController } from './admission-controller.js';
import type { AdmissionOutcome, AdmittedProvider } from './outcome.js';
import {
  type RawProviderDescriptor,
  normalizeDescriptor,
} from './provider-descriptor.js';

/**
 * Build the runtime-owned {@link Provenance} envelope for a successful admission.
 *
 * Pure value transform (architecture standard §5): the core provenance fields come from the
 * admitted runtime-resolved descriptor, and the record-only `contentHash` is attached via the
 * existing `Provenance` index signature — no contract edit, never used for dedupe/equivalence
 * (Req 8.2; design fix 8).
 *
 * @param admitted - the admitted provider identity + record-only hash.
 * @returns the finalized provenance for the `skills.add.v1` success result.
 */
function admittedProvenance(admitted: AdmittedProvider): Provenance {
  const { descriptor, contentHash } = admitted;
  return {
    fqid: descriptor.fqid,
    provider: descriptor.provider,
    source: descriptor.source,
    // Record-only provenance (Req 8.2); plays no part in equality/dedupe/conflict detection.
    contentHash,
  };
}

/**
 * Map an {@link AdmissionOutcome} into a wire-facing {@link SkillResponse} (Task 9.2).
 *
 * Pure value transform: no I/O, no admission logic. A success becomes a `SkillResponse`
 * success with provenance built from the admitted descriptor; a quarantine becomes a
 * `SkillResponse` failure whose error is the `quarantined` envelope wrapping the rejecting
 * `stage` and the authoritative typed `cause` (so both survive on the wire — Req 9.2, 9.4).
 *
 * @param outcome - the total admission outcome returned by {@link AdmissionController.admit}.
 * @returns the equivalent `SkillResponse<AdmittedProvider>`.
 */
export function admissionOutcomeToResponse(
  outcome: AdmissionOutcome,
): SkillResponse<AdmittedProvider> {
  if (outcome.ok) {
    return { ok: true, data: outcome.admitted, provenance: admittedProvenance(outcome.admitted) };
  }
  // Task 9.2: wrap the rejecting stage + authoritative typed cause in the `quarantined`
  // envelope (design §"Error Handling"). The envelope is a THIN wrapper — `cause` carries the
  // real typed error (`bad_request`, `content_too_large`, `provider_error`, ...) unchanged and
  // stays authoritative, while `stage` records which pipeline stage rejected (Req 9.2). Both
  // `stage` and `cause.code` survive on the wire, so a client distinguishes a config rejection
  // from an acquire/admit rejection by switching on either. `'quarantined'` is a KNOWN wire
  // error code (`KNOWN_ERROR_CODES` in `param-codec.ts`), so the bus wire-response validator
  // accepts this as a structurally valid `SkillResponse` (Req 9.4).
  return {
    ok: false,
    error: { code: 'quarantined', stage: outcome.stage, cause: outcome.error },
  };
}

/**
 * The `skills.add.v1` capability handler (Req 1.1, 1.5).
 *
 * A first-class actor (architecture standard §9) holding only its collaborator — the
 * {@link AdmissionController} — and NO admission logic. Reached through the `request` seam
 * and, in Task 9.2, the existing stdio Bus worker dispatch.
 */
export class AdmissionCapabilityHandler {
  /**
   * @param controller - the single admission authority this handler delegates to (Req 2.5).
   */
  constructor(private readonly controller: AdmissionController) { }

  /**
   * Handle a `skills.add.v1` request: normalize the wire descriptor, delegate to the
   * {@link AdmissionController}, and map the outcome to a {@link SkillResponse} (Req 1.5).
   *
   * Total: because {@link AdmissionController.admit} never throws (Req 2.4, 9.1) and both the
   * normalize and map steps are pure total transforms, this method never throws across the
   * capability boundary.
   *
   * @param raw - the wire {@link RawProviderDescriptor} (`trust` / `capabilityVersions` may
   *   be omitted; the normalizer applies the least-privilege defaults).
   * @returns the typed `SkillResponse<AdmittedProvider>` for the admission attempt.
   */
  async handle(raw: RawProviderDescriptor): Promise<SkillResponse<AdmittedProvider>> {
    const descriptor = normalizeDescriptor(raw);
    const outcome = await this.controller.admit(descriptor);
    return admissionOutcomeToResponse(outcome);
  }
}
