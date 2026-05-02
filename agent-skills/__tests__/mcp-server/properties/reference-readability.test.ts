import * as path from 'path';
import * as fs from 'fs/promises';
import * as fc from 'fast-check';
import { createFileResolver } from '../../../lib/file-resolver';
import { handleListReferences } from '../../../tools/list-references';
import { handleReadReference } from '../../../tools/read-reference';
import { SkillName } from '../../../types';

/**
 * Property-based tests for reference listing, readability, traversal rejection,
 * and list-then-read completeness.
 *
 * Feature: mcp-skills-server, Properties 3, 4, 5, and 8
 *
 * Property 3: Reference listing correctness
 *   For any skill in the manifest, `list_references` returns paths where every
 *   path exists on disk, no path is `.gitkeep`, and nested paths include
 *   subdirectory prefix.
 *   Validates: Requirements 4.1, 4.2, 4.3, 12.5
 *
 * Property 4: Reference readability round-trip
 *   For any skill + any reference path from `list_references`, `read_reference`
 *   returns content byte-identical to the file on disk.
 *   Validates: Requirements 5.1, 5.2, 12.6
 *
 * Property 5: Directory traversal rejection
 *   For any reference path containing `..`, `read_reference` returns
 *   `isError: true`.
 *   Validates: Requirements 5.6
 *
 * Property 8: List-then-read reference completeness
 *   For any skill, references returned by `list_references` are non-empty iff
 *   the `references/` directory has non-`.gitkeep` files, and every returned
 *   path is readable via `read_reference`.
 *   Validates: Requirements 4.1, 5.1, 12.6
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const resolver = createFileResolver(PACKAGE_ROOT);
const VALID_SKILL_NAMES = Object.values(SkillName) as string[];

describe('Property 3: Reference listing correctness', () => {
  it('every listed reference exists on disk, is not .gitkeep, and nested paths include subdirectory prefix', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...VALID_SKILL_NAMES),
        async (skillName) => {
          const result = await handleListReferences({ skill: skillName }, resolver);

          expect(result.isError).toBeUndefined();
          const refs: string[] = JSON.parse(result.content[0].text);

          const refsDir = path.join(
            PACKAGE_ROOT,
            'agent-skills',
            skillName,
            'references',
          );

          for (const ref of refs) {
            // No path should be .gitkeep
            expect(path.basename(ref)).not.toBe('.gitkeep');

            // Every path must exist on disk
            const fullPath = path.join(refsDir, ref);
            const stat = await fs.stat(fullPath);
            expect(stat.isFile()).toBe(true);

            // Files in subdirectories must include the subdirectory prefix
            const dirOnDisk = path.dirname(fullPath);
            if (dirOnDisk !== refsDir) {
              expect(ref).toContain('/');
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Property 4: Reference readability round-trip', () => {
  // Pre-compute skill → references mapping for the arbitrary
  let skillReferencePairs: Array<{ skill: string; reference: string }>;

  beforeAll(async () => {
    skillReferencePairs = [];
    for (const skillName of VALID_SKILL_NAMES) {
      const result = await handleListReferences({ skill: skillName }, resolver);
      const refs: string[] = JSON.parse(result.content[0].text);
      for (const ref of refs) {
        skillReferencePairs.push({ skill: skillName, reference: ref });
      }
    }
  });

  it('read_reference returns content byte-identical to the file on disk for any valid skill + reference', async () => {
    // Skip if no reference pairs exist (unlikely but defensive)
    if (skillReferencePairs.length === 0) return;

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...skillReferencePairs),
        async ({ skill, reference }) => {
          const result = await handleReadReference(
            { skill, reference },
            resolver,
          );

          // Must not be an error
          expect(result.isError).toBeUndefined();
          expect(result.content).toHaveLength(1);
          expect(result.content[0].type).toBe('text');

          // Read the file directly from disk
          const diskContent = await fs.readFile(
            path.join(
              PACKAGE_ROOT,
              'agent-skills',
              skill,
              'references',
              reference,
            ),
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

describe('Property 5: Directory traversal rejection', () => {
  // Arbitrary that generates paths containing '..'
  const traversalPathArb = fc
    .tuple(
      fc.stringOf(
        fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')),
        { minLength: 0, maxLength: 10 },
      ),
      fc.stringOf(
        fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')),
        { minLength: 0, maxLength: 10 },
      ),
    )
    .map(([prefix, suffix]) => {
      const parts: string[] = [];
      if (prefix.length > 0) parts.push(prefix);
      parts.push('..');
      if (suffix.length > 0) parts.push(suffix);
      return parts.join('/');
    });

  it('read_reference returns isError: true for any path containing ".."', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...VALID_SKILL_NAMES),
        traversalPathArb,
        async (skillName, traversalPath) => {
          const result = await handleReadReference(
            { skill: skillName, reference: traversalPath },
            resolver,
          );

          expect(result.isError).toBe(true);
          expect(result.content).toHaveLength(1);
          expect(result.content[0].text).toContain('directory traversal');
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Property 8: List-then-read reference completeness', () => {
  it('list_references is non-empty iff references/ has non-.gitkeep files, and every path is readable', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...VALID_SKILL_NAMES),
        async (skillName) => {
          const listResult = await handleListReferences(
            { skill: skillName },
            resolver,
          );
          expect(listResult.isError).toBeUndefined();
          const refs: string[] = JSON.parse(listResult.content[0].text);

          // Check the actual references/ directory on disk
          const refsDir = path.join(
            PACKAGE_ROOT,
            'agent-skills',
            skillName,
            'references',
          );

          // Recursively collect all non-.gitkeep files from disk
          const diskFiles = await collectFiles(refsDir, refsDir);
          const nonGitkeepFiles = diskFiles.filter(
            (f) => path.basename(f) !== '.gitkeep',
          );

          // Non-empty iff the directory has non-.gitkeep files
          if (nonGitkeepFiles.length > 0) {
            expect(refs.length).toBeGreaterThan(0);
          } else {
            expect(refs).toHaveLength(0);
          }

          // Every returned path must be readable via read_reference
          for (const ref of refs) {
            const readResult = await handleReadReference(
              { skill: skillName, reference: ref },
              resolver,
            );
            expect(readResult.isError).toBeUndefined();
            expect(readResult.content).toHaveLength(1);
            expect(readResult.content[0].text.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Recursively collect all file paths under a directory,
 * returning paths relative to the base directory.
 */
async function collectFiles(dir: string, base: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFiles(fullPath, base);
      results.push(...nested);
    } else {
      results.push(path.relative(base, fullPath));
    }
  }
  return results;
}
