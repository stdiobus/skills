import { handleListReferences } from '../../../tools/list-references';
import { SkillName } from '../../../types';
import type { FileResolver } from '../../../lib/file-resolver';

/**
 * Unit tests for the list_references tool handler.
 * Uses a mocked FileResolver to test the handler in isolation.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 12.1
 */

const MOCK_REFERENCES = ['common-mistakes.md', 'templates/sqs-worker.ts', 'templates/sns-pubsub.ts'];

function createMockResolver(overrides: Partial<FileResolver> = {}): FileResolver {
  return {
    packageRoot: '/mock/root',
    readManifest: jest.fn(),
    readSkill: jest.fn(),
    listReferences: jest.fn().mockResolvedValue(MOCK_REFERENCES),
    readReference: jest.fn(),
    ...overrides,
  };
}

describe('handleListReferences()', () => {
  it('returns a JSON array of reference paths for a valid skill', async () => {
    const resolver = createMockResolver();
    const result = await handleListReferences({ skill: SkillName.RuntimePatternsAsync }, resolver);

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');

    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual(MOCK_REFERENCES);
  });

  it('excludes .gitkeep files from results (handled by FileResolver)', async () => {
    // The handler delegates filtering to FileResolver.listReferences(),
    // so we verify the handler passes through the resolver's result as-is
    const refsWithoutGitkeep = ['domain-model.md', 'type-signatures.md'];
    const resolver = createMockResolver({
      listReferences: jest.fn().mockResolvedValue(refsWithoutGitkeep),
    });
    const result = await handleListReferences({ skill: SkillName.RuntimeConcepts }, resolver);

    const parsed = JSON.parse(result.content[0].text);
    for (const ref of parsed) {
      expect(ref).not.toBe('.gitkeep');
    }
  });

  it('includes nested subdirectory paths with relative path preserved', async () => {
    const resolver = createMockResolver();
    const result = await handleListReferences({ skill: SkillName.RuntimePatternsAsync }, resolver);

    const parsed = JSON.parse(result.content[0].text) as string[];
    const nestedPaths = parsed.filter((p) => p.includes('/'));
    expect(nestedPaths.length).toBeGreaterThan(0);
    expect(parsed).toContain('templates/sqs-worker.ts');
    expect(parsed).toContain('templates/sns-pubsub.ts');
  });

  it('returns an empty JSON array when no references exist', async () => {
    const resolver = createMockResolver({
      listReferences: jest.fn().mockResolvedValue([]),
    });
    const result = await handleListReferences({ skill: SkillName.RuntimeConcepts }, resolver);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual([]);
  });

  it('calls listReferences() with the provided skill name', async () => {
    const mockListRefs = jest.fn().mockResolvedValue(MOCK_REFERENCES);
    const resolver = createMockResolver({ listReferences: mockListRefs });

    await handleListReferences({ skill: SkillName.RuntimePatternsHttp }, resolver);

    expect(mockListRefs).toHaveBeenCalledWith('runtime-patterns-http');
  });

  it('returns isError: true for an invalid skill name', async () => {
    const resolver = createMockResolver();
    const result = await handleListReferences({ skill: 'nonexistent-skill' }, resolver);

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('list_references:');
    expect(result.content[0].text).toContain('Invalid skill name');
    expect(result.content[0].text).toContain('"nonexistent-skill"');
  });

  it('lists all valid skill names in the error message for invalid input', async () => {
    const resolver = createMockResolver();
    const result = await handleListReferences({ skill: 'bad-name' }, resolver);

    expect(result.isError).toBe(true);
    const errorText = result.content[0].text;
    for (const validName of Object.values(SkillName)) {
      expect(errorText).toContain(validName);
    }
  });

  it('returns isError: true for an empty skill name', async () => {
    const resolver = createMockResolver();
    const result = await handleListReferences({ skill: '' }, resolver);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid skill name');
  });

  it('does not call listReferences() for an invalid skill name', async () => {
    const mockListRefs = jest.fn();
    const resolver = createMockResolver({ listReferences: mockListRefs });

    await handleListReferences({ skill: 'invalid' }, resolver);

    expect(mockListRefs).not.toHaveBeenCalled();
  });

  it('returns isError: true when listReferences() throws', async () => {
    const resolver = createMockResolver({
      listReferences: jest.fn().mockRejectedValue(new Error('Permission denied')),
    });
    const result = await handleListReferences({ skill: SkillName.RuntimeConcepts }, resolver);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('list_references:');
    expect(result.content[0].text).toContain('Permission denied');
  });
});
