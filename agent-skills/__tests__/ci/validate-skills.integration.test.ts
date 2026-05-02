// =============================================================================
// End-to-End Integration Test: CI Validation Pipeline
// Feature: runtime-web-agent-skills
// Purpose: Runs the full validation pipeline against the complete skill set.
//          Verifies skills-manifest.json can be generated correctly and all 12
//          skills pass structural validation.
// Validates: Requirements 12.1, 12.3
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import {
  validateSkillName,
  validateFrontmatter,
  validateBodyStructure,
  validateErrorCatalog,
  checkTerminology,
  validateCrossReferences,
  validateLayerAssignment,
  LAYER_ASSIGNMENT,
  ValidationResult,
  SkillFrontmatter,
  ErrorCatalogEntry,
} from '../../scripts/validate-skills';

const SKILLS_ROOT = path.resolve(__dirname, '../../');

const ALL_SKILLS = Object.keys(LAYER_ASSIGNMENT);

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

/**
 * Simulates the full CI validation pipeline for a single skill.
 * Returns aggregated validation results.
 */
function validateSkill(skillName: string): {
  name: ValidationResult;
  frontmatter: ValidationResult;
  body: ValidationResult;
  terminology: ValidationResult;
  layer: ValidationResult;
  crossRefs: ValidationResult;
} {
  const skillPath = path.join(SKILLS_ROOT, skillName, 'SKILL.md');
  const content = fs.readFileSync(skillPath, 'utf-8');
  const frontmatter = parseFrontmatter(content);
  const body = extractBody(content);
  const allSkillNames = new Set(ALL_SKILLS);

  return {
    name: validateSkillName(frontmatter.name ?? '', skillName),
    frontmatter: validateFrontmatter(frontmatter),
    body: validateBodyStructure(body),
    terminology: checkTerminology(content),
    layer: validateLayerAssignment(
      skillName,
      frontmatter.metadata?.layer ?? '',
      frontmatter.metadata?.layerName,
    ),
    crossRefs: validateCrossReferences(content, allSkillNames),
  };
}

/**
 * Generates a skills-manifest.json from current validation state.
 */
function generateManifest(): any {
  const now = new Date().toISOString();
  const skills = ALL_SKILLS.map((skillName) => {
    const results = validateSkill(skillName);
    const allValid = Object.values(results).every((r) => r.valid);
    const allErrors = Object.values(results).flatMap((r) => r.errors);

    return {
      name: skillName,
      layer: LAYER_ASSIGNMENT[skillName].layer,
      versionRange: '>=0.5.0 <1.0.0',
      status: allValid ? 'valid' : 'failed',
      lastValidated: now,
      ...(allErrors.length > 0 ? { validationErrors: allErrors } : {}),
    };
  });

  return {
    version: '1.0.0',
    frameworkVersion: '0.5.0-beta.2',
    skills,
    lastValidated: now,
  };
}

