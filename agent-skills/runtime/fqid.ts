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

import type { SkillRuntimeError } from './contract.js';

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
