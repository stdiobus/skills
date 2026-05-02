import { handleReadSkill } from '../../../tools/read-skill';
import { SkillName } from '../../../types';
import type { FileResolver } from '../../../lib/file-resolver';

/**
 * Unit tests for the read_skill tool handler.
 * Uses a mocked FileResolver to test the handler in isolation.
 *
 * Requirements: 3.1, 3.2, 3.3, 12.1
 */

const MOCK_SKILL_CONTENT = `---
name: runtime-concepts
description: >
  Core concepts of the runtime framework.
---

# Runtime Concepts

Overview of the runtime framework.
`;

function createMockResolver(overrides: Partial<FileResolver> = {}): FileResolver {
  return {
    packageRoot: '/mock/root',
    readManifest: jest.fn(),
    readSkill: jest.fn().mockResolvedValue(MOCK_SKILL_CONTENT),
    listReferences: jest.fn(),
    readReference: jest.fn(),
    ...overrides,
  };
}

describe('handleReadSkill()', () => {
  it('returns SKILL.md content for a valid skill name', async () => {
    const resolver = createMockResolver();
    const result = await handleReadSkill({ skill: SkillName.RuntimeConcepts }, resolver);

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toBe(MOCK_SKILL_CONTENT);
  });

  it('returns raw text content, not JSON', async () => {
    const resolver = createMockResolver();
    const result = await handleReadSkill({ skill: SkillName.RuntimeConcepts }, resolver);

    // The content should be the raw SKILL.md text, not wrapped in JSON
    expect(result.content[0].text).toMatch(/^---\n/);
  });

  it('calls readSkill() with the provided skill name', async () => {
    const mockReadSkill = jest.fn().mockResolvedValue(MOCK_SKILL_CONTENT);
    const resolver = createMockResolver({ readSkill: mockReadSkill });

    await handleReadSkill({ skill: SkillName.RuntimePatternsHttp }, resolver);

    expect(mockReadSkill).toHaveBeenCalledWith('runtime-patterns-http');
  });

  it.each(Object.values(SkillName))(
    'accepts valid skill name "%s"',
    async (skillName) => {
      const resolver = createMockResolver();
      const result = await handleReadSkill({ skill: skillName }, resolver);

      expect(result.isError).toBeUndefined();
    },
  );

  it('returns isError: true for an invalid skill name', async () => {
    const resolver = createMockResolver();
    const result = await handleReadSkill({ skill: 'nonexistent-skill' }, resolver);

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('read_skill:');
    expect(result.content[0].text).toContain('Invalid skill name');
    expect(result.content[0].text).toContain('"nonexistent-skill"');
  });

  it('lists all valid skill names in the error message for invalid input', async () => {
    const resolver = createMockResolver();
    const result = await handleReadSkill({ skill: 'bad-name' }, resolver);

    expect(result.isError).toBe(true);
    const errorText = result.content[0].text;
    // Verify all valid skill names are listed in the error message
    for (const validName of Object.values(SkillName)) {
      expect(errorText).toContain(validName);
    }
  });

  it('returns isError: true for an empty skill name', async () => {
    const resolver = createMockResolver();
    const result = await handleReadSkill({ skill: '' }, resolver);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid skill name');
  });

  it('does not call readSkill() for an invalid skill name', async () => {
    const mockReadSkill = jest.fn();
    const resolver = createMockResolver({ readSkill: mockReadSkill });

    await handleReadSkill({ skill: 'invalid' }, resolver);

    expect(mockReadSkill).not.toHaveBeenCalled();
  });

  it('returns isError: true when readSkill() throws', async () => {
    const resolver = createMockResolver({
      readSkill: jest.fn().mockRejectedValue(
        new Error('SKILL.md not found for skill: runtime-concepts'),
      ),
    });
    const result = await handleReadSkill({ skill: SkillName.RuntimeConcepts }, resolver);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('read_skill:');
    expect(result.content[0].text).toContain('SKILL.md not found');
  });

  it('returns isError: true with stringified error for non-Error throws', async () => {
    const resolver = createMockResolver({
      readSkill: jest.fn().mockRejectedValue('raw string error'),
    });
    const result = await handleReadSkill({ skill: SkillName.RuntimeConcepts }, resolver);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('raw string error');
  });
});
