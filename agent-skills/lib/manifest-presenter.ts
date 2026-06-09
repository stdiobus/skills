/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ManifestPresenter — render the published `list_skills` document from an AUTHORITATIVE
 * {@link SkillsRuntime.list} result (federated-skills-runtime — Task 14, Req 9.4, 9.8).
 *
 * ─── Why this exists ────────────────────────────────────────────────────────────────
 *
 * The pre-Task-14 adapter served `list_skills` by reading the manifest directly
 * (`handleListSkills(resolver)`), BYPASSING the runtime. That made the runtime's federated
 * `list` (aggregation, provenance, conflict surfacing, partial-failure resilience)
 * unreachable from the product surface and violated Req 9.4 ("delegate every tool to the
 * SkillsRuntime"). This presenter closes that gap: the adapter calls `runtime.list()` and
 * passes the result here, so the runtime is authoritative for WHICH skills (and in what
 * order) the list contains.
 *
 * ─── Published manifest-document shape (Req 9.8) ─────────────────────────────────────
 *
 * `list_skills` is the published *manifest registry document* contract — the whole
 * {@link SkillManifest} (`version`, `frameworkVersion`, `skills[]`, `lastValidated`),
 * serialized as `JSON.stringify(manifest, null, 2)` — NOT the runtime's `SkillDescriptor[]`.
 * The runtime descriptor is intentionally lossy (it carries identity, not the registry
 * metadata `versionRange` / `status` / `lastValidated` / `collection`), so this presenter
 * reconstructs the document by:
 *
 *   1. taking the AUTHORITATIVE set + order of skill names from `runtime.list()`, and
 *   2. emitting, for each authoritative name, the VERBATIM manifest entry for that name.
 *
 * Because the bundled provider lists exactly the manifest skills in manifest order, the
 * reconstructed `skills[]` is byte-for-byte identical to the on-disk manifest, keeping the
 * backward-compatibility suite (Task 5.1) green while routing through the runtime.
 *
 * ─── Admitted (federated, non-bundled) skills (provider-boundary Req 16.3) ───────────
 *
 * An admitted external descriptor has NO published manifest entry (it lacks
 * `versionRange`/`status`/…), but provider-boundary Req 16.3 requires it to be DISCOVERABLE
 * via `list_skills` on the same running instance (it is materialized in the same runtime the
 * read tools serve — Req 16.6). Provider-boundary Req 16 supersedes the earlier
 * federated-skills-runtime compatibility-phase decision (Req 9.9) that SKIPPED such names.
 *
 * Therefore a non-manifest descriptor is now rendered as a SYNTHESIZED, honest minimal entry
 * (see {@link synthesizeAdmittedEntry}) rather than dropped: its `name` and originating
 * `provider` are surfaced, with `status: 'admitted'` (NOT faked as a CI-`valid` bundled
 * skill) and the registry-only fields (`versionRange`/`lastValidated`) left empty because an
 * external provider supplies none. Bundled descriptors are still rendered as their VERBATIM
 * manifest entry, so when nothing is admitted the document is byte-for-byte identical to the
 * on-disk manifest (the backward-compatibility baseline, Req 15.2, stays green). Provenance
 * and aggregate diagnostics are still NOT surfaced at the MCP level (Req 9.7).
 */

import type { Skill, SkillManifest } from '../types.js';
import type { SkillDescriptor, SkillResponse } from '../runtime/contract.js';
import { describeError, type ToolResult } from './tool-render.js';

/**
 * Synthesize a published manifest entry for an ADMITTED (non-bundled) skill that has no
 * on-disk manifest record (provider-boundary Req 16.3).
 *
 * The entry is HONEST about provenance — it never fakes the bundled CI metadata:
 *   - `name`          ← the descriptor's name (the agent addresses it by this);
 *   - `collection`    ← the owning `provider` id, so admitted skills are grouped/identifiable;
 *   - `layer`         ← the descriptor's `layer` if it declared one, else `0` (unlayered);
 *   - `status`        ← `'admitted'` (distinct from a bundled `'valid'`/`'stable'` skill);
 *   - `versionRange`  ← `''` (an external provider declares none in this milestone);
 *   - `lastValidated` ← `''` (never validated by this package's CI).
 */
function synthesizeAdmittedEntry(descriptor: SkillDescriptor): Skill {
  return {
    name: descriptor.name,
    collection: descriptor.provider,
    layer: descriptor.layer ?? 0,
    versionRange: '',
    status: 'admitted',
    lastValidated: '',
  };
}

/**
 * Render a `runtime.list()` response into the published `list_skills` MCP tool result.
 *
 * On success, reconstructs the manifest document with `skills[]` restricted (and ordered)
 * to the runtime's authoritative descriptors, each rendered as its verbatim manifest entry,
 * and serialized as the pre-migration `JSON.stringify(doc, null, 2)`. On a runtime error,
 * renders a typed tool error (`isError: true`) — never throws.
 *
 * @param resp - the authoritative `SkillResponse<SkillDescriptor[]>` from `runtime.list()`.
 * @param manifest - the published manifest registry document (source for entry metadata).
 */
export function presentManifest(
  resp: SkillResponse<SkillDescriptor[]>,
  manifest: SkillManifest,
): ToolResult {
  if (!resp.ok) {
    return {
      content: [{ type: 'text', text: `list_skills: ${describeError(resp.error)}` }],
      isError: true,
    };
  }

  // Index the published entries by name so each bundled descriptor is rendered as its
  // VERBATIM manifest entry (preserving every registry field byte-for-byte).
  const entryByName = new Map(manifest.skills.map((s) => [s.name, s]));

  // Authoritative membership + order come from the runtime. A bundled descriptor renders as
  // its verbatim manifest entry; an admitted (non-manifest) descriptor renders as a
  // synthesized honest entry (provider-boundary Req 16.3) instead of being dropped. Because
  // the bundled provider lists exactly the manifest skills in manifest order and admitted
  // entries are appended in the runtime's federated order, the document is byte-for-byte
  // identical to the on-disk manifest whenever nothing is admitted (Req 15.2).
  const skills = resp.data.map(
    (descriptor) => entryByName.get(descriptor.name) ?? synthesizeAdmittedEntry(descriptor),
  );

  // Preserve the manifest document's key order (version, frameworkVersion, skills,
  // lastValidated); overriding `skills` in place keeps its original position so the
  // serialization is byte-identical when all published skills are listed.
  const document: SkillManifest = { ...manifest, skills };

  return { content: [{ type: 'text', text: JSON.stringify(document, null, 2) }] };
}
