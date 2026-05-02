// =============================================================================
// Example-Based Test: Skill Content Verification
// Feature: runtime-web-agent-skills
// Purpose: Verifies each of the 12 skills has a SKILL.md that parses correctly,
//          pattern skills contain required canonical templates, and error catalog
//          contains entries for all 4 categories.
// Validates: Requirements 13.1, 14.1, 10.1
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { SkillFrontmatter } from '../../scripts/validate-skills';

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

/**
 * Pattern skills and their required canonical templates.
 */
const PATTERN_SKILLS_TEMPLATES: Record<string, string[]> = {
  'runtime-patterns-http': [
    'single-get.ts',
    'crud-microservice.ts',
    'jwt-auth.ts',
    'cognito-auth.ts',
  ],
  'runtime-patterns-async': [
    'sqs-worker.ts',
    'eventbridge-fanout.ts',
    'sns-pubsub.ts',
    'kinesis-processor.ts',
    'scheduled-task.ts',
  ],
  'runtime-patterns-data-events': [
    's3-trigger.ts',
    'dynamodb-stream.ts',
  ],
};

const ERROR_CATALOG_CATEGORIES = ['build', 'deployment', 'runtime', 'type-system'];

/**
 * Parses YAML frontmatter from SKILL.md content.
 * Reuses the same parsing logic as the checkpoint tests.
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

describe('Skill Content Verification', () => {
  describe('All 12 skills have a SKILL.md that parses correctly', () => {
    for (const skillName of ALL_SKILLS) {
      describe(`${skillName}`, () => {
        const skillPath = path.join(SKILLS_ROOT, skillName, 'SKILL.md');

        it('SKILL.md file exists', () => {
          expect(fs.existsSync(skillPath)).toBe(true);
        });

        it('SKILL.md has valid YAML frontmatter', () => {
          const content = fs.readFileSync(skillPath, 'utf-8');
          expect(content.startsWith('---\n')).toBe(true);

          const frontmatter = parseFrontmatter(content);
          expect(frontmatter.name).toBeDefined();
          expect(frontmatter.name).toBe(skillName);
        });

        it('SKILL.md has required metadata fields', () => {
          const content = fs.readFileSync(skillPath, 'utf-8');
          const frontmatter = parseFrontmatter(content);

          expect(frontmatter.metadata).toBeDefined();
          expect(frontmatter.metadata!.author).toBe('worktif');
          expect(frontmatter.metadata!.version).toBeDefined();
          expect(frontmatter.metadata!.framework).toBe('@worktif/runtime');
          expect(frontmatter.metadata!.frameworkVersionRange).toBe('>=0.5.0 <1.0.0');
        });

        it('SKILL.md has a description', () => {
          const content = fs.readFileSync(skillPath, 'utf-8');
          const frontmatter = parseFrontmatter(content);

          expect(frontmatter.description).toBeDefined();
          expect(frontmatter.description!.length).toBeGreaterThan(0);
          expect(frontmatter.description!.length).toBeLessThanOrEqual(1024);
        });

        it('SKILL.md body has content after frontmatter', () => {
          const content = fs.readFileSync(skillPath, 'utf-8');
          const fmEnd = content.indexOf('---', 4);
          expect(fmEnd).toBeGreaterThan(0);

          const body = content.substring(fmEnd + 3).trim();
          expect(body.length).toBeGreaterThan(0);
        });

        it('SKILL.md body contains an Overview section', () => {
          const content = fs.readFileSync(skillPath, 'utf-8');
          const fmEnd = content.indexOf('---', 4);
          const body = content.substring(fmEnd + 3);

          expect(body).toMatch(/^#{1,3}\s+Overview/m);
        });

        it('SKILL.md body contains a Common Mistakes or Do NOT section', () => {
          const content = fs.readFileSync(skillPath, 'utf-8');
          const fmEnd = content.indexOf('---', 4);
          const body = content.substring(fmEnd + 3);

          const hasSection = /^#{1,3}\s+(Common Mistakes|Do NOT)/m.test(body);
          expect(hasSection).toBe(true);
        });
      });
    }
  });

  describe('Pattern skills contain required canonical templates', () => {
    for (const [skillName, templates] of Object.entries(PATTERN_SKILLS_TEMPLATES)) {
      describe(`${skillName}`, () => {
        const templatesDir = path.join(SKILLS_ROOT, skillName, 'references', 'templates');

        it('templates directory exists', () => {
          expect(fs.existsSync(templatesDir)).toBe(true);
        });

        for (const templateFile of templates) {
          it(`contains template: ${templateFile}`, () => {
            const templatePath = path.join(templatesDir, templateFile);
            expect(fs.existsSync(templatePath)).toBe(true);
          });

          it(`template ${templateFile} is non-empty`, () => {
            const templatePath = path.join(templatesDir, templateFile);
            const content = fs.readFileSync(templatePath, 'utf-8');
            expect(content.trim().length).toBeGreaterThan(0);
          });

          it(`template ${templateFile} imports from @worktif/runtime`, () => {
            const templatePath = path.join(templatesDir, templateFile);
            const content = fs.readFileSync(templatePath, 'utf-8');
            // Templates should reference the framework types
            const hasFrameworkImport = content.includes('@worktif/runtime') ||
              content.includes('LambdaDefinition') ||
              content.includes('MicroserviceDefinition');
            expect(hasFrameworkImport).toBe(true);
          });
        }
      });
    }
  });

  describe('SSR skill (runtime-ssr-and-web) has reference material', () => {
    it('has references directory', () => {
      const refsDir = path.join(SKILLS_ROOT, 'runtime-ssr-and-web', 'references');
      expect(fs.existsSync(refsDir)).toBe(true);
    });

    it('has ssr-constraints.md reference', () => {
      const constraintsPath = path.join(
        SKILLS_ROOT,
        'runtime-ssr-and-web',
        'references',
        'ssr-constraints.md',
      );
      expect(fs.existsSync(constraintsPath)).toBe(true);
      const content = fs.readFileSync(constraintsPath, 'utf-8');
      expect(content.trim().length).toBeGreaterThan(0);
    });
  });

  describe('Error catalog contains entries for all 4 categories', () => {
    const catalogPath = path.join(
      SKILLS_ROOT,
      'runtime-errors-and-diagnostics',
      'references',
      'error-catalog.json',
    );

    let catalog: any;

    beforeAll(() => {
      const content = fs.readFileSync(catalogPath, 'utf-8');
      catalog = JSON.parse(content);
    });

    it('error-catalog.json exists and is valid JSON', () => {
      expect(fs.existsSync(catalogPath)).toBe(true);
      expect(catalog).toBeDefined();
    });

    it('has version field', () => {
      expect(catalog.version).toBeDefined();
      expect(typeof catalog.version).toBe('string');
    });

    it('has frameworkVersionRange field', () => {
      expect(catalog.frameworkVersionRange).toBeDefined();
      expect(catalog.frameworkVersionRange).toBe('>=0.5.0 <1.0.0');
    });

    it('has categories array', () => {
      expect(Array.isArray(catalog.categories)).toBe(true);
      expect(catalog.categories.length).toBeGreaterThanOrEqual(4);
    });

    for (const category of ERROR_CATALOG_CATEGORIES) {
      it(`contains "${category}" category`, () => {
        const found = catalog.categories.find((c: any) => c.category === category);
        expect(found).toBeDefined();
      });

      it(`"${category}" category has at least one error entry`, () => {
        const found = catalog.categories.find((c: any) => c.category === category);
        expect(found).toBeDefined();
        expect(Array.isArray(found.errors)).toBe(true);
        expect(found.errors.length).toBeGreaterThanOrEqual(1);
      });

      it(`"${category}" entries have required fields (id, pattern, meaning, causes, resolution)`, () => {
        const found = catalog.categories.find((c: any) => c.category === category);
        for (const entry of found.errors) {
          expect(entry.id).toBeDefined();
          expect(typeof entry.id).toBe('string');
          expect(entry.pattern).toBeDefined();
          expect(typeof entry.pattern).toBe('string');
          expect(entry.meaning).toBeDefined();
          expect(typeof entry.meaning).toBe('string');
          expect(Array.isArray(entry.causes)).toBe(true);
          expect(entry.causes.length).toBeGreaterThan(0);
          expect(Array.isArray(entry.resolution)).toBe(true);
          expect(entry.resolution.length).toBeGreaterThan(0);
        }
      });
    }

    it('all error IDs are unique across categories', () => {
      const allIds: string[] = [];
      for (const cat of catalog.categories) {
        for (const entry of cat.errors) {
          allIds.push(entry.id);
        }
      }
      const uniqueIds = new Set(allIds);
      expect(uniqueIds.size).toBe(allIds.length);
    });
  });
});
