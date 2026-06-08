/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SearchPresenter — render the published `search_skills` results from an AUTHORITATIVE
 * {@link SkillsRuntime.search} result (federated-skills-runtime — Task 14, Req 9.4, 9.1).
 *
 * ─── Why this exists ────────────────────────────────────────────────────────────────
 *
 * The pre-Task-14 adapter served `search_skills` from a legacy keyword index held as an
 * adapter side-channel (`handleSearchSkills(args, searchIndex)`), BYPASSING the runtime.
 * That made the runtime's federated `search` (cross-provider aggregation, dedupe, conflict
 * surfacing, fallback) unreachable from the product surface and violated Req 9.4. The fix
 * makes the bundled provider's native `search` the keyword index, so `runtime.search()` is
 * authoritative and federation-capable; this presenter maps the runtime result back onto
 * the published `search_skills` result shape, preserving the index ranking.
 *
 * ─── Published result shape ───────────────────────────────────────────────────────────
 *
 * The published `search_skills` result is a JSON array of
 * `{ skill, score, description, layer, layerName }`, score-descending. The runtime
 * {@link SearchResult} carries `{ descriptor, score, description? }`, so this presenter:
 *
 *   - `skill`      ← `descriptor.name`
 *   - `score`      ← `score` (runtime preserves the provider's score ordering)
 *   - `description`← the provider-supplied `description` (frontmatter description), or `''`
 *   - `layer`      ← `descriptor.layer` (bundled skills always carry it)
 *   - `layerName`  ← {@link LAYER_NAMES}[layer] (the SAME mapping the legacy index used)
 *
 * Provenance and aggregate diagnostics computed by the runtime are intentionally NOT
 * surfaced here during the compatibility phase (Req 9.7); only the published result fields
 * are emitted, serialized compactly as `JSON.stringify(results)` (no indentation), matching
 * the pre-migration byte shape.
 */

import { LAYER_NAMES } from './search-index.js';
import type { SearchResult, SkillResponse } from '../runtime/contract.js';
import { describeError, type ToolResult } from './tool-render.js';

/** The published `search_skills` result entry (pre-migration shape). */
export interface PublishedSearchResult {
  skill: string;
  score: number;
  description: string;
  layer: number;
  layerName: string;
}

/**
 * Project a single runtime {@link SearchResult} onto the published result shape, deriving
 * `layerName` from the descriptor's `layer` via the shared {@link LAYER_NAMES} mapping.
 */
function toPublished(result: SearchResult): PublishedSearchResult {
  const layer = result.descriptor.layer ?? 0;
  return {
    skill: result.descriptor.name,
    score: result.score,
    description: result.description ?? '',
    layer,
    layerName: LAYER_NAMES[layer] ?? '',
  };
}

/**
 * Render a `runtime.search()` response into the published `search_skills` MCP tool result.
 *
 * On success, maps each runtime result onto the published shape (preserving the
 * score-descending order the runtime returns) and serializes the array compactly. On a
 * runtime error, renders a typed tool error (`isError: true`) — never throws.
 *
 * @param resp - the authoritative `SkillResponse<SearchResult[]>` from `runtime.search()`.
 */
export function presentSearch(resp: SkillResponse<SearchResult[]>): ToolResult {
  if (!resp.ok) {
    return {
      content: [{ type: 'text', text: `search_skills: ${describeError(resp.error)}` }],
      isError: true,
    };
  }
  const results = resp.data.map(toPublished);
  return { content: [{ type: 'text', text: JSON.stringify(results) }] };
}