describe('End-to-End CI Validation Pipeline', () => {
  describe('Full validation pipeline runs against all 12 skills', () => {
    const validationResults: Record<string, ReturnType<typeof validateSkill>> = {};

    beforeAll(() => {
      for (const skillName of ALL_SKILLS) {
        validationResults[skillName] = validateSkill(skillName);
      }
    });

    it('all 12 skills are validated', () => {
      expect(Object.keys(validationResults).length).toBe(12);
    });

    for (const skillName of ALL_SKILLS) {
      describe(`${skillName}`, () => {
        it('passes name validation', () => {
          const results = validateSkill(skillName);
          expect(results.name.valid).toBe(true);
          expect(results.name.errors).toEqual([]);
        });

        it('passes frontmatter validation', () => {
          const results = validateSkill(skillName);
          expect(results.frontmatter.valid).toBe(true);
          expect(results.frontmatter.errors).toEqual([]);
        });

        it('passes body structure validation', () => {
          const results = validateSkill(skillName);
          expect(results.body.valid).toBe(true);
          expect(results.body.errors).toEqual([]);
        });

        it('passes terminology check', () => {
          const results = validateSkill(skillName);
          expect(results.terminology.valid).toBe(true);
        });

        it('passes layer assignment validation', () => {
          const results = validateSkill(skillName);
          expect(results.layer.valid).toBe(true);
          expect(results.layer.errors).toEqual([]);
        });

        it('passes cross-reference validation', () => {
          const results = validateSkill(skillName);
          expect(results.crossRefs.valid).toBe(true);
          expect(results.crossRefs.errors).toEqual([]);
        });
      });
    }
  });

  describe('skills-manifest.json generation', () => {
    let manifest: any;

    beforeAll(() => {
      manifest = generateManifest();
    });

    it('generates a valid manifest object', () => {
      expect(manifest).toBeDefined();
      expect(manifest.version).toBe('1.0.0');
      expect(manifest.frameworkVersion).toBe('0.5.0-beta.2');
    });

    it('manifest contains all 12 skills', () => {
      expect(manifest.skills.length).toBe(12);
    });

    it('all skills in manifest have status "valid"', () => {
      const invalidSkills = manifest.skills.filter((s: any) => s.status !== 'valid');
      expect(invalidSkills).toEqual([]);
    });

    it('manifest has lastValidated timestamp', () => {
      expect(manifest.lastValidated).toBeDefined();
      // Should be a valid ISO date string
      expect(new Date(manifest.lastValidated).toISOString()).toBe(manifest.lastValidated);
    });

    it('each skill entry has required fields', () => {
      for (const skill of manifest.skills) {
        expect(skill.name).toBeDefined();
        expect(typeof skill.name).toBe('string');
        expect(skill.layer).toBeDefined();
        expect(typeof skill.layer).toBe('number');
        expect(skill.layer).toBeGreaterThanOrEqual(1);
        expect(skill.layer).toBeLessThanOrEqual(5);
        expect(skill.versionRange).toBe('>=0.5.0 <1.0.0');
        expect(skill.status).toBeDefined();
        expect(['valid', 'outdated', 'failed']).toContain(skill.status);
        expect(skill.lastValidated).toBeDefined();
      }
    });

    it('manifest layer assignments match LAYER_ASSIGNMENT constant', () => {
      for (const skill of manifest.skills) {
        const expected = LAYER_ASSIGNMENT[skill.name];
        expect(expected).toBeDefined();
        expect(skill.layer).toBe(expected.layer);
      }
    });

    it('generated manifest matches existing skills-manifest.json structure', () => {
      const existingManifestPath = path.join(SKILLS_ROOT, 'skills-manifest.json');
      expect(fs.existsSync(existingManifestPath)).toBe(true);

      const existingManifest = JSON.parse(
        fs.readFileSync(existingManifestPath, 'utf-8'),
      );

      // Structural compatibility check
      expect(existingManifest.version).toBe(manifest.version);
      expect(existingManifest.frameworkVersion).toBe(manifest.frameworkVersion);
      expect(existingManifest.skills.length).toBe(manifest.skills.length);

      // All skill names match
      const existingNames = existingManifest.skills.map((s: any) => s.name).sort();
      const generatedNames = manifest.skills.map((s: any) => s.name).sort();
      expect(generatedNames).toEqual(existingNames);
    });
  });

  describe('Error catalog validation as part of pipeline', () => {
    it('error-catalog.json passes schema validation', () => {
      const catalogPath = path.join(
        SKILLS_ROOT,
        'runtime-errors-and-diagnostics',
        'references',
        'error-catalog.json',
      );
      const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));

      // Flatten all errors from all categories
      const allEntries: ErrorCatalogEntry[] = [];
      for (const category of catalog.categories) {
        allEntries.push(...category.errors);
      }

      const result = validateErrorCatalog(allEntries);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });

  describe('Pipeline summary statistics', () => {
    it('reports total validation counts', () => {
      let totalErrors = 0;
      let totalWarnings = 0;
      let passedSkills = 0;

      for (const skillName of ALL_SKILLS) {
        const results = validateSkill(skillName);
        const skillErrors = Object.values(results).flatMap((r) => r.errors);
        const skillWarnings = Object.values(results).flatMap((r) => r.warnings);

        totalErrors += skillErrors.length;
        totalWarnings += skillWarnings.length;

        if (skillErrors.length === 0) {
          passedSkills++;
        }
      }

      // All 12 skills should pass
      expect(passedSkills).toBe(12);
      expect(totalErrors).toBe(0);

      // Log summary for CI visibility
      console.log(`\n  CI Pipeline Summary:`);
      console.log(`    Skills validated: 12`);
      console.log(`    Skills passed: ${passedSkills}`);
      console.log(`    Total errors: ${totalErrors}`);
      console.log(`    Total warnings: ${totalWarnings}\n`);
    });
  });
});
