import * as path from 'path';
import * as fs from 'fs/promises';
import * as fc from 'fast-check';
import { createFileResolver } from '../../../lib/file-resolver';
import { handleReadSkill } from '../../../tools/read-skill';
import { handleListReferences } from '../../../tools/list-references';
import { handleReadReference } from '../../../tools/read-reference';
import { SkillName } from '../../../types';

/**
 * Property-based tests for skill readability and invalid name rejection.
 *
 * Feature: mcp-skills-server, Properties 1 and 2
 *
 * Property 1: Skill readability round-trip
 *   For any skill name from the manifest, `read_skill` returns content
 *   byte-identical to the SKILL.md file on disk.
 *   Validates: Requirements 3.1, 3.4, 12.5
 *
 * Property 2: Invalid skill name rejection
 *   For any string NOT in the SkillName enum, `read_skill`, `list_references`,
 *   and `read_reference` return `isError: true`.
 *   Validates: Requirements 3.2, 4.4, 5.4, 12.5
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const resolver = createFileResolver(PACKAGE_ROOT);
const VALID_SKILL_NAMES = Object.values(SkillName) as string[];

describe('Property 1: Skill readability round-trip', () => {
  it('read_skill returns content byte-identical to SKILL.md on disk for any valid skill', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...VALID_SKILL_NAMES),
        async (skillName) => {
          const result = await handleReadSkill({ skill: skillName }, resolver);

          // Must not be an error
          expect(result.isError).toBeUndefined();
          expect(result.content).toHaveLength(1);
          expect(result.content[0].type).toBe('text');

          // Read the file directly from disk
          const diskContent = await fs.readFile(
            path.join(PACKAGE_ROOT, 'agent-skills', skillName, 'SKILL.md'),
            'utf-8',
          );

          // Content must be byte-identical
          expect(result.content[0].text).toBe(diskContent);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Property 2: Invalid skill name rejection', () => {
  // Arbitrary that generates strings NOT in the SkillName enum
  const invalidSkillNameArb = fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split(''),
      ),
      { minLength: 1, maxLength: 60 },
    )
    .filter((s) => !VALID_SKILL_NAMES.includes(s));

  it('read_skill returns isError: true for any invalid skill name', async () => {
    await fc.assert(
      fc.asyncProperty(invalidSkillNameArb, async (invalidName) => {
        const result = await handleReadSkill({ skill: invalidName }, resolver);

        expect(result.isError).toBe(true);
        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe('text');
        expect(result.content[0].text).toContain('Invalid skill name');
      }),
      { numRuns: 100 },
    );
  });

  it('list_references returns isError: true for any invalid skill name', async () => {
    await fc.assert(
      fc.asyncProperty(invalidSkillNameArb, async (invalidName) => {
        const result = await handleListReferences({ skill: invalidName }, resolver);

        expect(result.isError).toBe(true);
        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe('text');
        expect(result.content[0].text).toContain('Invalid skill name');
      }),
      { numRuns: 100 },
    );
  });

  it('read_reference returns isError: true for any invalid skill name', async () => {
    await fc.assert(
      fc.asyncProperty(invalidSkillNameArb, async (invalidName) => {
        const result = await handleReadReference(
          { skill: invalidName, reference: 'any-file.md' },
          resolver,
        );

        expect(result.isError).toBe(true);
        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe('text');
        expect(result.content[0].text).toContain('Invalid skill name');
      }),
      { numRuns: 100 },
    );
  });
});
