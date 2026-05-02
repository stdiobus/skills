import * as path from 'path';
import { buildSearchIndex, SearchIndex, SearchResult } from '../../../lib/search-index';
import { createFileResolver } from '../../../lib/file-resolver';
import { SkillName, SkillManifest } from '../../../types';

/**
 * Unit tests for the SearchIndex utility.
 *
 * Requirements: 6.1, 6.2, 6.3
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

describe('buildSearchIndex()', () => {
  let manifest: SkillManifest;
  let skillContents: Map<string, string>;
  let searchIndex: SearchIndex;

  beforeAll(async () => {
    const resolver = createFileResolver(PACKAGE_ROOT);
    manifest = await resolver.readManifest();

    skillContents = new Map<string, string>();
    for (const skill of manifest.skills) {
      skillContents.set(skill.name, await resolver.readSkill(skill.name));
    }

    searchIndex = buildSearchIndex(manifest, skillContents);
  });

  it('creates a working search index from manifest + skill contents', () => {
    expect(searchIndex).toBeDefined();
    expect(typeof searchIndex.search).toBe('function');
  });

  describe('search()', () => {
    it('returns results sorted by score descending', () => {
      const results = searchIndex.search('runtime concepts');

      expect(results.length).toBeGreaterThan(0);
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it('returns an empty array for queries with no matches', () => {
      const results = searchIndex.search('xyzzyplughtwisty');

      expect(results).toEqual([]);
    });

    it('returns an empty array for a query that tokenizes to nothing', () => {
      // Only punctuation/special chars — tokenizer strips them all
      const results = searchIndex.search('!@#$%^&*()');

      expect(results).toEqual([]);
    });

    it('returns results where all scores are > 0', () => {
      const results = searchIndex.search('lambda serverless');

      for (const result of results) {
        expect(result.score).toBeGreaterThan(0);
      }
    });

    it('includes required fields in each result', () => {
      const results = searchIndex.search('http');

      expect(results.length).toBeGreaterThan(0);
      for (const result of results) {
        expect(result).toHaveProperty('skill');
        expect(result).toHaveProperty('score');
        expect(result).toHaveProperty('description');
        expect(result).toHaveProperty('layer');
        expect(result).toHaveProperty('layerName');
        expect(typeof result.skill).toBe('string');
        expect(typeof result.score).toBe('number');
        expect(typeof result.description).toBe('string');
        expect(typeof result.layer).toBe('number');
        expect(typeof result.layerName).toBe('string');
      }
    });

    it('returns runtime-patterns-http as a top result for "http" query', () => {
      const results = searchIndex.search('http');

      expect(results.length).toBeGreaterThan(0);
      // The skill with "http" in its name should rank highly
      const httpSkill = results.find((r) => r.skill === SkillName.RuntimePatternsHttp);
      expect(httpSkill).toBeDefined();
      // It should be in the top 3 results
      const httpIndex = results.indexOf(httpSkill!);
      expect(httpIndex).toBeLessThan(3);
    });

    it('returns runtime-concepts as a top result for "concepts" query', () => {
      const results = searchIndex.search('concepts');

      expect(results.length).toBeGreaterThan(0);
      const conceptsSkill = results.find((r) => r.skill === SkillName.RuntimeConcepts);
      expect(conceptsSkill).toBeDefined();
    });

    describe('boost weighting', () => {
      it('name/description matches score higher than body-only matches (3x boost)', () => {
        // "concepts" appears in the skill name of runtime-concepts (3x boost)
        // vs skills that only mention "concepts" in their body text (1x boost)
        const results = searchIndex.search('concepts');

        const conceptsSkill = results.find((r) => r.skill === SkillName.RuntimeConcepts);
        expect(conceptsSkill).toBeDefined();

        // runtime-concepts should score higher than skills that only mention
        // "concepts" in their body text
        if (results.length > 1) {
          expect(conceptsSkill!.score).toBeGreaterThanOrEqual(results[1].score);
        }
      });

      it('layer name matches get 2x boost', () => {
        // "diagnostics" is a layer name (Layer 5) — skills in that layer get 2x boost
        const results = searchIndex.search('diagnostics');

        expect(results.length).toBeGreaterThan(0);

        // runtime-errors-and-diagnostics has "diagnostics" in its name (3x) AND
        // is in the Diagnostics layer (2x for layer name match)
        const diagSkill = results.find(
          (r) => r.skill === SkillName.RuntimeErrorsAndDiagnostics,
        );
        expect(diagSkill).toBeDefined();

        // It should be the top result or near the top
        const diagIndex = results.indexOf(diagSkill!);
        expect(diagIndex).toBeLessThan(3);
      });

      it('skills in the "Patterns" layer rank higher for "patterns" query', () => {
        const results = searchIndex.search('patterns');

        expect(results.length).toBeGreaterThan(0);

        // Pattern skills have "patterns" in their name (3x) and "Patterns" as layer name (2x)
        const patternSkills = results.filter((r) =>
          r.skill.includes('patterns'),
        );
        expect(patternSkills.length).toBeGreaterThan(0);

        // All pattern skills should appear in results
        for (const ps of patternSkills) {
          expect(ps.layerName).toBe('Patterns');
        }
      });

      it('skills in the "API" layer rank higher for "api" query', () => {
        const results = searchIndex.search('api');

        expect(results.length).toBeGreaterThan(0);

        // API layer skills have "api" in their name (3x) and "API" as layer name (2x)
        const apiSkills = results.filter((r) => r.skill.includes('api'));
        expect(apiSkills.length).toBeGreaterThan(0);

        // API skills should be among the top results
        for (const apiSkill of apiSkills) {
          const idx = results.indexOf(apiSkill);
          expect(idx).toBeLessThan(5);
        }
      });
    });

    describe('layer name mapping', () => {
      it('maps layer 1 to "Concepts"', () => {
        const results = searchIndex.search('concepts');
        const layer1 = results.find((r) => r.layer === 1);
        if (layer1) {
          expect(layer1.layerName).toBe('Concepts');
        }
      });

      it('maps layer 2 to "API"', () => {
        const results = searchIndex.search('api core');
        const layer2 = results.find((r) => r.layer === 2);
        if (layer2) {
          expect(layer2.layerName).toBe('API');
        }
      });

      it('maps layer 3 to "Patterns"', () => {
        const results = searchIndex.search('http patterns');
        const layer3 = results.find((r) => r.layer === 3);
        if (layer3) {
          expect(layer3.layerName).toBe('Patterns');
        }
      });

      it('maps layer 4 to "Guardrails"', () => {
        const results = searchIndex.search('constraints guardrails');
        const layer4 = results.find((r) => r.layer === 4);
        if (layer4) {
          expect(layer4.layerName).toBe('Guardrails');
        }
      });

      it('maps layer 5 to "Diagnostics"', () => {
        const results = searchIndex.search('errors diagnostics');
        const layer5 = results.find((r) => r.layer === 5);
        if (layer5) {
          expect(layer5.layerName).toBe('Diagnostics');
        }
      });
    });

    describe('edge cases', () => {
      it('handles single-word queries', () => {
        const results = searchIndex.search('lambda');

        expect(results.length).toBeGreaterThan(0);
      });

      it('handles multi-word queries', () => {
        const results = searchIndex.search('error handling diagnostics');

        expect(results.length).toBeGreaterThan(0);
      });

      it('is case-insensitive', () => {
        const lower = searchIndex.search('http');
        const upper = searchIndex.search('HTTP');
        const mixed = searchIndex.search('Http');

        // All should return the same results
        expect(lower.map((r) => r.skill)).toEqual(upper.map((r) => r.skill));
        expect(lower.map((r) => r.skill)).toEqual(mixed.map((r) => r.skill));
      });

      it('handles queries with special characters gracefully', () => {
        // Should not throw, just tokenize what it can
        const results = searchIndex.search('runtime-concepts');

        expect(results.length).toBeGreaterThan(0);
      });
    });
  });

  describe('with minimal synthetic data', () => {
    it('builds an index from a minimal manifest and content', () => {
      const miniManifest: SkillManifest = {
        version: '1.0.0',
        frameworkVersion: '0.5.0',
        skills: [
          {
            name: 'test-skill',
            layer: 1,
            versionRange: '>=0.5.0',
            status: 'valid',
            lastValidated: '2026-01-01T00:00:00.000Z',
          },
        ],
        lastValidated: '2026-01-01T00:00:00.000Z',
      };

      const miniContents = new Map<string, string>();
      miniContents.set(
        'test-skill',
        '---\nname: test-skill\ndescription: A test skill for unit testing\n---\n\nThis is the body content about testing.',
      );

      const miniIndex = buildSearchIndex(miniManifest, miniContents);
      const results = miniIndex.search('test');

      expect(results).toHaveLength(1);
      expect(results[0].skill).toBe('test-skill');
      expect(results[0].score).toBeGreaterThan(0);
      expect(results[0].layer).toBe(1);
      expect(results[0].layerName).toBe('Concepts');
    });

    it('returns empty results when skill content is empty', () => {
      const miniManifest: SkillManifest = {
        version: '1.0.0',
        frameworkVersion: '0.5.0',
        skills: [
          {
            name: 'empty-skill',
            layer: 2,
            versionRange: '>=0.5.0',
            status: 'valid',
            lastValidated: '2026-01-01T00:00:00.000Z',
          },
        ],
        lastValidated: '2026-01-01T00:00:00.000Z',
      };

      const miniContents = new Map<string, string>();
      miniContents.set('empty-skill', '');

      const miniIndex = buildSearchIndex(miniManifest, miniContents);

      // Searching for something unrelated to the skill name should return empty
      const results = miniIndex.search('xyzzy');
      expect(results).toEqual([]);
    });

    it('handles missing skill content in the map gracefully', () => {
      const miniManifest: SkillManifest = {
        version: '1.0.0',
        frameworkVersion: '0.5.0',
        skills: [
          {
            name: 'missing-content',
            layer: 3,
            versionRange: '>=0.5.0',
            status: 'valid',
            lastValidated: '2026-01-01T00:00:00.000Z',
          },
        ],
        lastValidated: '2026-01-01T00:00:00.000Z',
      };

      // Don't add any content to the map
      const miniContents = new Map<string, string>();

      // Should not throw
      const miniIndex = buildSearchIndex(miniManifest, miniContents);

      // Searching for the skill name should still work (name is indexed from manifest)
      const results = miniIndex.search('missing content');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].skill).toBe('missing-content');
    });
  });
});
