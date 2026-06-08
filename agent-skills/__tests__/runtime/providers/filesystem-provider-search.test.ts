/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// FilesystemSkillProvider — opt-in native search — federated-skills-runtime, Task 14
//
// Purpose: prove the bundled provider's native keyword search is OPT-IN and backed
//          by the existing search index (the legacy index becomes a provider
//          implementation, not an adapter side-channel).
//
//   1. Default construction keeps `capabilities.search === false` (preserves the
//      runtime fallback path the proven tests rely on).
//   2. `{ search: true }` flips `capabilities.search` on and `search()` returns the
//      runtime SearchResult shape `{ descriptor, score, description }`, score-desc,
//      keyed to bundled FQIDs, with the frontmatter description carried through.
//   3. `limit` caps the result count.
//
// Validates: Requirements 9.4, 9.1
// =============================================================================

import { FilesystemSkillProvider } from '../../../runtime/providers/filesystem-provider';

describe('FilesystemSkillProvider — opt-in native search', () => {
  it('declares search:false by default (runtime fallback preserved)', () => {
    const provider = new FilesystemSkillProvider();
    expect(provider.capabilities.search).toBe(false);
  });

  it('declares search:true when constructed with { search: true }', () => {
    const provider = new FilesystemSkillProvider({ search: true });
    expect(provider.capabilities.search).toBe(true);
  });

  it('native search returns the runtime SearchResult shape, score-descending', async () => {
    const provider = new FilesystemSkillProvider({ search: true });
    const results = await provider.search({ query: 'lambda http api' });

    expect(results.length).toBeGreaterThan(0);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
    for (const r of results) {
      // Bundled identity + carried-through description.
      expect(r.descriptor.provider).toBe('bundled');
      expect(r.descriptor.fqid).toBe(`bundled:${r.descriptor.name}`);
      expect(typeof r.descriptor.name).toBe('string');
      expect(typeof r.score).toBe('number');
      expect(r.score).toBeGreaterThan(0);
      expect(typeof r.description).toBe('string');
    }
  });

  it('honors the limit on the result count', async () => {
    const provider = new FilesystemSkillProvider({ search: true });
    const all = await provider.search({ query: 'runtime' });
    const limited = await provider.search({ query: 'runtime', limit: 1 });

    expect(all.length).toBeGreaterThan(1);
    expect(limited.length).toBe(1);
    // The single limited result is the top-ranked of the full set.
    expect(limited[0].descriptor.name).toBe(all[0].descriptor.name);
  });

  it('returns an empty array for a query with no matches', async () => {
    const provider = new FilesystemSkillProvider({ search: true });
    const results = await provider.search({ query: 'zzzznonexistentquerytoken' });
    expect(results).toEqual([]);
  });
});
