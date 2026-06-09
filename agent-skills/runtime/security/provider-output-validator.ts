/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Provider-output ingress validation (Milestone-002, Task 6 — T26-minimum; design
 * §"Components" 6 / §"Security & Trust"; Req 6.1, 6.2, 6.3, 5.4, 5.5).
 *
 * The single, reusable place that decides whether a value a provider RETURNS on any public
 * operation (`resolve`, `read`, `list`, `search`, and the provider methods
 * `listReferences` / `readReference` behind `getReferences` / `readReference`) may cross
 * the provider-output boundary into a caller's result OR into aggregation. It is applied
 * **before** the value is exposed (Req 6.1, 6.3).
 *
 * It composes the EXISTING pure guards — it adds no new trust evaluation (design §6):
 *
 *   1. **metadata shape** — the descriptor must be a non-null object before any field is
 *      read (a provider that returns a non-object / partial descriptor is rejected up front,
 *      so the downstream identity guard never dereferences a malformed value);
 *   2. **descriptor identity + declared FQID** — delegated verbatim to
 *      {@link guardDescriptorIdentity} (`runtime/fqid.ts`): missing `provider`/`name`, a
 *      missing/empty declared `fqid`, or an FQID over the interim byte bound are all
 *      rejected (identity-only — never sanitizes body/content);
 *   3. **namespace ownership** — the anti-spoofing predicate
 *      {@link NamespaceOwnershipTable.permits} (`runtime/admission/namespace-ownership.ts`),
 *      keyed on the **child** provider id (Req 5.5), so an admitted provider may only mint
 *      FQIDs under the namespace it owns (Req 5.4);
 *   4. **content size** — delegated to {@link checkContentSize}
 *      (`runtime/security/boundary.ts`) against the provider's effective `maxContentBytes`.
 *
 * ─── BACKWARD-COMPATIBLE / OPTIONAL SEAMS (Req 15.2; design fix 9) ──────────────────
 *
 * Both the namespace table and the trust lookup are OPTIONAL constructor dependencies,
 * mirroring the runtime's existing `trustOf` seam:
 *
 *   - WHEN no {@link NamespaceOwnershipTable} is supplied, the namespace check is INERT —
 *     identity validation behaves exactly like the pre-Task-6 `guardDescriptorIdentity`
 *     call site. Every current direct-construction call site (and the bundled-only
 *     production path, which wires no ownership table) is therefore unchanged.
 *   - EVEN WHEN a table IS supplied, a provider that owns NO namespace
 *     ({@link NamespaceOwnershipTable.hasOwnership} → `false`) is EXEMPT from the namespace
 *     check. The reserved first-party `bundled` provider never claims a namespace (Req 5.3),
 *     so it is never rejected by this boundary — the proven single-bundled-provider baseline
 *     stays byte-for-byte unchanged in a federated deployment too. Only an admitted external
 *     provider (which claimed its namespace at admission) is subject to the anti-spoofing
 *     check.
 *   - WHEN no trust lookup is supplied (or the provider has no policy), the content-size
 *     check is INERT — identical to the runtime's pre-existing `enforceContentSize`
 *     behavior.
 *
 * ─── ANTI-SPOOFING ON THE ACTUAL CHILD PROVIDER (Req 5.5) ──────────────────────────
 *
 * The namespace check is keyed on the id of the provider that ACTUALLY produced the
 * descriptor (the resolving provider / the contributing source), NOT on the descriptor's
 * self-asserted `descriptor.provider`. A malicious provider could otherwise set
 * `descriptor.provider` to another provider's namespace to launder an out-of-namespace
 * FQID; anchoring on the real child id closes that, and because the check runs per-source
 * (never on an aggregate) it can never be masked by the federation layer (Req 5.5;
 * design Property 4).
 *
 * ─── PARTIAL-FAILURE RESILIENCE (Req 6.2) ──────────────────────────────────────────
 *
 * This module returns a typed {@link SkillRuntimeError} (or `null`); it never throws. The
 * runtime applies it per-source in aggregated operations (`list` / `search`), so a failing
 * provider's output is recorded as a per-source error WITHOUT poisoning the well-formed
 * output of its siblings. In single-resolution operations (`resolve` / `read` /
 * `getReferences` / `readReference`) a rejected descriptor fails that resolution as a
 * returned error and is never exposed.
 */

import type { SkillDescriptor, SkillRuntimeError } from '../contract.js';
import { guardDescriptorIdentity } from '../fqid.js';
import type { NamespaceOwnershipTable } from '../admission/namespace-ownership.js';
import { checkContentSize } from './boundary.js';
import type { TrustPolicy } from '../trust.js';

/**
 * Per-provider trust lookup (same shape as the runtime's `TrustLookup`). Resolves a provider
 * id to its effective {@link TrustPolicy} so the content-size bound can be enforced. Kept
 * structurally identical to the runtime seam so the runtime can hand its own lookup straight
 * through.
 */
