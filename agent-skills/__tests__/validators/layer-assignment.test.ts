// =============================================================================
// Property Tests: Layer assignment and cross-references
// Feature: runtime-web-agent-skills
// Property 8: Layer assignment correctness
// Property 9: Cross-reference layer annotation
// Validates: Requirements 16.1–16.5, 16.7
// =============================================================================

import * as fc from 'fast-check';
import {
  validateLayerAssignment,
  validateCrossReferences,
  LAYER_ASSIGNMENT,
} from '../../scripts/validate-skills';

const ALL_SKILL_NAMES = Object.keys(LAYER_ASSIGNMENT);
const ALL_SKILLS_SET = new Set(ALL_SKILL_NAMES);

describe('validateLayerAssignment() — Property 8: Layer assignment correctness', () => {
  /**
   * Arbitrary for a valid skill name from the 12-skill set.
   */
  const validSkillNameArb = fc.constantFrom(...ALL_SKILL_NAMES);

  it('accepts correct layer assignments for all known skills', () => {
    fc.assert(
      fc.property(validSkillNameArb, (skillName) => {
        const expected = LAYER_ASSIGNMENT[skillName];
        const result = validateLayerAssignment(
          skillName,
          expected.layer,
          expected.layerName,
        );
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });

  it('accepts correct layer as string', () => {
    fc.assert(
      fc.property(validSkillNameArb, (skillName) => {
        const expected = LAYER_ASSIGNMENT[skillName];
        const result = validateLayerAssignment(
          skillName,
          String(expected.layer),
          expected.layerName,
        );
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects incorrect layer numbers', () => {
    const wrongLayer = fc.tuple(
      validSkillNameArb,
      fc.integer({ min: 1, max: 5 }),
    ).filter(([name, layer]) => LAYER_ASSIGNMENT[name].layer !== layer);

    fc.assert(
      fc.property(wrongLayer, ([skillName, wrongLayerNum]) => {
        const expected = LAYER_ASSIGNMENT[skillName];
        const result = validateLayerAssignment(
          skillName,
          wrongLayerNum,
          expected.layerName,
        );
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('Layer mismatch'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects incorrect layer names', () => {
    const allLayerNames = ['Concepts', 'API', 'Patterns', 'Guardrails', 'Diagnostics'];
    const wrongLayerName = fc.tuple(
      validSkillNameArb,
      fc.constantFrom(...allLayerNames),
    ).filter(([name, layerName]) => LAYER_ASSIGNMENT[name].layerName !== layerName);

    fc.assert(
      fc.property(wrongLayerName, ([skillName, wrongName]) => {
        const expected = LAYER_ASSIGNMENT[skillName];
        const result = validateLayerAssignment(
          skillName,
          expected.layer,
          wrongName,
        );
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('Layer name mismatch'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects unknown skill names', () => {
    const unknownName = fc.array(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
      { minLength: 5, maxLength: 30 },
    ).map((arr) => arr.join(''))
      .filter((s) => !ALL_SKILL_NAMES.includes(s));

    fc.assert(
      fc.property(unknownName, (skillName) => {
        const result = validateLayerAssignment(skillName, 1, 'Concepts');
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('Unknown skill name'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects non-numeric layer values', () => {
    fc.assert(
      fc.property(validSkillNameArb, (skillName) => {
        const result = validateLayerAssignment(skillName, 'abc');
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('Invalid layer value'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

describe('validateCrossReferences() — Property 9: Cross-reference layer annotation', () => {
  /**
   * Generates valid cross-reference markdown with correct layer annotations.
   */
  const validCrossRefArb = fc
    .constantFrom(...ALL_SKILL_NAMES)
    .map((skillName) => {
      const { layer, layerName } = LAYER_ASSIGNMENT[skillName];
      return `See [${skillName}](../${skillName}/SKILL.md) (Layer ${layer}: ${layerName}) for details.`;
    });

  /**
   * Generates content with multiple valid cross-references.
   */
  const validContentArb = fc
    .array(validCrossRefArb, { minLength: 1, maxLength: 5 })
    .map((refs) => refs.join('\n\n'));

  it('accepts valid cross-references with correct layer annotations', () => {
    fc.assert(
      fc.property(validContentArb, (content) => {
        const result = validateCrossReferences(content, ALL_SKILLS_SET);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }),
      { numRuns: 200 },
    );
  });

  it('rejects cross-references to non-existent skills', () => {
    const nonExistentRef = fc.array(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
      { minLength: 5, maxLength: 20 },
    ).map((arr) => arr.join(''))
      .filter((s) => !ALL_SKILL_NAMES.includes(s))
      .map(
        (fakeName) =>
          `See [${fakeName}](../${fakeName}/SKILL.md) (Layer 1: Concepts) for details.`,
      );

    fc.assert(
      fc.property(nonExistentRef, (content) => {
        const result = validateCrossReferences(content, ALL_SKILLS_SET);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('non-existent skill'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects cross-references with missing layer annotations', () => {
    const missingAnnotation = fc
      .constantFrom(...ALL_SKILL_NAMES)
      .map(
        (skillName) =>
          `See [${skillName}](../${skillName}/SKILL.md) for details.`,
      );

    fc.assert(
      fc.property(missingAnnotation, (content) => {
        const result = validateCrossReferences(content, ALL_SKILLS_SET);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('missing layer annotation'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects cross-references with wrong layer number', () => {
    const wrongLayerNum = fc
      .tuple(
        fc.constantFrom(...ALL_SKILL_NAMES),
        fc.integer({ min: 1, max: 5 }),
      )
      .filter(([name, layer]) => LAYER_ASSIGNMENT[name].layer !== layer)
      .map(([skillName, wrongLayer]) => {
        const { layerName } = LAYER_ASSIGNMENT[skillName];
        return `See [${skillName}](../${skillName}/SKILL.md) (Layer ${wrongLayer}: ${layerName}) for details.`;
      });

    fc.assert(
      fc.property(wrongLayerNum, (content) => {
        const result = validateCrossReferences(content, ALL_SKILLS_SET);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('wrong layer number'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects cross-references with wrong layer name', () => {
    const allLayerNames = ['Concepts', 'API', 'Patterns', 'Guardrails', 'Diagnostics'];
    const wrongLayerName = fc
      .tuple(
        fc.constantFrom(...ALL_SKILL_NAMES),
        fc.constantFrom(...allLayerNames),
      )
      .filter(([name, layerName]) => LAYER_ASSIGNMENT[name].layerName !== layerName)
      .map(([skillName, wrongName]) => {
        const { layer } = LAYER_ASSIGNMENT[skillName];
        return `See [${skillName}](../${skillName}/SKILL.md) (Layer ${layer}: ${wrongName}) for details.`;
      });

    fc.assert(
      fc.property(wrongLayerName, (content) => {
        const result = validateCrossReferences(content, ALL_SKILLS_SET);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('wrong layer name'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('accepts content with no cross-references', () => {
    const noRefs = fc.string({ minLength: 0, maxLength: 200 }).filter(
      (s) => !s.includes('../') || !s.includes('SKILL.md'),
    );

    fc.assert(
      fc.property(noRefs, (content) => {
        const result = validateCrossReferences(content, ALL_SKILLS_SET);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });
});
