// =============================================================================
// Example-Based Test: Layer Metadata Verification
// Feature: runtime-web-agent-skills
// Purpose: Verifies each skill's metadata.layer and metadata.layerName match
//          the defined 5-layer progressive disclosure architecture.
// Validates: Requirements 16.1–16.5
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { LAYER_ASSIGNMENT, SkillFrontmatter } from '../../scripts/validate-skills';

const SKILLS_ROOT = path.resolve(__dirname, '../../');

/**
 * Expected layer assignments for all 12 skills.
 */
const EXPECTED_LAYERS: Record<string, { layer: string; layerName: string }> = {
  // Layer 1: Concepts & Product
  'runtime-concepts': { layer: '1', layerName: 'Concepts' },
  'runtime-lifecycle': { layer: '1', layerName: 'Concepts' },
  // Layer 2: API Surface
  'runtime-api-core': { layer: '2', layerName: 'API' },
  'runtime-api-integrations': { layer: '2', layerName: 'API' },
  // Layer 3: Patterns
  'runtime-patterns-http': { layer: '3', layerName: 'Patterns' },
  'runtime-patterns-async': { layer: '3', layerName: 'Patterns' },
  'runtime-patterns-data-events': { layer: '3', layerName: 'Patterns' },
  'runtime-ssr-and-web': { layer: '3', layerName: 'Patterns' },
  // Layer 4: Guardrails
  'runtime-constraints-and-guardrails': { layer: '4', layerName: 'Guardrails' },
  // Layer 5: Diagnostics & Evolution
  'runtime-errors-and-diagnostics': { layer: '5', layerName: 'Diagnostics' },
  'runtime-versioning-and-migration': { layer: '5', layerName: 'Diagnostics' },
  'runtime-validation-and-ci': { layer: '5', layerName: 'Diagnostics' },
};

/**
 * Parses YAML frontmatter from SKILL.md content.
 */
function parseFrontmatter(content: string): Partial<SkillFrontmatter> {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return {};

  const yaml = fmMatch[1];
  const result: any = { metadata: {} };

  const nameMatch = yaml.match(/^name:\s*(.+)$/m);
  if (nameMatch) result.name = nameMatch[1].trim();

  const metaMatch = yaml.match(/metadata:\n([\s\S]*?)$/);
  if (metaMatch) {
    const metaBlock = metaMatch[1];

    const authorMatch = metaBlock.match(/author:\s*(.+)/);
    if (authorMatch) result.metadata.author = authorMatch[1].trim();

    const versionMatch = metaBlock.match(/version:\s*"?([^"\n]+)"?/);
    if (versionMatch) result.metadata.version = versionMatch[1].trim();

    const frameworkMatch = metaBlock.match(/framework:\s*"?([^"\n]+)"?/);
    if (frameworkMatch) result.metadata.framework = frameworkMatch[1].trim();

    const fvrMatch = metaBlock.match(/frameworkVersionRange:\s*"?([^"\n]+)"?/);
    if (fvrMatch) result.metadata.frameworkVersionRange = fvrMatch[1].trim();

    const layerMatch = metaBlock.match(/layer:\s*"?([^"\n]+)"?/);
    if (layerMatch) result.metadata.layer = layerMatch[1].trim().replace(/"/g, '');

    const layerNameMatch = metaBlock.match(/layerName:\s*"?([^"\n]+)"?/);
    if (layerNameMatch) result.metadata.layerName = layerNameMatch[1].trim().replace(/"/g, '');
  }

  return result;
}

