/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FQID grammar boundary — the single place that formats and parses Fully-Qualified
 * Skill Ids, and the descriptor identity guard.
 *
 * ─── INTERIM grammar (Requirement 5.8, Milestone 001 §10, design §5) ───────────────
 *
 *   fqid     := provider ":" name ( "@" version )?
 *   provider := segment            ; e.g. "bundled", "npm", "git", "registry.acme"
 *   name     := segment            ; kebab-case skill name
 *   version  := semver | opaque    ; present only when the skill declares a version
 *
 * The interim grammar is chosen to EXACTLY equal what the proven
 * {@link FilesystemSkillProvider} already emits (`${id}:${name}`) and the
 * `fqid.split(':')` parsing it relied on, so promoting that provider onto this module is
 * strictly behavior-preserving. The interim byte bound is {@link FQID_MAX_BYTES}.
 *
 * ─── NON-BLOCKING NOTE — open-item A (final grammar) ───────────────────────────────
 *
 * This is the documented INTERIM placeholder, NOT the final FQID specification. When the
 * final grammar lands (e.g. `provider/collection:name@version` with explicit collision
 * rules), it changes ONLY this module: `formatFqid` / `parseFqid` / `descriptorFqid` are
 * the sole format/parse boundary. Providers and the runtime call this module instead of
 * splitting strings inline, so the migration surface is exactly one file. The pinned
 * manifest may record both the legacy and the new FQID during a transition window so
 * existing provenance references stay resolvable. This note is non-blocking: nothing in
 * this task depends on the final grammar being decided.
 */

import type { SkillDescriptor, SkillRuntimeError } from './contract.js';

/** Parsed components of an FQID under the interim grammar. */
export interface FqidParts {
  provider: string;
  name: string;
  version?: string;
}

/**
 * Interim length bound for an FQID, in UTF-8 bytes (Requirement 5.8, design §5).
 *
 * Chosen to comfortably hold `provider:name@version` for registry URLs without enabling
 * pathological keys. Documented INTERIM value — revisited with the final grammar.
 */
export const FQID_MAX_BYTES = 512;

/**
 * Format an FQID from its parts. Pure function: the same parts always produce the same
 * string, which is the stability invariant the runtime relies on for dedupe and
 * provenance (Requirement 5.4).
 *
 * Emits exactly the proven `${provider}:${name}` shape, with an optional `@version`
 * suffix only when a version is present (matching current bundled behavior, where no
 * version means no suffix).
 */
export function formatFqid(parts: FqidParts): string {
  return parts.version
    ? `${parts.provider}:${parts.name}@${parts.version}`
    : `${parts.provider}:${parts.name}`;
}

/**
 * Parse an FQID into its parts, or return `null` when the string is not a valid interim
 * FQID.
 *
 * INTERIM parser: mirrors the provider's previous `fqid.split(':')` / `('@')` logic so
 * the refactor is behavior-preserving. `provider` is the first colon-delimited segment;
 * the second segment carries `name` with an optional `@version` suffix. A missing
 * provider or name yields `null` (no partial parse).
 */
export function parseFqid(fqid: string): FqidParts | null {
  if (typeof fqid !== 'string' || fqid.length === 0) return null;

  // Mirror the proven `const [prov, name] = fqid.split(':')` shape.
  const colonParts = fqid.split(':');
  if (colonParts.length < 2) return null;

  const provider = colonParts[0];
  const nameAndVersion = colonParts[1];
  if (!provider || !nameAndVersion) return null;

  // Mirror the `@version` split.
  const atIndex = nameAndVersion.indexOf('@');
  if (atIndex === -1) {
    return { provider, name: nameAndVersion };
  }

  const name = nameAndVersion.slice(0, atIndex);
  const version = nameAndVersion.slice(atIndex + 1);
  if (!name || !version) return null;

  return { provider, name, version };
}

/** Identity input for {@link descriptorFqid}: the minimum a descriptor must carry. */
export interface DescriptorIdentity {
  provider?: string;
  name?: string;
  version?: string;
}

/** Result of the no-partial-FQID guard: a minted FQID or a returned error. */
export type DescriptorFqidResult =
  | { ok: true; fqid: string }
  | { ok: false; error: SkillRuntimeError };

