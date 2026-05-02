import * as path from 'path';
import * as fc from 'fast-check';
import { createFileResolver } from '../../../lib/file-resolver';
import { buildSearchIndex, SearchIndex, SearchResult } from '../../../lib/search-index';
import { handleSearchSkills } from '../../../tools/search-skills';
import { SkillName } from '../../../types';
import type { SkillManifest } from '../../../types';

/**
 * Property-based tests for search result ordering.
 *
 * Feature: mcp-skills-server, Property 6
 *
 * Property 6: Search result ordering
 *   For any non-empty query string, results from `search_skills` are sorted
 *   by `score` in strictly non-increasing order, and every result has
 *   `score > 0`.
 *   Validates: Requirements 6.1, 6.2, 12.7
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const VALID_SKILL_NAMES = Object.values(SkillName) as string[];

// Arbitrary for non-empty query strings using alphanumeric + common chars
const queryArb = fc.stringOf(
  fc.constantFrom(
    ...'abcdefghijklmnopqrstuvwxyz0123456789- '.split(''),
  ),
  { minLength: 1, maxLength: 50 },
).filter((s) => s.trim().length > 0);

describe('Property 6: Search result ordering', () => {
  let searchIndex: SearchIndex;
  let manifest: SkillManifest;

  beforeAll(async () => {
    const resolver = createFileResolver(PACKAGE_ROOT);
    manifest = await resolver.readManifest();

    // Pre-load all SKILL.md content for the search index
    const skillContents = new Map<string, string>();
    for (const skill of manifest.skills) {
      skillContents.set(skill.name, await resolver.readSkill(skill.name));
    }
    searchIndex = buildSearchIndex(manifest, skillContents);
  });

  it('results are sorted by score in non-increasing order and every score > 0', async () => {
    await fc.assert(
      fc.asyncProperty(queryArb, async (query) => {
        const result = await handleSearchSkills({ query }, searchIndex);

        expect(result.isError).toBeUndefined();
        const results: SearchResult[] = JSON.parse(result.content[0].text);

        // Every result must have score > 0
        for (const r of results) {
          expect(r.score).toBeGreaterThan(0);
        }

        // Results must be sorted by score in non-increasing (descending) order
        for (let i = 1; i < results.length; i++) {
          expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('results contain required fields: skill, score, description, layer, layerName', async () => {
    await fc.assert(
      fc.asyncProperty(queryArb, async (query) => {
        const result = await handleSearchSkills({ query }, searchIndex);
        const results: SearchResult[] = JSON.parse(result.content[0].text);

        for (const r of results) {
          expect(r).toHaveProperty('skill');
          expect(r).toHaveProperty('score');
          expect(r).toHaveProperty('description');
          expect(r).toHaveProperty('layer');
          expect(r).toHaveProperty('layerName');
          expect(typeof r.skill).toBe('string');
          expect(typeof r.score).toBe('number');
          expect(typeof r.description).toBe('string');
          expect(typeof r.layer).toBe('number');
          expect(typeof r.layerName).toBe('string');
        }
      }),
      { numRuns: 100 },
    );
  });

  it('searching for a known skill name returns that skill in results', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...VALID_SKILL_NAMES),
        async (skillName) => {
          // Use the skill name as the query (replacing hyphens with spaces)
          const query = skillName.replace(/-/g, ' ');
          const result = await handleSearchSkills({ query }, searchIndex);
          const results: SearchResult[] = JSON.parse(result.content[0].text);

          // The queried skill should appear in results
          const matchingSkills = results.map((r) => r.skill);
          expect(matchingSkills).toContain(skillName);
        },
      ),
      { numRuns: 100 },
    );
  });
});
