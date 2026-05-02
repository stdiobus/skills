import { handleListSkills } from '../../../tools/list-skills';
import type { FileResolver } from '../../../lib/file-resolver';
import type { SkillManifest } from '../../../types';

/**
 * Unit tests for the list_skills tool handler.
 * Uses a mocked FileResolver to test the handler in isolation.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 12.1
 */

/** A sample manifest with 12 skill entries for testing. */
const MOCK_MANIFEST: SkillManifest = {
  version: '1.0.0',
  frameworkVersion: '0.5.0-beta.2',
  skills: [
    { name: 'runtime-concepts', layer: 1, versionRange: '>=0.5.0 <1.0.0', status: 'valid', lastValidated: '2026-01-01T00:00:00Z' },
    { name: 'runtime-lifecycle', layer: 1, versionRange: '>=0.5.0 <1.0.0', status: 'valid', lastValidated: '2026-01-01T00:00:00Z' },
    { name: 'runtime-api-core', layer: 2, versionRange: '>=0.5.0 <1.0.0', status: 'valid', lastValidated: '2026-01-01T00:00:00Z' },
    { name: 'runtime-api-integrations', layer: 2, versionRange: '>=0.5.0 <1.0.0', status: 'valid', lastValidated: '2026-01-01T00:00:00Z' },
    { name: 'runtime-patterns-http', layer: 3, versionRange: '>=0.5.0 <1.0.0', status: 'valid', lastValidated: '2026-01-01T00:00:00Z' },
    { name: 'runtime-patterns-async', layer: 3, versionRange: '>=0.5.0 <1.0.0', status: 'valid', lastValidated: '2026-01-01T00:00:00Z' },
    { name: 'runtime-patterns-data-events', layer: 3, versionRange: '>=0.5.0 <1.0.0', status: 'valid', lastValidated: '2026-01-01T00:00:00Z' },
    { name: 'runtime-ssr-and-web', layer: 3, versionRange: '>=0.5.0 <1.0.0', status: 'valid', lastValidated: '2026-01-01T00:00:00Z' },
    { name: 'runtime-constraints-and-guardrails', layer: 4, versionRange: '>=0.5.0 <1.0.0', status: 'valid', lastValidated: '2026-01-01T00:00:00Z' },
    { name: 'runtime-errors-and-diagnostics', layer: 5, versionRange: '>=0.5.0 <1.0.0', status: 'valid', lastValidated: '2026-01-01T00:00:00Z' },
    { name: 'runtime-versioning-and-migration', layer: 5, versionRange: '>=0.5.0 <1.0.0', status: 'valid', lastValidated: '2026-01-01T00:00:00Z' },
    { name: 'runtime-validation-and-ci', layer: 5, versionRange: '>=0.5.0 <1.0.0', status: 'valid', lastValidated: '2026-01-01T00:00:00Z' },
  ],
  lastValidated: '2026-01-01T00:00:00Z',
};

function createMockResolver(overrides: Partial<FileResolver> = {}): FileResolver {
  return {
    packageRoot: '/mock/root',
    readManifest: jest.fn().mockResolvedValue(MOCK_MANIFEST),
    readSkill: jest.fn(),
    listReferences: jest.fn(),
    readReference: jest.fn(),
    ...overrides,
  };
}

describe('handleListSkills()', () => {
  it('returns the full manifest as JSON text in MCP result format', async () => {
    const resolver = createMockResolver();
    const result = await handleListSkills(resolver);

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(MOCK_MANIFEST);
  });

  it('returns a response containing all 12 skill entries', async () => {
    const resolver = createMockResolver();
    const result = await handleListSkills(resolver);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.skills).toHaveLength(12);
  });

  it('includes required fields for each skill entry', async () => {
    const resolver = createMockResolver();
    const result = await handleListSkills(resolver);

    const parsed = JSON.parse(result.content[0].text) as SkillManifest;
    for (const skill of parsed.skills) {
      expect(skill).toHaveProperty('name');
      expect(skill).toHaveProperty('layer');
      expect(skill).toHaveProperty('versionRange');
      expect(skill).toHaveProperty('status');
      expect(skill).toHaveProperty('lastValidated');
    }
  });

  it('returns pretty-printed JSON (indented with 2 spaces)', async () => {
    const resolver = createMockResolver();
    const result = await handleListSkills(resolver);

    const expected = JSON.stringify(MOCK_MANIFEST, null, 2);
    expect(result.content[0].text).toBe(expected);
  });

  it('returns isError: true when readManifest() throws', async () => {
    const resolver = createMockResolver({
      readManifest: jest.fn().mockRejectedValue(new Error('ENOENT: file not found')),
    });
    const result = await handleListSkills(resolver);

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('list_skills:');
    expect(result.content[0].text).toContain('ENOENT: file not found');
  });

  it('returns isError: true with stringified error for non-Error throws', async () => {
    const resolver = createMockResolver({
      readManifest: jest.fn().mockRejectedValue('unexpected string error'),
    });
    const result = await handleListSkills(resolver);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('list_skills:');
    expect(result.content[0].text).toContain('unexpected string error');
  });

  it('calls readManifest() exactly once', async () => {
    const mockReadManifest = jest.fn().mockResolvedValue(MOCK_MANIFEST);
    const resolver = createMockResolver({ readManifest: mockReadManifest });

    await handleListSkills(resolver);

    expect(mockReadManifest).toHaveBeenCalledTimes(1);
  });
});
