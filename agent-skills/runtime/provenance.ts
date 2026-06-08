/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Provenance finalization policy — the single place where the runtime turns a provider's
 * {@link ProvenanceSeed} into the finalized {@link Provenance} envelope it owns
 * (Requirement 2.9; design §2 "the runtime finalizes provenance from a provider
 * `ProvenanceSeed`").
 *
 * ─── Why this module exists (the integrity boundary) ────────────────────────────────
 *
 * Provenance is a security/diagnostic boundary: it is the runtime's attestation of WHERE a
 * result came from. The earlier `{ ...seed, fqid, provider, source, resolvedFrom }` spread
 * overwrote the four core fields but let ANY OTHER seed key pass through unchecked. A
 * provider could therefore:
 *   - inject a RESERVED runtime key (e.g. `aggregateDiagnostics`) into a single-skill
 *     provenance, forging federation diagnostics the runtime never produced; or
 *   - attach an arbitrary / heavy / non-JSON-serializable payload to every result,
 *     bloating the envelope and breaking the serialized transport boundary (Req 2.10/6.3).
 *
 * Req 2.9 grants the runtime the authority to "normalize, reject, or preserve
 * provider-supplied metadata according to the provenance schema/policy". This module is
 * that policy. The runtime — never the provider — owns the provenance shape:
 *
 *   (a) RESERVED-KEY POLICY: the runtime-owned keys
 *       {@link RESERVED_PROVENANCE_KEYS} are NEVER admitted from a seed. They are set by
 *       the runtime from the resolved descriptor (`fqid`, `provider`, `source`,
 *       `resolvedFrom`) or are runtime-only diagnostics (`aggregateDiagnostics`, and the
 *       namespace key itself), so a seed can never forge them.
 *   (b) NAMESPACING: every remaining, admissible provider-supplied key is carried under the
 *       single {@link PROVIDER_METADATA_KEY} namespace — a nested object — so provider keys
 *       can never collide with a runtime-owned top-level provenance field.
 *   (c) SIZE + SERIALIZABILITY BOUND: each candidate value must be JSON-serializable and
 *       fit within {@link MAX_PROVIDER_SEED_BYTES}; anything non-serializable or oversized
 *       is dropped. The admitted value is stored as its JSON round-trip, guaranteeing the
 *       finalized provenance is always JSON-serializable for the transport boundary.
 *
 * ─── Chosen failure model: SAFE DROP (not returned error) ───────────────────────────
 *
 * Provenance is finalized on the SUCCESS path of `read` / `getReferences` / `readReference`
 * — the content was already resolved and read successfully; provenance is metadata about
 * that success. Failing a successful read because a provider attached junk metadata would
 * fight the architecture (it would turn a successful content read into an error). Consistent
 * with Req 2.9's "normalize" authority and the runtime's total success path, the policy is a
 * SAFE DROP: offending (reserved / non-serializable / oversized) seed keys are silently
 * dropped from the finalized envelope, and the successful result is still returned. No new
 * error branch is introduced on the success path.
 *
 * ─── Bundled-path invariant ─────────────────────────────────────────────────────────
 *
 * The bundled provider contributes only `{ source }`. With no extra keys, {@link
 * sanitizeProvenanceSeed} returns `undefined` and {@link finalizeProvenance} adds NO
 * namespace key — so the bundled provenance is `{ fqid, provider, source, resolvedFrom }`,
 * unchanged from before (Task 5.1 baseline stays green).
 *
 * ─── NON-BLOCKING NOTE — interim size bound ─────────────────────────────────────────
 *
 * {@link MAX_PROVIDER_SEED_BYTES} is a documented INTERIM placeholder (Milestone §10 open
 * provenance schema). The final provenance schema may make the bound deployment/profile
 * policy; because the bound lives behind this single module, that change touches only here
 * and never the contract or the aggregation algorithm.
 */

import type { Provenance, ProvenanceSeed, ResolvedSkill, SkillRef } from './contract.js';
import { AGGREGATE_DIAGNOSTICS_KEY } from './federation.js';

/**
 * The single namespace key under which admissible provider-supplied seed keys are carried,
 * i.e. `provenance.providerMetadata`. A nested object under one key guarantees provider
 * keys can never collide with a runtime-owned top-level provenance field (the core
 * `provider` field is a string id — distinct from this metadata bag).
 */
export const PROVIDER_METADATA_KEY = 'providerMetadata' as const;

/**
 * Runtime-owned provenance keys that are NEVER accepted from a provider seed.
 *
 * - `fqid`, `provider`, `source`, `resolvedFrom`: the core envelope, set by the runtime
 *   from the resolved descriptor and the asked ref (`source` is the only core field the
 *   provider legitimately contributes, and the runtime reads it explicitly — it is not
 *   admitted via the generic seed pass-through).
 * - `aggregateDiagnostics`: runtime-only federation diagnostics; a single-skill seed must
 *   never be able to forge it.
 * - the namespace key itself: a seed must not be able to pre-populate / forge the
 *   provider-metadata bag.
 */
export const RESERVED_PROVENANCE_KEYS: readonly string[] = [
  'fqid',
  'provider',
  'source',
  'resolvedFrom',
  AGGREGATE_DIAGNOSTICS_KEY,
  PROVIDER_METADATA_KEY,
];

/**
 * INTERIM upper bound (UTF-8 bytes) on the cumulative size of the namespaced
 * provider-metadata bag. Chosen to comfortably hold small diagnostic annotations while
 * preventing a provider from attaching a heavy payload to every result. Documented interim
 * placeholder (see module note).
 */
export const MAX_PROVIDER_SEED_BYTES = 4096;

/**
 * Sanitize a provider {@link ProvenanceSeed} into the namespaced provider-metadata bag.
 *
 * Drops every reserved key (a), then admits each remaining key only if its value is
 * JSON-serializable and fits within the cumulative {@link MAX_PROVIDER_SEED_BYTES} budget
 * (c). Keys are processed in sorted order so the budget cut-off is deterministic. Each
 * admitted value is stored as its JSON round-trip so the result is guaranteed
 * JSON-serializable (transport-safe). Returns `undefined` when nothing is admitted — so the
 * caller adds no namespace key at all (preserving the bundled `{ source }`-only shape).
 */
export function sanitizeProvenanceSeed(seed: ProvenanceSeed): Record<string, unknown> | undefined {
  const reserved = new Set(RESERVED_PROVENANCE_KEYS);
  const namespaced: Record<string, unknown> = {};
  let usedBytes = 0;
  let admitted = 0;

  for (const key of Object.keys(seed).sort()) {
    // (a) reserved-key policy: runtime-owned keys are never admitted from a seed.
    if (reserved.has(key)) continue;

    const value = seed[key];

    // (c) JSON-serializability: a circular structure or a BigInt throws; a function,
    // symbol, or `undefined` serializes to `undefined`. Either way the key is dropped.
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      continue;
    }
    if (serialized === undefined) continue;

    // (c) size bound: skip any key whose admission would exceed the cumulative budget.
    const size = Buffer.byteLength(serialized, 'utf8');
    if (usedBytes + size > MAX_PROVIDER_SEED_BYTES) continue;

    usedBytes += size;
    // Store the JSON round-trip so the finalized provenance is always JSON-serializable.
    namespaced[key] = JSON.parse(serialized) as unknown;
    admitted += 1;
  }

  return admitted === 0 ? undefined : namespaced;
}

/**
 * Finalize the runtime-owned {@link Provenance} envelope for a resolved skill.
 *
 * The runtime sets the core fields from the resolved descriptor and the asked ref; any
 * admissible provider-supplied seed keys are carried under the single
 * {@link PROVIDER_METADATA_KEY} namespace (added only when non-empty, so the bundled
 * `{ source }`-only seed yields the unchanged `{ fqid, provider, source, resolvedFrom }`
 * envelope). This is the single point at which a {@link ProvenanceSeed} becomes provenance
 * (Req 2.9).
 */
export function finalizeProvenance(resolved: ResolvedSkill, askedRef: SkillRef): Provenance {
  const provenance: Provenance = {
    fqid: resolved.descriptor.fqid,
    provider: resolved.providerId,
    source: resolved.provenanceSeed.source,
    resolvedFrom: askedRef,
  };

  const providerMetadata = sanitizeProvenanceSeed(resolved.provenanceSeed);
  if (providerMetadata !== undefined) {
    provenance[PROVIDER_METADATA_KEY] = providerMetadata;
  }

  return provenance;
}
