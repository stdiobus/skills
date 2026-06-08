/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// SearchPresenter Tests — federated-skills-runtime, Task 14
//
// Purpose: prove `search_skills` is RUNTIME-AUTHORITATIVE (Req 9.4) while keeping
//          the published result shape `{skill,score,description,layer,layerName}`
//          and ranking (Req 9.1).
//
//   1. presentSearch over a REAL runtime.search() (bundled native keyword index)
//      yields the published result shape, score-descending, with real descriptions
//      and layer/layerName.
//   2. The mapping preserves order, derives layerName from layer, and defaults a
//      missing description to ''.
//   3. A runtime error renders a typed tool error (isError), never throws.
//
// The runtime is wired EXACTLY as the bundled adapter wires it (registry ->
// in-process runtime over the search-enabled FilesystemSkillProvider).
//
// Validates: Requirements 9.4, 9.1
// =============================================================================

import { createFileResolver } from '../../../lib/file-resolver';
import { presentSearch, type PublishedSearchResult } from '../../../lib/search-presenter';
import { LAYER_NAMES } from '../../../lib/search-index';
import { FilesystemSkillProvider } from '../../../runtime/providers/filesystem-provider';
import { SkillProviderRegistry, createRuntimeFromRegistry } from '../../../runtime/registry';
import { bundledTrustPolicy } from '../../../runtime/trust';
import type { SearchResult, SkillResponse } from '../../../runtime/contract';

function makeBundledRuntime() {
  const resolver = createFileResolver();
  const provider = new FilesystemSkillProvider({ search: true });
  const registry = new SkillProviderRegistry([
    { provider, trust: bundledTrustPolicy(resolver.packageRoot) },
  ]);
  return createRuntimeFromRegistry({ kind: 'in-process' }, registry);
}

describe('presentSearch — runtime-authoritative search_skills (Req 9.4, 9.1)', () => {
  it('renders the published result shape from a real runtime.search()', async () => {
    const runtime = makeBundledRuntime();
    const resp = await runtime.search({ query: 'lambda http api' });
    expect(resp.ok).toBe(true);

    const result = presentSearch(resp);
    expect(result.isError).toBeFalsy();

    const results = JSON.parse(result.content[0].text) as PublishedSearchResult[];
    expect(results.length).toBeGreaterThan(0);

    // Score-descending order preserved.
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }

    // Every entry carries the published fields with correct types.
    for (const r of results) {
      expect(typeof r.skill).toBe('string');
      expect(typeof r.score).toBe('number');
      expect(r.score).toBeGreaterThan(0);
      expect(typeof r.description).toBe('string');
      expect(typeof r.layer).toBe('number');
      expect(typeof r.layerName).toBe('string');
      expect(r.layerName).toBe(LAYER_NAMES[r.layer] ?? '');
    }
  });

  it('proves the result rode the native search path (not the list+substring fallback)', async () => {
    const runtime = makeBundledRuntime();
    const resp = await runtime.search({ query: 'concepts' });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    // The bundled provider's native search is used (id "bundled"), so the source reflects
    // a native search rather than the documented fallback.
    expect(resp.provenance.source).toBe('search:native');
  });

  it('an empty result set renders an empty JSON array', () => {
    const resp: SkillResponse<SearchResult[]> = {
      ok: true,
      data: [],
      provenance: { fqid: '*', provider: 'bundled', source: 'search:native' },
    };
    const result = presentSearch(resp);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual([]);
  });

  it('maps fields, derives layerName from layer, and defaults missing description to ""', () => {
    const resp: SkillResponse<SearchResult[]> = {
      ok: true,
      data: [
        { descriptor: { fqid: 'p:a', name: 'a', provider: 'p', source: 's', layer: 2 }, score: 9, description: 'desc-a' },
        { descriptor: { fqid: 'p:b', name: 'b', provider: 'p', source: 's', layer: 5 }, score: 3 },
      ],
      provenance: { fqid: '*', provider: 'p', source: 'search:native' },
    };
    const results = JSON.parse(presentSearch(resp).content[0].text) as PublishedSearchResult[];
    expect(results).toEqual([
      { skill: 'a', score: 9, description: 'desc-a', layer: 2, layerName: LAYER_NAMES[2] },
      { skill: 'b', score: 3, description: '', layer: 5, layerName: LAYER_NAMES[5] },
    ]);
  });

  it('renders a typed tool error on a runtime error response (never throws)', () => {
    const resp: SkillResponse<SearchResult[]> = {
      ok: false,
      error: { code: 'unsupported', capability: 'search' },
    };
    const result = presentSearch(resp);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('search_skills:');
    expect(result.content[0].text).toContain('not supported');
  });
});
