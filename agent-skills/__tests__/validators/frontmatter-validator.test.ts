// =============================================================================
// Property Test: SKILL.md frontmatter completeness
// Feature: runtime-web-agent-skills, Property 2: SKILL.md frontmatter completeness
// Validates: Requirements 13.3, 13.4, 15.5
// =============================================================================

import * as fc from 'fast-check';
import { validateFrontmatter, SkillFrontmatter } from '../../scripts/validate-skills';

describe('validateFrontmatter() — Property 2: SKILL.md frontmatter completeness', () => {
  /**
   * Arbitrary for valid skill names.
   */
  const validNameArb = fc.array(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
    { minLength: 1, maxLength: 30 },
  ).map((arr) => arr.join(''));

  /**
   * Arbitrary for valid descriptions (1-1024 non-empty chars).
   */
  const validDescriptionArb = fc.string({ minLength: 1, maxLength: 200 }).filter(
    (s) => s.trim().length > 0,
  );

  /**
   * Arbitrary for valid semver ranges.
   */
  const validSemverRangeArb = fc.oneof(
    fc.tuple(fc.nat(9), fc.nat(9), fc.nat(9)).map(([a, b, c]) => `>=${a}.${b}.${c} <${a + 1}.0.0`),
    fc.tuple(fc.nat(9), fc.nat(9), fc.nat(9)).map(([a, b, c]) => `^${a}.${b}.${c}`),
    fc.tuple(fc.nat(9), fc.nat(9), fc.nat(9)).map(([a, b, c]) => `~${a}.${b}.${c}`),
  );

  /**
   * Arbitrary for valid metadata objects.
   */
  const validMetadataArb = fc.record({
    author: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
    version: fc.tuple(fc.nat(9), fc.nat(9), fc.nat(9)).map(([a, b, c]) => `${a}.${b}.${c}`),
    framework: fc.constant('@worktif/runtime'),
    frameworkVersionRange: validSemverRangeArb,
  });

  /**
   * Arbitrary for complete valid frontmatter.
   */
  const validFrontmatterArb: fc.Arbitrary<SkillFrontmatter> = fc.record({
    name: validNameArb,
    description: validDescriptionArb,
    metadata: validMetadataArb,
  }) as fc.Arbitrary<SkillFrontmatter>;

  it('accepts valid frontmatter with all required fields', () => {
    fc.assert(
      fc.property(validFrontmatterArb, (frontmatter) => {
        const result = validateFrontmatter(frontmatter);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }),
      { numRuns: 200 },
    );
  });

  it('rejects frontmatter with missing name', () => {
    const missingName = validFrontmatterArb.map((fm) => {
      const { name, ...rest } = fm;
      void name;
      return rest as Partial<SkillFrontmatter>;
    });

    fc.assert(
      fc.property(missingName, (frontmatter) => {
        const result = validateFrontmatter(frontmatter);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('name'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects frontmatter with missing description', () => {
    const missingDesc = validFrontmatterArb.map((fm) => {
      const { description, ...rest } = fm;
      void description;
      return rest as Partial<SkillFrontmatter>;
    });

    fc.assert(
      fc.property(missingDesc, (frontmatter) => {
        const result = validateFrontmatter(frontmatter);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('description'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects frontmatter with description exceeding 1024 chars', () => {
    const longDesc = validFrontmatterArb.map((fm) => ({
      ...fm,
      description: 'x'.repeat(1025),
    }));

    fc.assert(
      fc.property(longDesc, (frontmatter) => {
        const result = validateFrontmatter(frontmatter);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('1-1024 characters'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects frontmatter with missing metadata', () => {
    const missingMeta = validFrontmatterArb.map((fm) => {
      const { metadata, ...rest } = fm;
      void metadata;
      return rest as Partial<SkillFrontmatter>;
    });

    fc.assert(
      fc.property(missingMeta, (frontmatter) => {
        const result = validateFrontmatter(frontmatter);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('metadata'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects frontmatter with missing metadata.author', () => {
    const missingAuthor = validFrontmatterArb.map((fm) => ({
      ...fm,
      metadata: { ...fm.metadata, author: '' },
    }));

    fc.assert(
      fc.property(missingAuthor, (frontmatter) => {
        const result = validateFrontmatter(frontmatter);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('author'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects frontmatter with missing metadata.version', () => {
    const missingVersion = validFrontmatterArb.map((fm) => ({
      ...fm,
      metadata: { ...fm.metadata, version: '' },
    }));

    fc.assert(
      fc.property(missingVersion, (frontmatter) => {
        const result = validateFrontmatter(frontmatter);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('version'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects frontmatter with invalid frameworkVersionRange', () => {
    const invalidRange = validFrontmatterArb.map((fm) => ({
      ...fm,
      metadata: { ...fm.metadata, frameworkVersionRange: 'not-a-semver' },
    }));

    fc.assert(
      fc.property(invalidRange, (frontmatter) => {
        const result = validateFrontmatter(frontmatter);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('semver range'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('accepts frontmatter with optional license and compatibility fields', () => {
    const withOptional = validFrontmatterArb.map((fm) => ({
      ...fm,
      license: 'Elastic-2.0',
      compatibility: 'Requires @worktif/runtime >=0.5.0 <1.0.0',
    }));

    fc.assert(
      fc.property(withOptional, (frontmatter) => {
        const result = validateFrontmatter(frontmatter);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });
});