describe('Layer Metadata Verification (Requirements 16.1–16.5)', () => {
  describe('Layer 1: Concepts & Product', () => {
    const layer1Skills = ['runtime-concepts', 'runtime-lifecycle'];

    for (const skillName of layer1Skills) {
      it(`${skillName} has metadata.layer = "1"`, () => {
        const content = fs.readFileSync(
          path.join(SKILLS_ROOT, skillName, 'SKILL.md'),
          'utf-8',
        );
        const fm = parseFrontmatter(content);
        expect(fm.metadata?.layer).toBe('1');
      });

      it(`${skillName} has metadata.layerName = "Concepts"`, () => {
        const content = fs.readFileSync(
          path.join(SKILLS_ROOT, skillName, 'SKILL.md'),
          'utf-8',
        );
        const fm = parseFrontmatter(content);
        expect(fm.metadata?.layerName).toBe('Concepts');
      });
    }
  });

  describe('Layer 2: API Surface', () => {
    const layer2Skills = ['runtime-api-core', 'runtime-api-integrations'];

    for (const skillName of layer2Skills) {
      it(`${skillName} has metadata.layer = "2"`, () => {
        const content = fs.readFileSync(
          path.join(SKILLS_ROOT, skillName, 'SKILL.md'),
          'utf-8',
        );
        const fm = parseFrontmatter(content);
        expect(fm.metadata?.layer).toBe('2');
      });

      it(`${skillName} has metadata.layerName = "API"`, () => {
        const content = fs.readFileSync(
          path.join(SKILLS_ROOT, skillName, 'SKILL.md'),
          'utf-8',
        );
        const fm = parseFrontmatter(content);
        expect(fm.metadata?.layerName).toBe('API');
      });
    }
  });

  describe('Layer 3: Patterns', () => {
    const layer3Skills = [
      'runtime-patterns-http',
      'runtime-patterns-async',
      'runtime-patterns-data-events',
      'runtime-ssr-and-web',
    ];

    for (const skillName of layer3Skills) {
      it(`${skillName} has metadata.layer = "3"`, () => {
        const content = fs.readFileSync(
          path.join(SKILLS_ROOT, skillName, 'SKILL.md'),
          'utf-8',
        );
        const fm = parseFrontmatter(content);
        expect(fm.metadata?.layer).toBe('3');
      });

      it(`${skillName} has metadata.layerName = "Patterns"`, () => {
        const content = fs.readFileSync(
          path.join(SKILLS_ROOT, skillName, 'SKILL.md'),
          'utf-8',
        );
        const fm = parseFrontmatter(content);
        expect(fm.metadata?.layerName).toBe('Patterns');
      });
    }
  });

  describe('Layer 4: Guardrails', () => {
    const layer4Skills = ['runtime-constraints-and-guardrails'];

    for (const skillName of layer4Skills) {
      it(`${skillName} has metadata.layer = "4"`, () => {
        const content = fs.readFileSync(
          path.join(SKILLS_ROOT, skillName, 'SKILL.md'),
          'utf-8',
        );
        const fm = parseFrontmatter(content);
        expect(fm.metadata?.layer).toBe('4');
      });

      it(`${skillName} has metadata.layerName = "Guardrails"`, () => {
        const content = fs.readFileSync(
          path.join(SKILLS_ROOT, skillName, 'SKILL.md'),
          'utf-8',
        );
        const fm = parseFrontmatter(content);
        expect(fm.metadata?.layerName).toBe('Guardrails');
      });
    }
  });

  describe('Layer 5: Diagnostics & Evolution', () => {
    const layer5Skills = [
      'runtime-errors-and-diagnostics',
      'runtime-versioning-and-migration',
      'runtime-validation-and-ci',
    ];

    for (const skillName of layer5Skills) {
      it(`${skillName} has metadata.layer = "5"`, () => {
        const content = fs.readFileSync(
          path.join(SKILLS_ROOT, skillName, 'SKILL.md'),
          'utf-8',
        );
        const fm = parseFrontmatter(content);
        expect(fm.metadata?.layer).toBe('5');
      });

      it(`${skillName} has metadata.layerName = "Diagnostics"`, () => {
        const content = fs.readFileSync(
          path.join(SKILLS_ROOT, skillName, 'SKILL.md'),
          'utf-8',
        );
        const fm = parseFrontmatter(content);
        expect(fm.metadata?.layerName).toBe('Diagnostics');
      });
    }
  });

  describe('LAYER_ASSIGNMENT constant consistency', () => {
    it('LAYER_ASSIGNMENT contains all 12 skills', () => {
      expect(Object.keys(LAYER_ASSIGNMENT).length).toBe(12);
    });

    for (const [skillName, expected] of Object.entries(EXPECTED_LAYERS)) {
      it(`LAYER_ASSIGNMENT[${skillName}] matches expected layer ${expected.layer}`, () => {
        const assignment = LAYER_ASSIGNMENT[skillName];
        expect(assignment).toBeDefined();
        expect(assignment.layer).toBe(parseInt(expected.layer, 10));
        expect(assignment.layerName).toBe(expected.layerName);
      });
    }
  });

  describe('Layer numbers are valid (1-5)', () => {
    for (const skillName of Object.keys(EXPECTED_LAYERS)) {
      it(`${skillName} layer is between 1 and 5`, () => {
        const content = fs.readFileSync(
          path.join(SKILLS_ROOT, skillName, 'SKILL.md'),
          'utf-8',
        );
        const fm = parseFrontmatter(content);
        const layerNum = parseInt(fm.metadata?.layer ?? '0', 10);
        expect(layerNum).toBeGreaterThanOrEqual(1);
        expect(layerNum).toBeLessThanOrEqual(5);
      });
    }
  });
});
