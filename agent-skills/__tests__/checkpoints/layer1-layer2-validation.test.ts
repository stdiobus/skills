// =============================================================================
// Checkpoint Test: Layer 1 and Layer 2 Skills Validation
// Feature: runtime-web-agent-skills
// Purpose: Validates that all 4 completed skills (runtime-concepts, runtime-lifecycle,
//          runtime-api-core, runtime-api-integrations) pass structural validation
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import {
  validateSkillName,
  validateFrontmatter,
  validateBodyStructure,
  checkTerminology,
  validateLayerAssignment,
  validateCrossReferences,
  LAYER_ASSIGNMENT,
  SkillFrontmatter,
} from '../../scripts/validate-skills';

const SKILLS_ROOT = path.resolve(__dirname, '../../');
const LAYER_1_2_SKILLS = [
  'runtime-concepts',
  'runtime-lifecycle',
  'runtime-api-core',
  'runtime-api-integrations',
];

/**
 * Parses YAML frontmatter from SKILL.md content.
 * Simple parser that handles the frontmatter between --- delimiters.
 */
function parseFrontmatter(content: string): Partial<SkillFrontmatter> {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return {};

  const yaml = fmMatch[1];
  const result: any = { metadata: {} };

  // Parse top-level fields
  const nameMatch = yaml.match(/^name:\s*(.+)$/m);
  if (nameMatch) result.name = nameMatch[1].trim();

  // Parse description (multi-line with >)
  const descMatch = yaml.match(/description:\s*>\s*\n([\s\S]*?)(?=\n\w|\nlicense|\ncompatibility|\nmetadata)/);
  if (descMatch) {
    result.description = descMatch[1].split('\n').map((l: string) => l.trim()).filter(Boolean).join(' ');
  } else {
    const singleDescMatch = yaml.match(/^description:\s*(.+)$/m);
    if (singleDescMatch) result.description = singleDescMatch[1].trim();
  }

  const licenseMatch = yaml.match(/^license:\s*(.+)$/m);
  if (licenseMatch) result.license = licenseMatch[1].trim();

  const compatMatch = yaml.match(/^compatibility:\s*(.+)$/m);
  if (compatMatch) result.compatibility = compatMatch[1].trim();

  // Parse metadata block
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

/**
 * Extracts the body content (everything after frontmatter).
 */
function extractBody(content: string): string {
  const fmEnd = content.indexOf('---', 4);
  if (fmEnd === -1) return content;
  return content.substring(fmEnd + 3).trim();
}

describe('Checkpoint: Layer 1 and Layer 2 Skills Validation', () => {
  const allSkillNames = new Set(Object.keys(LAYER_ASSIGNMENT));

  for (const skillName of LAYER_1_2_SKILLS) {
    describe(`Skill: ${skillName}`, () => {
      const skillPath = path.join(SKILLS_ROOT, skillName, 'SKILL.md');
      let content: string;
      let frontmatter: Partial<SkillFrontmatter>;
      let body: string;

      beforeAll(() => {
        content = fs.readFileSync(skillPath, 'utf-8');
        frontmatter = parseFrontmatter(content);
        body = extractBody(content);
      });

      it('SKILL.md file exists', () => {
        expect(fs.existsSync(skillPath)).toBe(true);
      });

      it('passes validateSkillName()', () => {
        const result = validateSkillName(frontmatter.name ?? '', skillName);
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);
      });

      it('passes validateFrontmatter()', () => {
        const result = validateFrontmatter(frontmatter);
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);
      });

      it('passes validateBodyStructure()', () => {
        const result = validateBodyStructure(body);
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);
      });

      it('passes checkTerminology() with no warnings', () => {
        const result = checkTerminology(content);
        // Terminology issues are warnings, not errors
        expect(result.valid).toBe(true);
        // Report any warnings for visibility
        if (result.warnings.length > 0) {
          console.warn(`  [${skillName}] Terminology warnings:`, result.warnings);
        }
      });

      it('passes validateLayerAssignment()', () => {
        const result = validateLayerAssignment(
          skillName,
          frontmatter.metadata?.layer ?? '',
          frontmatter.metadata?.layerName,
        );
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);
      });

      it('passes validateCrossReferences()', () => {
        const result = validateCrossReferences(content, allSkillNames);
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);
      });

      it('body is under 500 lines', () => {
        const lineCount = body.split('\n').length;
        expect(lineCount).toBeLessThan(500);
      });

      it('has correct metadata.framework value', () => {
        expect(frontmatter.metadata?.framework).toBe('@worktif/runtime');
      });

      it('has correct metadata.frameworkVersionRange', () => {
        expect(frontmatter.metadata?.frameworkVersionRange).toBe('>=0.5.0 <1.0.0');
      });
    });
  }
});
