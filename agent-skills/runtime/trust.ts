/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Interim two-tier trust policy (Migration Step 7 — design §9, open-item E; Req 11.1).
 *
 * This module fills the forward `trust?` seam declared by Task 4.2 in
 * {@link ./registry.ts}. It defines:
 *
 *   - the concrete {@link TrustPolicy} type carried by a provider registration,
 *   - the least-privileged {@link UNTRUSTED_DEFAULT} applied when no policy is given
 *     (Req 11.1: absent policy → untrusted default),
 *   - a {@link bundledTrustPolicy} helper that builds the `trusted` policy the bundled
 *     filesystem provider registers with,
 *   - {@link resolveTrustPolicy}, which resolves an absent seed to the untrusted default,
 *   - {@link mayPromoteClassification}, the pure Req 11.6 guard that keeps an untrusted
 *     provider's classification non-authoritative unless explicitly pinned/persisted
 *     (added by Task 9.3; consumed by the classification path in Task 10).
 *
 * ─── SCOPE: TYPE + DEFAULTS + RESOLUTION + POLICY PREDICATES ───────────────────────
 *
 * This module defines the policy shape, the documented interim defaults, the
 * absent → untrusted resolution rule, and pure trust-policy PREDICATES
 * ({@link mayPromoteClassification}). It deliberately implements **no enforcement that
 * touches content or the filesystem**: path-traversal / content-size checks (Task 9.2) and
 * the isolation admission predicate (Task 9.3, {@link checkIsolation} in
 * `./security/boundary.js`) consume this policy but live in the security boundary module.
 * Nothing here reads provider content, resolves paths, or admits/rejects content.
 *
 * ─── INTERIM (open-item E) ─────────────────────────────────────────────────────────
 *
 * {@link TrustTier} is an INTERIM two-tier model. The migration path (design "Open Items
 * as Design Proposals", item E) expands it to a richer lattice
 * (e.g. `first-party` / `verified` / `community` / `untrusted`) with capability-scoped
 * permissions. {@link TrustPolicy} is the single extension point: that expansion changes
 * only this module — registrations keep carrying a `TrustPolicy`, so the registry seam
 * and call sites do not change.
 */

/**
 * INTERIM trust tier (open-item E).
 *
 * - `untrusted` — the least-privileged default for any provider whose trust is unspecified
 *   (Req 11.1). Its content is treated as data, fetched under isolation, and never promoted
 *   to authoritative status without explicit pinning/persistence (enforced by Task 9.3).
 * - `trusted` — first-party providers (today: the bundled filesystem provider) whose content
 *   is already part of the published surface.
 *
 * The final model expands this union to a richer lattice via {@link TrustPolicy} (open-item E).
 */
export type TrustTier = 'trusted' | 'untrusted';

/**
 * Trust metadata attached to a provider registration (design §9).
 *
 * The runtime's security boundary (Tasks 9.2 / 9.3) reads these fields; this module only
 * defines them and supplies defaults.
 */
export interface TrustPolicy {
  /** Trust tier. Absent registration → {@link UNTRUSTED_DEFAULT} (Req 11.1). */
  tier: TrustTier;
  /**
   * Maximum content size, in bytes, the provider may contribute. Content exceeding this is
   * rejected with `content_too_large` and not loaded in full (enforcement in Task 9.2,
   * Req 11.5). The concrete value is deployment/profile policy; the constants below are
   * documented INTERIM defaults.
   */
  maxContentBytes: number;
  /**
   * Whether `fetch`/`add` from this provider must run under the configured isolation /
   * content-safety boundary before content is admitted to trusted state (enforcement in
   * Task 9.3, Req 11.2). The out-of-process stdio Bus worker may serve as that boundary.
   */
  isolateFetch: boolean;
  /**
   * The provider's permitted source root. A source/reference path resolving outside this
   * root is rejected with `out_of_bounds` and not read (enforcement in Task 9.2, Req 11.4).
   * Optional: when absent, the boundary falls back to the provider's own resolver guard.
   */
  permittedRoot?: string;
}

/**
 * INTERIM content-size default for untrusted providers: 1,000,000 bytes (~1 MB).
 *
 * Chosen to comfortably hold a large SKILL.md / reference document while bounding a
 * pathological untrusted contribution. This is a documented interim/policy value
 * (Req 11.5: "the default maximum size remains deployment/profile policy"), not a frozen
 * decision; deployment/profile config may override it.
 */
export const UNTRUSTED_MAX_CONTENT_BYTES = 1_000_000;

/**
 * INTERIM content-size default for trusted providers: 10,000,000 bytes (~10 MB).
 *
 * Trusted (first-party) content is already part of the published surface, so the bound is
 * more permissive than the untrusted default while still finite. Interim/policy value.
 */
export const TRUSTED_MAX_CONTENT_BYTES = 10_000_000;

/**
 * The least-privileged default policy applied when a registration specifies no trust
 * (Req 11.1). Untrusted tier, the untrusted size bound, and isolation ON.
 *
 * Frozen so callers cannot mutate the shared default; {@link resolveTrustPolicy} returns it
 * directly for the absent case.
 */
export const UNTRUSTED_DEFAULT: Readonly<TrustPolicy> = Object.freeze({
  tier: 'untrusted',
  maxContentBytes: UNTRUSTED_MAX_CONTENT_BYTES,
  isolateFetch: true,
});

/**
 * Build the `trusted` policy for a first-party provider (today: the bundled filesystem
 * provider). Trusted tier, the permissive trusted size bound, and isolation OFF (first-party
 * content is not run through the untrusted-fetch sandbox).
 *
 * @param permittedRoot - optional source root for the provider (e.g. the package root).
 *   When supplied, it is recorded for the path boundary (Task 9.2); when omitted, the
 *   boundary falls back to the provider's own resolver guard.
 * @returns a fresh, mutable {@link TrustPolicy} (callers may further tailor it before use).
 */
export function bundledTrustPolicy(permittedRoot?: string): TrustPolicy {
  return {
    tier: 'trusted',
    maxContentBytes: TRUSTED_MAX_CONTENT_BYTES,
    isolateFetch: false,
    ...(permittedRoot !== undefined ? { permittedRoot } : {}),
  };
}

/**
 * Resolve a provider registration's (optional) trust seed to an effective {@link TrustPolicy}.
 *
 * Absent seed → the least-privileged {@link UNTRUSTED_DEFAULT} (Req 11.1). A supplied policy
 * is returned as-is; this function applies no enforcement and does not mutate its input.
 *
 * @param seed - the registration's `trust` value, or `undefined` when omitted.
 * @returns the effective trust policy (never `undefined`).
 */
export function resolveTrustPolicy(seed?: TrustPolicy): TrustPolicy {
  return seed ?? UNTRUSTED_DEFAULT;
}

/**
 * Classification-promotion guard (Req 11.6; design §9; shared mechanism with Req 7.4/8.8).
 *
 * Decides whether a provider's classification metadata (layer/category) — including a hint
 * produced by the assistive `classify` path (Task 10) — may be promoted to AUTHORITATIVE
 * registry status. The rule:
 *
 * - a `trusted` provider's classification MAY be promoted;
 * - an `untrusted` provider's classification MAY be promoted ONLY when it is explicitly
 *   `pinned` or `persisted`; otherwise it stays assistive and is NOT written to
 *   authoritative metadata (Req 11.6).
 *
 * This is a pure policy predicate (no I/O, no enforcement side effects). It is consumed by
 * the classification path in Task 10 (and mirrors the pinned-precedence rule of Req 7.7 /
 * 8.8): pinning/persistence is the ONLY way an untrusted provider's inferred classification
 * becomes authoritative — embedded skill content can never grant that authority on its own
 * (untrusted-as-data, Req 11.7).
 *
 * @param policy - the (effective) trust policy of the classifying provider.
 * @param opts.pinned - whether the skill is an explicit pinned-subset member.
 * @param opts.persisted - whether the classification has been explicitly persisted.
 * @returns `true` when the classification may become authoritative, else `false`.
 */
export function mayPromoteClassification(
  policy: TrustPolicy,
  opts: { pinned: boolean; persisted: boolean },
): boolean {
  if (policy.tier === 'trusted') return true;
  return opts.pinned || opts.persisted;
}
