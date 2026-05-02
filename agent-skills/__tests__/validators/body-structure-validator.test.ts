// =============================================================================
// Property Test: SKILL.md body structure invariant
// Feature: runtime-web-agent-skills, Property 3: SKILL.md body structure invariant
// Validates: Requirements 13.5, 14.3, 15.6
// =============================================================================

import * as fc from 'fast-check';
import { validateBodyStructure } from '../../scripts/validate-skills';

describe('validateBodyStructure() — Property 3: SKILL.md body structure invariant', () => {
  /**
   * Generates a valid body with correct section order and under 500 lines.
   */
  const validBodyArb = fc
    .record({
      overviewContent: fc.string({ minLength: 1, maxLength: 100 }),
      whenToUseContent: fc.string({ minLength: 1, maxLength: 100 }),
      includeConcepts: fc.boolean(),
      conceptsContent: fc.string({ minLength: 1, maxLength: 100 }),
      instructionsContent: fc.string({ minLength: 1, maxLength: 100 }),
      mistakesContent: fc.string({ minLength: 1, maxLength: 100 }),
      referencesContent: fc.string({ minLength: 1, maxLength: 100 }),
    })
    .map((parts) => {
      const sections = [
        `## Overview\n\n${parts.overviewContent}\n`,
        `## When to Use\n\n${parts.whenToUseContent}\n`,
      ];
      if (parts.includeConcepts) {
        sections.push(`## Core Concepts\n\n${parts.conceptsContent}\n`);
      }
      sections.push(`## Instructions\n\n${parts.instructionsContent}\n`);
      sections.push(`## Common Mistakes\n\n${parts.mistakesContent}\n`);
      sections.push(`## References\n\n${parts.referencesContent}\n`);
      return sections.join('\n');
    });

  it('accepts valid bodies with correct section order and under 500 lines', () => {
    fc.assert(
      fc.property(validBodyArb, (body) => {
        const result = validateBodyStructure(body);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }),
      { numRuns: 200 },
    );
  });

  it('rejects bodies exceeding 500 lines', () => {
    const longBody = fc.constant(
      '## Overview\n\nContent\n\n## When to Use\n\n- Item\n\n## Instructions\n\nContent\n\n## Common Mistakes\n\nContent\n\n## References\n\nContent\n' +
      '\nfiller line'.repeat(500),
    );

    fc.assert(
      fc.property(longBody, (body) => {
        const result = validateBodyStructure(body);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('500 lines'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects bodies missing "Common Mistakes" or "Do NOT" section', () => {
    const noMistakesBody = fc
      .record({
        overviewContent: fc.string({ minLength: 1, maxLength: 50 }),
        instructionsContent: fc.string({ minLength: 1, maxLength: 50 }),
        referencesContent: fc.string({ minLength: 1, maxLength: 50 }),
      })
      .map(
        (parts) =>
          `## Overview\n\n${parts.overviewContent}\n\n## When to Use\n\n- Item\n\n## Instructions\n\n${parts.instructionsContent}\n\n## References\n\n${parts.referencesContent}\n`,
      );

    fc.assert(
      fc.property(noMistakesBody, (body) => {
        const result = validateBodyStructure(body);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('Common Mistakes'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('accepts bodies with "Do NOT" as alternative to "Common Mistakes"', () => {
    const doNotBody = fc
      .string({ minLength: 1, maxLength: 50 })
      .map(
        (content) =>
          `## Overview\n\n${content}\n\n## When to Use\n\n- Item\n\n## Instructions\n\nContent\n\n## Do NOT\n\nContent\n\n## References\n\nContent\n`,
      );

    fc.assert(
      fc.property(doNotBody, (body) => {
        const result = validateBodyStructure(body);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects bodies with incorrect section order', () => {
    // Put "References" before "Common Mistakes"
    const wrongOrderBody = fc
      .string({ minLength: 1, maxLength: 50 })
      .map(
        (content) =>
          `## Overview\n\n${content}\n\n## When to Use\n\n- Item\n\n## Instructions\n\nContent\n\n## References\n\nContent\n\n## Common Mistakes\n\nContent\n`,
      );

    fc.assert(
      fc.property(wrongOrderBody, (body) => {
        const result = validateBodyStructure(body);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('Section order violation'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects bodies where "When to Use" comes before "Overview"', () => {
    const wrongOrderBody2 = fc
      .string({ minLength: 1, maxLength: 50 })
      .map(
        (content) =>
          `## When to Use\n\n- Item\n\n## Overview\n\n${content}\n\n## Instructions\n\nContent\n\n## Common Mistakes\n\nContent\n\n## References\n\nContent\n`,
      );

    fc.assert(
      fc.property(wrongOrderBody2, (body) => {
        const result = validateBodyStructure(body);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('Section order violation'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('accepts bodies with optional "Core Concepts" between "When to Use" and "Instructions"', () => {
    const withConcepts = fc
      .string({ minLength: 1, maxLength: 50 })
      .map(
        (content) =>
          `## Overview\n\n${content}\n\n## When to Use\n\n- Item\n\n## Core Concepts\n\nConcepts here\n\n## Instructions\n\nContent\n\n## Common Mistakes\n\nContent\n\n## References\n\nContent\n`,
      );

    fc.assert(
      fc.property(withConcepts, (body) => {
        const result = validateBodyStructure(body);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });
});
