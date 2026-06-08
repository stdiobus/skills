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
 * ─── Compatibility-phase scope ───────────────────────────────────────────────────────
 *
 * A federated (non-bundled) descriptor has no manifest entry and is NOT representable in
 * the published manifest-document shape (it lacks `versionRange`/`status`/…). During the
 * compatibility phase such names are SKIPPED rather than synthesized, so the published
 * document stays well-formed and byte-stable (Req 9.8). Surfacing federated skills at the
 * MCP level is a future, declared staged change (Req 9.9), out of scope here. Provenance
 * and aggregate diagnostics computed by the runtime are intentionally NOT surfaced at the
 * MCP response level during the compatibility phase (Req 9.7).
 */

import type { SkillManifest } from '../types.js';
import type { SkillDescriptor, SkillResponse } from '../runtime/contract.js';
import { describeError, type ToolResult } from './tool-render.js';

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

  // Index the published entries by name so each authoritative descriptor is rendered as
  // its VERBATIM manifest entry (preserving every registry field byte-for-byte).
  const entryByName = new Map(manifest.skills.map((s) => [s.name, s]));

  // Authoritative membership + order come from the runtime; only names that have a
  // published manifest entry are representable in the manifest-document shape.
  const skills = resp.data
    .map((descriptor) => entryByName.get(descriptor.name))
    .filter((entry): entry is SkillManifest['skills'][number] => entry !== undefined);

  // Preserve the manifest document's key order (version, frameworkVersion, skills,
  // lastValidated); overriding `skills` in place keeps its original position so the
  // serialization is byte-identical when all published skills are listed.
  const document: SkillManifest = { ...manifest, skills };

  return { content: [{ type: 'text', text: JSON.stringify(document, null, 2) }] };
}
