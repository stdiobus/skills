import { handleSearchSkills } from '../../../tools/search-skills';
import type { SearchIndex, SearchResult } from '../../../lib/search-index';

/**
 * Unit tests for the search_skills tool handler.
 * Uses a mocked SearchIndex to test the handler in isolation.
 *
 * Requirements: 6.1, 6.2, 6.4, 6.6, 12.1
 */

const MOCK_RESULTS: SearchResult[] = [
  { skill: 'runtime-concepts', score: 8.5, description: 'Core concepts', layer: 1, layerName: 'Concepts' },
  { skill: 'runtime-lifecycle', score: 5.2, description: 'Lifecycle management', layer: 1, layerName: 'Concepts' },
  { skill: 'runtime-api-core', score: 2.1, description: 'Core API', layer: 2, layerName: 'API' },
];

function createMockSearchIndex(overrides: Partial<SearchIndex> = {}): SearchIndex {
  return {
    search: jest.fn().mockReturnValue(MOCK_RESULTS),
    ...overrides,
  };
}

describe('handleSearchSkills()', () => {
  it('returns results sorted by score descending', async () => {
    const index = createMockSearchIndex();
    const result = await handleSearchSkills({ query: 'concepts' }, index);

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');

    const parsed = JSON.parse(result.content[0].text) as SearchResult[];
    expect(parsed).toHaveLength(3);

    // Verify descending score order
    for (let i = 1; i < parsed.length; i++) {
      expect(parsed[i - 1].score).toBeGreaterThanOrEqual(parsed[i].score);
    }
  });

  it('returns results with all required fields', async () => {
    const index = createMockSearchIndex();
    const result = await handleSearchSkills({ query: 'concepts' }, index);

    const parsed = JSON.parse(result.content[0].text) as SearchResult[];
    for (const entry of parsed) {
      expect(entry).toHaveProperty('skill');
      expect(entry).toHaveProperty('score');
      expect(entry).toHaveProperty('description');
      expect(entry).toHaveProperty('layer');
      expect(entry).toHaveProperty('layerName');
      expect(typeof entry.skill).toBe('string');
      expect(typeof entry.score).toBe('number');
      expect(typeof entry.description).toBe('string');
      expect(typeof entry.layer).toBe('number');
      expect(typeof entry.layerName).toBe('string');
    }
  });

  it('returns the exact results from the search index', async () => {
    const index = createMockSearchIndex();
    const result = await handleSearchSkills({ query: 'concepts' }, index);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(MOCK_RESULTS);
  });

  it('calls search() with the provided query', async () => {
    const mockSearch = jest.fn().mockReturnValue(MOCK_RESULTS);
    const index = createMockSearchIndex({ search: mockSearch });

    await handleSearchSkills({ query: 'lambda handler' }, index);

    expect(mockSearch).toHaveBeenCalledWith('lambda handler');
  });

  it('returns an empty array when no skills match', async () => {
    const index = createMockSearchIndex({
      search: jest.fn().mockReturnValue([]),
    });
    const result = await handleSearchSkills({ query: 'zzzznonexistent' }, index);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual([]);
  });

  it('returns isError: true for an empty query string', async () => {
    const index = createMockSearchIndex();
    const result = await handleSearchSkills({ query: '' }, index);

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('search_skills:');
    expect(result.content[0].text).toContain('non-empty');
  });

  it('returns isError: true for a whitespace-only query string', async () => {
    const index = createMockSearchIndex();
    const result = await handleSearchSkills({ query: '   ' }, index);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('search_skills:');
    expect(result.content[0].text).toContain('non-empty');
  });

  it('does not call search() for an empty query', async () => {
    const mockSearch = jest.fn();
    const index = createMockSearchIndex({ search: mockSearch });

    await handleSearchSkills({ query: '' }, index);

    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('does not call search() for a whitespace-only query', async () => {
    const mockSearch = jest.fn();
    const index = createMockSearchIndex({ search: mockSearch });

    await handleSearchSkills({ query: '  \t\n  ' }, index);

    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('returns results as a JSON string, not pretty-printed', async () => {
    const index = createMockSearchIndex();
    const result = await handleSearchSkills({ query: 'concepts' }, index);

    // JSON.stringify without indentation produces compact output
    const expected = JSON.stringify(MOCK_RESULTS);
    expect(result.content[0].text).toBe(expected);
  });

  it('handles a single-result response', async () => {
    const singleResult: SearchResult[] = [
      { skill: 'runtime-concepts', score: 10.0, description: 'Core concepts', layer: 1, layerName: 'Concepts' },
    ];
    const index = createMockSearchIndex({
      search: jest.fn().mockReturnValue(singleResult),
    });
    const result = await handleSearchSkills({ query: 'concepts' }, index);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].skill).toBe('runtime-concepts');
  });
});
