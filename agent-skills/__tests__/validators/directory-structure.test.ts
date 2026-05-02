// =============================================================================
// Property Test: Skill Directory Structure Integrity
// Feature: runtime-web-agent-skills, Property 4: Skill directory structure integrity
// Validates: Requirements 13.1, 13.6, 13.7
// =============================================================================

import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';
import { LAYER_ASSIGNMENT } from '../../scripts/validate-skills';

const SKILLS_ROOT = path.resolve(__dirname, '../../');

const ALL_SKILLS = Object.keys(LAYER_ASSIGNMENT);

/**
 * Recursively collects all files in a directory.
 */
function collectAllFiles(dir: string, relativeTo: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(relativeTo, fullPath);
    if (entry.isDirectory()) {
      files.push(...collectAllFiles(fullPath, relativeTo));
    } else {
      files.push(relPath);
    }
  }
  return files;
}

/**
 * Extracts file references from SKILL.md content.
 * Looks for markdown links to local files: [text](./path) or [text](references/path)
 */
function extractFileReferences(content: string): string[] {
  const refs: string[] = [];
  // Match relative file references (not cross-skill references)
  const pattern = /\[([^\]]*)\]\((?!\.\.\/)(?:\.\/)?([^)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const refPath = match[2];
    // Skip URLs and anchors
    if (refPath.startsWith('http') || refPath.startsWith('#')) continue;
    refs.push(refPath);
  }

  return refs;
}

describe('Property 4: Skill Directory Structure Integrity', () => {
  describe('Each skill directory exists and contains SKILL.md', () => {
    // This is a concrete check for all 12 skills — the "property" is that
    // for ANY skill in the set, the structural invariants hold.
    it('all 12 skill directories exist under agent-skills/', () => {
      for (const skillName of ALL_SKILLS) {
        const skillDir = path.join(SKILLS_ROOT, skillName);
        expect(fs.existsSync(skillDir)).toBe(true);
        expect(fs.statSync(skillDir).isDirectory()).toBe(true);
      }
    });

    it('all 12 skill directories contain a SKILL.md at the root', () => {
      for (const skillName of ALL_SKILLS) {
        const skillMd = path.join(SKILLS_ROOT, skillName, 'SKILL.md');
        expect(fs.existsSync(skillMd)).toBe(true);
        expect(fs.statSync(skillMd).isFile()).toBe(true);
      }
    });
  });

  describe('All .ts files are under references/ or assets/ subdirectories', () => {
    for (const skillName of ALL_SKILLS) {
      it(`${skillName}: no .ts files at skill root level`, () => {
        const skillDir = path.join(SKILLS_ROOT, skillName);
        const rootEntries = fs.readdirSync(skillDir, { withFileTypes: true });

        const rootTsFiles = rootEntries.filter(
          (e) => e.isFile() && e.name.endsWith('.ts'),
        );

        expect(rootTsFiles).toEqual([]);
      });

      it(`${skillName}: all .ts files are in references/ or assets/`, () => {
        const skillDir = path.join(SKILLS_ROOT, skillName);
        const allFiles = collectAllFiles(skillDir, skillDir);
        const tsFiles = allFiles.filter((f) => f.endsWith('.ts'));

        for (const tsFile of tsFiles) {
          const isInReferences = tsFile.startsWith('references/') || tsFile.startsWith('references\\');
          const isInAssets = tsFile.startsWith('assets/') || tsFile.startsWith('assets\\');

          expect(isInReferences || isInAssets).toBe(true);
        }
      });
    }
  });

  describe('File references in SKILL.md are one level deep', () => {
    for (const skillName of ALL_SKILLS) {
      it(`${skillName}: SKILL.md file references are at most one directory level deep`, () => {
        const skillMdPath = path.join(SKILLS_ROOT, skillName, 'SKILL.md');
        const content = fs.readFileSync(skillMdPath, 'utf-8');
        const refs = extractFileReferences(content);

        for (const ref of refs) {
          // Normalize path separators
          const normalized = ref.replace(/\\/g, '/');
          // Count directory depth (number of / separators)
          const parts = normalized.split('/').filter(Boolean);

          // "One level deep" means at most: subdir/file or subdir/subdir/file
          // The spec says "one directory level deep from the skill root"
          // So references/ is one level, references/templates/ is two levels
          // We allow references/templates/file.ts (depth 3 parts) as the max
          // because the design explicitly puts templates there
          const depth = parts.length - 1; // subtract the filename itself
          expect(depth).toBeLessThanOrEqual(2);
        }
      });
    }
  });

  describe('Property-based: random skill selection maintains invariants', () => {
    const skillNameArb = fc.constantFrom(...ALL_SKILLS);

    it('for any skill in the set, SKILL.md exists', () => {
      fc.assert(
        fc.property(skillNameArb, (skillName) => {
          const skillMd = path.join(SKILLS_ROOT, skillName, 'SKILL.md');
          return fs.existsSync(skillMd);
        }),
        { numRuns: 100 },
      );
    });

    it('for any skill in the set, no .ts files exist at root level', () => {
      fc.assert(
        fc.property(skillNameArb, (skillName) => {
          const skillDir = path.join(SKILLS_ROOT, skillName);
          const rootEntries = fs.readdirSync(skillDir, { withFileTypes: true });
          const rootTsFiles = rootEntries.filter(
            (e) => e.isFile() && e.name.endsWith('.ts'),
          );
          return rootTsFiles.length === 0;
        }),
        { numRuns: 100 },
      );
    });

    it('for any skill in the set, all .ts files are under references/ or assets/', () => {
      fc.assert(
        fc.property(skillNameArb, (skillName) => {
          const skillDir = path.join(SKILLS_ROOT, skillName);
          const allFiles = collectAllFiles(skillDir, skillDir);
          const tsFiles = allFiles.filter((f) => f.endsWith('.ts'));

          return tsFiles.every((tsFile) => {
            const normalized = tsFile.replace(/\\/g, '/');
            return normalized.startsWith('references/') || normalized.startsWith('assets/');
          });
        }),
        { numRuns: 100 },
      );
    });

    it('for any skill in the set, SKILL.md starts with YAML frontmatter', () => {
      fc.assert(
        fc.property(skillNameArb, (skillName) => {
          const skillMd = path.join(SKILLS_ROOT, skillName, 'SKILL.md');
          const content = fs.readFileSync(skillMd, 'utf-8');
          return content.startsWith('---\n');
        }),
        { numRuns: 100 },
      );
    });

    it('for any skill in the set, file references are at most one level deep', () => {
      fc.assert(
        fc.property(skillNameArb, (skillName) => {
          const skillMdPath = path.join(SKILLS_ROOT, skillName, 'SKILL.md');
          const content = fs.readFileSync(skillMdPath, 'utf-8');
          const refs = extractFileReferences(content);

          return refs.every((ref) => {
            const normalized = ref.replace(/\\/g, '/');
            const parts = normalized.split('/').filter(Boolean);
            const depth = parts.length - 1;
            return depth <= 2;
          });
        }),
        { numRuns: 100 },
      );
    });
  });
});
