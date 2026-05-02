// =============================================================================
// Example-Based Test: Cross-Reference Verification
// Feature: runtime-web-agent-skills
// Purpose: Finds all ../skill-name/SKILL.md links across all skills, verifies
//          each target skill exists, and verifies each reference includes the
//          correct (Layer N: LayerName) annotation.
// Validates: Requirements 16.7
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { LAYER_ASSIGNMENT } from '../../scripts/validate-skills';

const SKILLS_ROOT = path.resolve(__dirname, '../../');

const ALL_SKILLS = [
  'runtime-concepts',
  'runtime-lifecycle',
  'runtime-api-core',
  'runtime-api-integrations',
  'runtime-patterns-http',
  'runtime-patterns-async',
  'runtime-patterns-data-events',
  'runtime-ssr-and-web',
  'runtime-constraints-and-guardrails',
  'runtime-errors-and-diagnostics',
  'runtime-versioning-and-migration',
  'runtime-validation-and-ci',
];

const ALL_SKILL_NAMES = new Set(ALL_SKILLS);

interface CrossReference {
  sourceSkill: string;
  sourceFile: string;
  targetSkill: string;
  layerNum: string | undefined;
  layerName: string | undefined;
  lineNumber: number;
  fullMatch: string;
}

/**
 * Recursively collects all markdown and TypeScript files in a skill directory.
 */
function collectFiles(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
    } else if (entry.name.endsWith('.md') || entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Extracts all cross-references from a file's content.
 */
function extractCrossReferences(
  content: string,
  sourceSkill: string,
  sourceFile: string,
): CrossReference[] {
  const refs: CrossReference[] = [];
  const lines = content.split('\n');

  // Pattern: [text](../skill-name/SKILL.md) optionally followed by (Layer N: LayerName)
  const refPattern = /\[([^\]]*)\]\(\.\.\/([\w-]+)\/SKILL\.md\)(?:\s*\(Layer\s+(\d+):\s*([^)]+)\))?/g;

  for (let i = 0; i < lines.length; i++) {
    let match: RegExpExecArray | null;
    refPattern.lastIndex = 0;

    while ((match = refPattern.exec(lines[i])) !== null) {
      refs.push({
        sourceSkill,
        sourceFile,
        targetSkill: match[2],
        layerNum: match[3],
        layerName: match[4]?.trim(),
        lineNumber: i + 1,
        fullMatch: match[0],
      });
    }
  }

  return refs;
}

describe('Cross-Reference Verification (Requirement 16.7)', () => {
  let allReferences: CrossReference[] = [];

  beforeAll(() => {
    for (const skillName of ALL_SKILLS) {
      const skillDir = path.join(SKILLS_ROOT, skillName);
      const files = collectFiles(skillDir);

      for (const file of files) {
        const content = fs.readFileSync(file, 'utf-8');
        const relativePath = path.relative(SKILLS_ROOT, file);
        const refs = extractCrossReferences(content, skillName, relativePath);
        allReferences.push(...refs);
      }
    }
  });

  it('cross-references exist across the skill set', () => {
    // Skills should reference each other for progressive disclosure
    expect(allReferences.length).toBeGreaterThan(0);
  });

  describe('All cross-reference targets exist', () => {
    it('every referenced skill exists in the 12-skill set', () => {
      const invalidRefs = allReferences.filter(
        (ref) => !ALL_SKILL_NAMES.has(ref.targetSkill),
      );

      expect(invalidRefs).toEqual([]);
    });

    it('every referenced skill directory actually exists on disk', () => {
      const missingDirs = allReferences.filter((ref) => {
        const targetDir = path.join(SKILLS_ROOT, ref.targetSkill);
        return !fs.existsSync(targetDir);
      });

      expect(missingDirs).toEqual([]);
    });
  });

  describe('All cross-references include correct layer annotations', () => {
    it('every cross-reference has a layer annotation', () => {
      const missingAnnotations = allReferences.filter(
        (ref) => !ref.layerNum || !ref.layerName,
      );

      expect(missingAnnotations).toEqual([]);
    });

    it('every layer annotation has the correct layer number', () => {
      const wrongLayerNum = allReferences.filter((ref) => {
        if (!ref.layerNum) return false;
        const expected = LAYER_ASSIGNMENT[ref.targetSkill];
        if (!expected) return false;
        return parseInt(ref.layerNum, 10) !== expected.layer;
      });

      expect(wrongLayerNum).toEqual([]);
    });

    it('every layer annotation has the correct layer name', () => {
      const wrongLayerName = allReferences.filter((ref) => {
        if (!ref.layerName) return false;
        const expected = LAYER_ASSIGNMENT[ref.targetSkill];
        if (!expected) return false;
        return ref.layerName !== expected.layerName;
      });

      expect(wrongLayerName).toEqual([]);
    });
  });

  describe('Cross-reference coverage', () => {
    it('Layer 3 pattern skills reference Layer 1 or Layer 2 skills', () => {
      const layer3Skills = [
        'runtime-patterns-http',
        'runtime-patterns-async',
        'runtime-patterns-data-events',
        'runtime-ssr-and-web',
      ];

      for (const skillName of layer3Skills) {
        const skillRefs = allReferences.filter((r) => r.sourceSkill === skillName);
        const refsToLowerLayers = skillRefs.filter((r) => {
          const target = LAYER_ASSIGNMENT[r.targetSkill];
          return target && target.layer < 3;
        });

        // Pattern skills should reference at least one lower-layer skill
        expect(refsToLowerLayers.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('no skill references itself', () => {
      const selfRefs = allReferences.filter(
        (ref) => ref.sourceSkill === ref.targetSkill,
      );

      expect(selfRefs).toEqual([]);
    });
  });
});