/**
 * No-partial-FQID guard (Requirement 5.7).
 *
 * Rejects a descriptor that lacks a `provider` or a `name` (or whose minted FQID exceeds
 * the interim byte bound) with a RETURNED error — never a thrown exception — and mints
 * NO placeholder or partial FQID. On success it returns the stable FQID produced by
 * {@link formatFqid}.
 */
export function descriptorFqid(identity: DescriptorIdentity): DescriptorFqidResult {
  const issues: string[] = [];
  if (!identity.provider) issues.push('descriptor.provider is required to mint an FQID');
  if (!identity.name) issues.push('descriptor.name is required to mint an FQID');
  if (issues.length > 0) {
    // No partial/placeholder FQID is minted: the identity is returned as an error.
    return { ok: false, error: { code: 'bad_request', issues } };
  }

  const fqid = formatFqid({
    provider: identity.provider as string,
    name: identity.name as string,
    version: identity.version,
  });

  const byteLength = Buffer.byteLength(fqid, 'utf8');
  if (byteLength > FQID_MAX_BYTES) {
    return {
      ok: false,
      error: {
        code: 'bad_request',
        issues: [`fqid exceeds interim limit of ${FQID_MAX_BYTES} bytes (got ${byteLength})`],
      },
    };
  }

  return { ok: true, fqid };
}

/**
 * Descriptor identity guard at the provider ingress / resolution boundary
 * (Requirement 5.7, 1.5; design §5 "descriptor guard at registration/resolution").
 *
 * A provider-produced {@link SkillDescriptor} must carry a valid, non-partial identity
 * before the runtime admits it — and, critically, before its `fqid` is used as a
 * dedupe / conflict key. This is a NARROW identity guard only: it checks identity
 * presence and the FQID byte bound, and does NOT sanitize body/content fields (that
 * broader provider-boundary sanitizer is tracked separately), nor does it impose
 * `fqid == provider:name` equality — the runtime treats `fqid` as an opaque, possibly
 * provider-assigned identity key that federation deliberately allows to diverge from
 * `provider:name` (so two providers can collide on one FQID and surface a conflict).
 *
 * Enforced (all returned as `bad_request`, never thrown):
 * - missing `provider` or `name` (Req 5.7) — reuses {@link descriptorFqid} so the
 *   no-partial check and the {@link FQID_MAX_BYTES} bound live in exactly one place;
 * - missing / empty declared `fqid` (Req 1.5 — every runtime-resolved descriptor carries
 *   an FQID);
 * - a declared `fqid` over the {@link FQID_MAX_BYTES} interim bound (oversized identity
 *   key).
 *
 * Returns the {@link SkillRuntimeError} when the descriptor is inadmissible, or `null`
 * when its identity is valid and may be admitted. The bundled provider, which emits
 * `formatFqid({ provider, name })` with non-empty provider/name, passes unchanged.
 */
export function guardDescriptorIdentity(descriptor: SkillDescriptor): SkillRuntimeError | null {
  // Req 5.7: reject a descriptor lacking `provider` or `name`, minting NO placeholder
  // FQID. Delegated to the existing guard so the no-partial rule is not reimplemented.
  const minted = descriptorFqid({ provider: descriptor.provider, name: descriptor.name });
  if (!minted.ok) return minted.error;

  // Req 1.5: a runtime-resolved descriptor must CARRY a non-empty FQID. The declared
  // `fqid` is the runtime's opaque dedupe/identity key (need not equal `provider:name`).
  if (typeof descriptor.fqid !== 'string' || descriptor.fqid.length === 0) {
    return { code: 'bad_request', issues: ['descriptor.fqid is required and must be non-empty'] };
  }

  // Oversized identity key: bound the declared `fqid` by the same interim limit used for a
  // minted FQID, so a pathological dedupe key is rejected rather than admitted.
  const byteLength = Buffer.byteLength(descriptor.fqid, 'utf8');
  if (byteLength > FQID_MAX_BYTES) {
    return {
      code: 'bad_request',
      issues: [`descriptor.fqid exceeds interim limit of ${FQID_MAX_BYTES} bytes (got ${byteLength})`],
    };
  }

  return null;
}
