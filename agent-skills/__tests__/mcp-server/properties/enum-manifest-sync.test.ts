import * as path from 'path';
import * as fc from 'fast-check';
import { createFileResolver } from '../../../lib/file-resolver';
import { SkillName } from '../../../types';
import type { SkillManifest } from '../../../types';

/**
 * Property-based tests for enum-manifest synchronization.
 *
 * Feature: mcp-skills-server, Property 7
 *
 * Property 7: Enum-manifest synchronization
 *   The set of `SkillName` enum string values equals exactly the set of
 *   `name` fields in `skills-manifest.json` — no extra, no missing.
 *   Validates: Requirements 7.1, 7.2, 7.3, 7.5, 12.4
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

describe('Property 7: Enum-manifest synchronization', () => {
  let manifest: SkillManifest;
  let enumValues: string[];
  let manifestNames: string[];

  beforeAll(async () => {
    const resolver = createFileResolver(PACKAGE_ROOT);
    manifest = await resolver.readManifest();
    enumValues = Object.values(SkillName).sort();
    manifestNames = manifest.skills.map((s) => s.name).sort();
  });

  it('SkillName enum values exactly match skills-manifest.json name fields', () => {
    expect(enumValues).toEqual(manifestNames);
  });

  it('no extra enum members beyond what the manifest contains', () => {
    const manifestNameSet = new Set(manifestNames);
    for (const enumVal of enumValues) {
      expect(manifestNameSet.has(enumVal)).toBe(true);
    }
  });

  it('no missing enum members for manifest entries', () => {
    const enumValueSet = new Set(enumValues);
    for (const manifestName of manifestNames) {
      expect(enumValueSet.has(manifestName)).toBe(true);
    }
  });

  it('enum and manifest have the same cardinality (12 skills)', () => {
    expect(enumValues).toHaveLength(12);
    expect(manifestNames).toHaveLength(12);
    expect(enumValues).toHaveLength(manifestNames.length);
  });

  it('every enum value is a valid kebab-case string matching a skill directory', async () => {
    const resolver = createFileResolver(PACKAGE_ROOT);

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...enumValues),
        async (skillName) => {
          // Must be kebab-case: lowercase alphanumeric + hyphens
          expect(skillName).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);

          // Must correspond to a readable SKILL.md on disk
          const content = await resolver.readSkill(skillName);
          expect(content.length).toBeGreaterThan(0);
          expect(content).toMatch(/^---\n/);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('every manifest skill name appears as a SkillName enum value', () => {
    // Property: for any skill drawn from the manifest, it exists in the enum
    fc.assert(
      fc.property(
        fc.constantFrom(...manifestNames),
        (manifestName) => {
          const enumValueSet = new Set(enumValues);
          expect(enumValueSet.has(manifestName)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('every SkillName enum value appears as a manifest skill name', () => {
    // Property: for any value drawn from the enum, it exists in the manifest
    fc.assert(
      fc.property(
        fc.constantFrom(...enumValues),
        (enumVal) => {
          const manifestNameSet = new Set(manifestNames);
          expect(manifestNameSet.has(enumVal)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});
