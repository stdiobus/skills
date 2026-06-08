/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pinned subset — the currently published collection, expressed as pinned
 * {@link SkillDescriptor}s in the registry (Requirement 1.7, 9.3; design §6).
 *
 * The published collection is seeded from the existing {@link SkillName} enum plus
 * `skills-manifest.json`. Pinning keeps published names resolvable for backward
 * compatibility and lets pinned layer/category override inference (Req 1.7, 7.7, 8.8).
 *
 * ─── SkillName is a SEED, never a resolution gate ──────────────────────────────────
 *
 * {@link SkillName} is used here ONLY to select which manifest skills belong to the
 * published pinned subset during migration. It is deliberately NOT consulted as an
 * allow-list during runtime resolution: open-world resolution computes addressable
 * skills from registered providers, and an unknown `name` is valid input that resolves
 * to candidates or `not_found` — never rejected on the basis of enum membership
 * (Req 1.3, 1.6). This module only marks the published descriptors as `pinned`.
 *
 * ─── NON-BLOCKING NOTE — open-item A (final FQID grammar) ──────────────────────────
 *
 * Pinned descriptors mint their FQID through the single grammar boundary
 * ({@link formatFqid}), so they inherit the interim grammar without any local string
 * formatting. When the final FQID grammar lands (open-item A, design §5), only `fqid.ts`
 * changes; the pinned manifest may record BOTH the legacy and the new FQID during a
 * transition window so existing provenance references stay resolvable. Nothing in this
 * module depends on the final grammar being decided.
 */

import type { SkillDescriptor } from './contract.js';
import { formatFqid } from './fqid.js';
import { SkillName, type SkillManifest } from '../types.js';

/** Provider id used for the bundled, published collection. */
const BUNDLED_PROVIDER = 'bundled';

/**
 * Build the pinned descriptors for the published collection.
 *
 * Filters `manifest.skills` to the published {@link SkillName} set and produces, for each
 * match, a {@link SkillDescriptor} with `provider: 'bundled'`, an FQID minted via
 * {@link formatFqid}, the `layer` carried from the manifest, and `pinned: true`. The
 * `source` matches the bundled filesystem provider's emission
 * (`agent-skills/${name}/SKILL.md`) so pinned descriptors are identical to what the
 * provider resolves for the same skill.
 *
 * @param manifest - the bundled skills manifest (`skills-manifest.json`).
 * @returns one pinned descriptor per published manifest skill, in manifest order.
 */
export function pinnedDescriptors(manifest: SkillManifest): SkillDescriptor[] {
  // Same members as before migration (Req 9.3) — seed only, not a resolution gate.
  const published = new Set<string>(Object.values(SkillName));

  return manifest.skills
    .filter((skill) => published.has(skill.name))
    .map((skill) => ({
      fqid: formatFqid({ provider: BUNDLED_PROVIDER, name: skill.name }),
      name: skill.name,
      provider: BUNDLED_PROVIDER,
      source: `agent-skills/${skill.name}/SKILL.md`,
      layer: skill.layer,
      pinned: true,
    }));
}
