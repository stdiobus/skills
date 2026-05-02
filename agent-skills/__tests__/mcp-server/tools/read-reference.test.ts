import { handleReadReference } from '../../../tools/read-reference';
import { SkillName } from '../../../types';
import type { FileResolver } from '../../../lib/file-resolver';

/**
 * Unit tests for the read_reference tool handler.
 * Uses a mocked FileResolver to test the handler in isolation.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.6, 12.1
 */

const MOCK_MD_CONTENT = '# Domain Model\n\nThis is the domain model reference.';
const MOCK_JSON_CONTENT = '{"errors": [{"code": "E001", "message": "Unknown error"}]}';
const MOCK_TS_CONTENT = `import { LambdaDefinition } from '@worktif/runtime';\n\nexport const handler: LambdaDefinition = {};`;

function createMockResolver(overrides: Partial<FileResolver> = {}): FileResolver {
  return {
    packageRoot: '/mock/root',
    readManifest: jest.fn(),
    readSkill: jest.fn(),
    listReferences: jest.fn(),
    readReference: jest.fn().mockResolvedValue(MOCK_MD_CONTENT),
    ...overrides,
  };
}

describe('handleReadReference()', () => {
  describe('successful reads', () => {
    it('returns file content for a valid skill + reference path', async () => {
      const resolver = createMockResolver();
      const result = await handleReadReference(
        { skill: SkillName.RuntimeConcepts, reference: 'domain-model.md' },
        resolver,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toBe(MOCK_MD_CONTENT);
    });

    it('supports reading .md files', async () => {
      const resolver = createMockResolver({
        readReference: jest.fn().mockResolvedValue(MOCK_MD_CONTENT),
      });
      const result = await handleReadReference(
        { skill: SkillName.RuntimeConcepts, reference: 'domain-model.md' },
        resolver,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe(MOCK_MD_CONTENT);
    });

    it('supports reading .json files', async () => {
      const resolver = createMockResolver({
        readReference: jest.fn().mockResolvedValue(MOCK_JSON_CONTENT),
      });
      const result = await handleReadReference(
        { skill: SkillName.RuntimeErrorsAndDiagnostics, reference: 'error-catalog.json' },
        resolver,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe(MOCK_JSON_CONTENT);
      // Verify it's valid JSON
      expect(() => JSON.parse(result.content[0].text)).not.toThrow();
    });

    it('supports reading .ts template files', async () => {
      const resolver = createMockResolver({
        readReference: jest.fn().mockResolvedValue(MOCK_TS_CONTENT),
      });
      const result = await handleReadReference(
        { skill: SkillName.RuntimePatternsAsync, reference: 'templates/sqs-worker.ts' },
        resolver,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe(MOCK_TS_CONTENT);
    });

    it('calls readReference() with the correct skill and reference path', async () => {
      const mockReadRef = jest.fn().mockResolvedValue(MOCK_MD_CONTENT);
      const resolver = createMockResolver({ readReference: mockReadRef });

      await handleReadReference(
        { skill: SkillName.RuntimePatternsHttp, reference: 'templates/crud-microservice.ts' },
        resolver,
      );

      expect(mockReadRef).toHaveBeenCalledWith('runtime-patterns-http', 'templates/crud-microservice.ts');
    });
  });

  describe('invalid skill name', () => {
    it('returns isError: true for an invalid skill name', async () => {
      const resolver = createMockResolver();
      const result = await handleReadReference(
        { skill: 'nonexistent-skill', reference: 'domain-model.md' },
        resolver,
      );

      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('read_reference:');
      expect(result.content[0].text).toContain('Invalid skill name');
      expect(result.content[0].text).toContain('"nonexistent-skill"');
    });

    it('lists all valid skill names in the error message', async () => {
      const resolver = createMockResolver();
      const result = await handleReadReference(
        { skill: 'bad-name', reference: 'file.md' },
        resolver,
      );

      expect(result.isError).toBe(true);
      const errorText = result.content[0].text;
      for (const validName of Object.values(SkillName)) {
        expect(errorText).toContain(validName);
      }
    });

    it('returns isError: true for an empty skill name', async () => {
      const resolver = createMockResolver();
      const result = await handleReadReference(
        { skill: '', reference: 'file.md' },
        resolver,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid skill name');
    });

    it('does not call readReference() for an invalid skill name', async () => {
      const mockReadRef = jest.fn();
      const resolver = createMockResolver({ readReference: mockReadRef });

      await handleReadReference(
        { skill: 'invalid', reference: 'file.md' },
        resolver,
      );

      expect(mockReadRef).not.toHaveBeenCalled();
    });
  });

  describe('directory traversal rejection', () => {
    it('returns isError: true for path containing ".."', async () => {
      const resolver = createMockResolver();
      const result = await handleReadReference(
        { skill: SkillName.RuntimeConcepts, reference: '../SKILL.md' },
        resolver,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('directory traversal');
    });

    it('returns isError: true for ".." in the middle of a path', async () => {
      const resolver = createMockResolver();
      const result = await handleReadReference(
        { skill: SkillName.RuntimeConcepts, reference: 'templates/../../../etc/passwd' },
        resolver,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('directory traversal');
    });

    it('returns isError: true for path that is just ".."', async () => {
      const resolver = createMockResolver();
      const result = await handleReadReference(
        { skill: SkillName.RuntimeConcepts, reference: '..' },
        resolver,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('directory traversal');
    });

    it('does not call readReference() for directory traversal attempts', async () => {
      const mockReadRef = jest.fn();
      const resolver = createMockResolver({ readReference: mockReadRef });

      await handleReadReference(
        { skill: SkillName.RuntimeConcepts, reference: '../secret.txt' },
        resolver,
      );

      expect(mockReadRef).not.toHaveBeenCalled();
    });
  });

  describe('non-existent reference file', () => {
    it('returns isError: true for a non-existent reference file', async () => {
      const resolver = createMockResolver({
        readReference: jest.fn().mockRejectedValue(
          new Error('File not found — "nonexistent.md" does not exist in runtime-concepts/references/.'),
        ),
      });
      const result = await handleReadReference(
        { skill: SkillName.RuntimeConcepts, reference: 'nonexistent.md' },
        resolver,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('read_reference:');
      expect(result.content[0].text).toContain('does not exist');
    });

    it('returns isError: true with stringified error for non-Error throws', async () => {
      const resolver = createMockResolver({
        readReference: jest.fn().mockRejectedValue('raw string error'),
      });
      const result = await handleReadReference(
        { skill: SkillName.RuntimeConcepts, reference: 'file.md' },
        resolver,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('raw string error');
    });
  });

  describe('error precedence', () => {
    it('checks skill name validity before directory traversal', async () => {
      const resolver = createMockResolver();
      const result = await handleReadReference(
        { skill: 'invalid-skill', reference: '../etc/passwd' },
        resolver,
      );

      // Should fail on invalid skill name, not directory traversal
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid skill name');
    });

    it('checks directory traversal before calling readReference()', async () => {
      const mockReadRef = jest.fn();
      const resolver = createMockResolver({ readReference: mockReadRef });

      await handleReadReference(
        { skill: SkillName.RuntimeConcepts, reference: '../SKILL.md' },
        resolver,
      );

      // readReference should never be called for traversal attempts
      expect(mockReadRef).not.toHaveBeenCalled();
    });
  });
});