export type TrustLookup = (providerId: string) => TrustPolicy | undefined;

/**
 * The provider-output boundary validator (design §"Components" 6).
 *
 * A behavior class (architecture standard §9): it owns the decision of whether a
 * provider-produced descriptor / content may cross into a result or aggregation. All of its
 * checks are returned-never-thrown and compose existing pure guards — it introduces no new
 * trust model of its own (Req 6 reuses Req 5 ownership + the Req 11 size/identity guards).
 */
export class ProviderOutputValidator {
  /**
   * @param namespaces - OPTIONAL single namespace-ownership source of truth. When omitted,
   *   the namespace anti-spoofing check is inert (baseline behavior). When supplied, only
   *   providers that own a namespace are subject to the check (Req 5.4; `bundled` exempt).
   * @param trustOf - OPTIONAL per-provider trust lookup. When omitted (or the provider has
   *   no policy), the content-size check is inert (baseline behavior).
   */
  constructor(
    private readonly namespaces?: NamespaceOwnershipTable,
    private readonly trustOf?: TrustLookup,
  ) { }

  /**
   * Validate a single provider-produced descriptor at the output boundary (Req 6.1).
   *
   * @param producingProviderId - the id of the provider that ACTUALLY produced the
   *   descriptor (the child id — Req 5.5), used to anchor the namespace check.
   * @param descriptor - the descriptor the provider returned.
   * @returns the first {@link SkillRuntimeError} that disqualifies the descriptor, or `null`
   *   when it is admissible.
   */
  validateDescriptor(
    producingProviderId: string,
    descriptor: SkillDescriptor,
  ): SkillRuntimeError | null {
    // 1. metadata shape — reject a non-object / null descriptor before reading any field,
    //    so the identity guard never dereferences a malformed value.
    if (descriptor === null || typeof descriptor !== 'object') {
      return {
        code: 'bad_request',
        issues: [`provider "${producingProviderId}" returned a descriptor that is not an object`],
      };
    }

    // 2. descriptor identity + declared FQID (reuse the single identity guard — Req 5.7/1.5).
    const identityError = guardDescriptorIdentity(descriptor);
    if (identityError) return identityError;

    // 3. namespace ownership / anti-spoofing on the child id (Req 5.4, 5.5).
    return this.checkNamespace(producingProviderId, descriptor);
  }

  /**
   * Validate a batch of descriptors from ONE producing provider (Req 6.1, 6.2).
   *
   * Returns the FIRST disqualifying error so the runtime records the whole source's output
   * as a per-source error (the items are not admitted) without affecting sibling providers.
   *
   * @param producingProviderId - the child provider id that produced every descriptor.
   * @param descriptors - the descriptors the provider returned in one operation.
   * @returns the first {@link SkillRuntimeError}, or `null` when every descriptor is valid.
   */
  validateDescriptors(
    producingProviderId: string,
    descriptors: readonly SkillDescriptor[],
  ): SkillRuntimeError | null {
    for (const descriptor of descriptors) {
      const error = this.validateDescriptor(producingProviderId, descriptor);
      if (error) return error;
    }
    return null;
  }

  /**
   * Validate provider-returned content size at the output boundary (Req 6.1).
   *
   * Reuses the pure {@link checkContentSize} guard against the provider's effective
   * `maxContentBytes`. Accepts the materialized content (`string` / `Buffer`) or a
   * pre-computed byte count (`number`) — the latter is the "not loaded in full" pre-read
   * path. Inert when no trust policy applies (baseline behavior).
   *
   * @param producingProviderId - the provider whose policy bounds the content.
   * @param content - the returned content, or its pre-computed byte length.
   * @returns a `content_too_large` {@link SkillRuntimeError} when oversize, else `null`.
   */
  validateContentSize(
    producingProviderId: string,
    content: string | Buffer | number,
  ): SkillRuntimeError | null {
    const policy = this.trustOf?.(producingProviderId);
    if (!policy) return null;
    const result = checkContentSize(content, policy.maxContentBytes, producingProviderId);
    return result.ok ? null : result.error;
  }

  /**
   * Anti-spoofing namespace check (Req 5.4, 5.5; design Property 4).
   *
   * Inert when no ownership table is wired, and EXEMPT for any provider that owns no
   * namespace (the reserved `bundled` provider, and any non-admitted provider). For a
   * provider that DOES own a namespace, the descriptor's declared FQID must fall under a
   * namespace this exact provider owns, else the descriptor is rejected.
   */
  private checkNamespace(
    producingProviderId: string,
    descriptor: SkillDescriptor,
  ): SkillRuntimeError | null {
    if (!this.namespaces) return null;
    if (!this.namespaces.hasOwnership(producingProviderId)) return null;
    if (this.namespaces.permits(producingProviderId, descriptor.fqid)) return null;
    return {
      code: 'bad_request',
      issues: [
        `descriptor.fqid "${descriptor.fqid}" falls outside the namespace owned by provider "${producingProviderId}"`,
      ],
    };
  }
}
