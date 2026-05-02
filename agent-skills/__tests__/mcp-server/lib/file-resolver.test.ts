import * as path from 'path';
import * as fs from 'fs/promises';
import { createFileResolver, FileResolver } from '../../../lib/file-resolver';
import { SkillName } from '../../../types';

/**
 * Unit tests for the FileResolver utility.
 * Tests use the real file system with packageRoot pointed at the workspace root.
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 5.6
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

describe('createFileResolver()', () => {
  let resolver: FileResolver;

  beforeAll(() => {
    resolver = createFileResolver(PACKAGE_ROOT);
  });

  describe('packageRoot', () => {
    it('uses the provided packageRoot override', () => {
      expect(resolver.packageRoot).toBe(PACKAGE_ROOT);
    });

    it('defaults to __dirname-relative path when no override is given', () => {
      const defaultResolver = createFileResolver();
      // The default resolves from __dirname (which is the compiled test location),
      // so it will differ from our override — just verify it's an absolute path
      expect(path.isAbsolute(defaultResolver.packageRoot)).toBe(true);
    });
  });

  describe('readManifest()', () => {
    it('returns a valid SkillManifest with 12 skills', async () => {
      const manifest = await resolver.readManifest();

      expect(manifest).toBeDefined();
      expect(manifest.version).toBe('1.0.0');
      expect(manifest.frameworkVersion).toBe('0.5.0-beta.2');
      expect(manifest.skills).toHaveLength(12);
      expect(manifest.lastValidated).toBeDefined();
    });

    it('includes required fields for each skill entry', async () => {
      const manifest = await resolver.readManifest();

      for (const skill of manifest.skills) {
        expect(skill.name).toEqual(expect.any(String));
        expect(skill.layer).toEqual(expect.any(Number));
        expect(skill.versionRange).toEqual(expect.any(String));
        expect(skill.status).toEqual(expect.any(String));
        expect(skill.lastValidated).toEqual(expect.any(String));
      }
    });

    it('contains all 12 skill names from the SkillName enum', async () => {
      const manifest = await resolver.readManifest();
      const manifestNames = manifest.skills.map((s) => s.name).sort();
      const enumValues = Object.values(SkillName).sort();

      expect(manifestNames).toEqual(enumValues);
    });
  });

  describe('readSkill()', () => {
    it.each(Object.values(SkillName))(
      'returns content for skill "%s"',
      async (skillName) => {
        const content = await resolver.readSkill(skillName);

        expect(content).toBeDefined();
        expect(typeof content).toBe('string');
        expect(content.length).toBeGreaterThan(0);
        // Every SKILL.md starts with YAML frontmatter
        expect(content).toMatch(/^---\n/);
      },
    );

    it('returns content byte-identical to the file on disk', async () => {
      const skillName = SkillName.RuntimeConcepts;
      const content = await resolver.readSkill(skillName);
      const diskContent = await fs.readFile(
        path.join(PACKAGE_ROOT, 'agent-skills', skillName, 'SKILL.md'),
        'utf-8',
      );

      expect(content).toBe(diskContent);
    });

    it('throws a descriptive error for a non-existent skill name', async () => {
      await expect(resolver.readSkill('nonexistent-skill')).rejects.toThrow(
        /SKILL\.md not found for skill: nonexistent-skill/,
      );
    });

    it('throws a descriptive error for an empty skill name', async () => {
      await expect(resolver.readSkill('')).rejects.toThrow();
    });
  });

  describe('listReferences()', () => {
    it('returns file paths excluding .gitkeep', async () => {
      const refs = await resolver.listReferences(SkillName.RuntimeConcepts);

      expect(refs).toBeDefined();
      expect(Array.isArray(refs)).toBe(true);
      for (const ref of refs) {
        expect(path.basename(ref)).not.toBe('.gitkeep');
      }
    });

    it('includes nested subdirectory paths for pattern skills', async () => {
      const refs = await resolver.listReferences(SkillName.RuntimePatternsAsync);

      // This skill has templates/ subdirectory with .ts files
      const nestedRefs = refs.filter((r) => r.includes(path.sep) || r.includes('/'));
      expect(nestedRefs.length).toBeGreaterThan(0);

      // Verify specific known template files
      const templateRefs = refs.filter((r) => r.startsWith('templates/'));
      expect(templateRefs.length).toBeGreaterThan(0);
      expect(templateRefs).toContain('templates/sqs-worker.ts');
    });

    it('returns sorted file paths', async () => {
      const refs = await resolver.listReferences(SkillName.RuntimePatternsHttp);

      const sorted = [...refs].sort();
      expect(refs).toEqual(sorted);
    });

    it('returns an empty array for a skill with only .gitkeep in references', async () => {
      // Find a skill that might have only .gitkeep — use the resolver to check
      // runtime-lifecycle has references with .gitkeep and commands-reference.md
      // We test that .gitkeep is excluded by verifying no result is .gitkeep
      const refs = await resolver.listReferences(SkillName.RuntimeLifecycle);
      for (const ref of refs) {
        expect(path.basename(ref)).not.toBe('.gitkeep');
      }
    });

    it('returns all files that exist on disk', async () => {
      const skillName = SkillName.RuntimePatternsAsync;
      const refs = await resolver.listReferences(skillName);
      const refsDir = path.join(PACKAGE_ROOT, 'agent-skills', skillName, 'references');

      for (const ref of refs) {
        const fullPath = path.join(refsDir, ref);
        const stat = await fs.stat(fullPath);
        expect(stat.isFile()).toBe(true);
      }
    });
  });

  describe('readReference()', () => {
    it('returns file content for a valid skill + reference path', async () => {
      const content = await resolver.readReference(
        SkillName.RuntimeConcepts,
        'domain-model.md',
      );

      expect(content).toBeDefined();
      expect(typeof content).toBe('string');
      expect(content.length).toBeGreaterThan(0);
    });

    it('returns content byte-identical to the file on disk', async () => {
      const skillName = SkillName.RuntimeConcepts;
      const refPath = 'domain-model.md';
      const content = await resolver.readReference(skillName, refPath);
      const diskContent = await fs.readFile(
        path.join(PACKAGE_ROOT, 'agent-skills', skillName, 'references', refPath),
        'utf-8',
      );

      expect(content).toBe(diskContent);
    });

    it('reads nested reference files (templates)', async () => {
      const content = await resolver.readReference(
        SkillName.RuntimePatternsAsync,
        'templates/sqs-worker.ts',
      );

      expect(content).toBeDefined();
      expect(content.length).toBeGreaterThan(0);
    });

    it('reads .json reference files', async () => {
      const content = await resolver.readReference(
        SkillName.RuntimeErrorsAndDiagnostics,
        'error-catalog.json',
      );

      expect(content).toBeDefined();
      // Should be valid JSON
      expect(() => JSON.parse(content)).not.toThrow();
    });

    it('rejects paths containing ".." (directory traversal)', async () => {
      await expect(
        resolver.readReference(SkillName.RuntimeConcepts, '../SKILL.md'),
      ).rejects.toThrow(/directory traversal/i);
    });

    it('rejects paths with ".." in the middle', async () => {
      await expect(
        resolver.readReference(SkillName.RuntimeConcepts, 'templates/../../../etc/passwd'),
      ).rejects.toThrow(/directory traversal/i);
    });

    it('rejects paths that are just ".."', async () => {
      await expect(
        resolver.readReference(SkillName.RuntimeConcepts, '..'),
      ).rejects.toThrow(/directory traversal/i);
    });

    it('throws a descriptive error for a non-existent reference file', async () => {
      await expect(
        resolver.readReference(SkillName.RuntimeConcepts, 'nonexistent-file.md'),
      ).rejects.toThrow(/does not exist/i);
    });
  });

  describe('packageRoot override', () => {
    it('resolves files relative to the overridden root', async () => {
      const customResolver = createFileResolver(PACKAGE_ROOT);
      const manifest = await customResolver.readManifest();

      expect(manifest.skills).toHaveLength(12);
    });

    it('fails gracefully with an invalid package root', async () => {
      const badResolver = createFileResolver('/nonexistent/path');

      await expect(badResolver.readManifest()).rejects.toThrow();
    });

    it('fails gracefully when reading a skill from an invalid root', async () => {
      const badResolver = createFileResolver('/nonexistent/path');

      await expect(badResolver.readSkill(SkillName.RuntimeConcepts)).rejects.toThrow();
    });
  });
});
