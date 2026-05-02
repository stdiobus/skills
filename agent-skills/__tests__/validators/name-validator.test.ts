// =============================================================================
// Property Test: SKILL.md name field validation
// Feature: runtime-web-agent-skills, Property 1: SKILL.md name field validation
// Validates: Requirements 13.2
// =============================================================================

import * as fc from 'fast-check';
import { validateSkillName } from '../../scripts/validate-skills';

/**
 * Helper arbitraries for generating strings from specific character sets.
 */
const LOWER_ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
const LOWER_ALNUM_HYPHEN = 'abcdefghijklmnopqrstuvwxyz0123456789-'.split('');
const UPPER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

function charsToString(minLen: number, maxLen: number, chars: string[]): fc.Arbitrary<string> {
  return fc.array(fc.constantFrom(...chars), { minLength: minLen, maxLength: maxLen })
    .map((arr) => arr.join(''));
}

describe('validateSkillName() — Property 1: SKILL.md name field validation', () => {
  /**
   * Helper: checks if a string satisfies ALL naming rules independently.
   */
  function satisfiesAllRules(name: string, directoryName?: string): boolean {
    if (typeof name !== 'string' || name.length === 0) return false;
    if (name.length > 64) return false;
    if (!/^[a-z0-9-]+$/.test(name)) return false;
    if (name.startsWith('-')) return false;
    if (name.endsWith('-')) return false;
    if (/--/.test(name)) return false;
    if (directoryName !== undefined && name !== directoryName) return false;
    return true;
  }

  /**
   * Generates valid skill names by building segments separated by single hyphens.
   * Guarantees: no start/end hyphen, no consecutive hyphens, only lowercase alnum + hyphens.
   */
  const validNameArb = fc
    .array(
      charsToString(1, 12, LOWER_ALNUM),
      { minLength: 1, maxLength: 5 },
    )
    .map((parts) => parts.join('-'))
    .filter((s) => s.length >= 1 && s.length <= 64);

  it('accepts valid names that satisfy all rules', () => {
    fc.assert(
      fc.property(validNameArb, (name) => {
        const result = validateSkillName(name, name);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }),
      { numRuns: 200 },
    );
  });

  it('rejects names longer than 64 characters', () => {
    const longName = charsToString(65, 100, LOWER_ALNUM);

    fc.assert(
      fc.property(longName, (name) => {
        const result = validateSkillName(name);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('1-64 characters'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects names with uppercase characters', () => {
    const nameWithUpper = fc
      .tuple(
        charsToString(1, 10, LOWER_ALNUM),
        fc.constantFrom(...UPPER_CHARS),
        charsToString(1, 10, LOWER_ALNUM),
      )
      .map(([a, upper, b]) => a + upper + b);

    fc.assert(
      fc.property(nameWithUpper, (name) => {
        const result = validateSkillName(name);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('lowercase alphanumeric'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects names starting with a hyphen', () => {
    const nameStartHyphen = charsToString(1, 30, LOWER_ALNUM).map((s) => '-' + s);

    fc.assert(
      fc.property(nameStartHyphen, (name) => {
        const result = validateSkillName(name);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('start with a hyphen'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects names ending with a hyphen', () => {
    const nameEndHyphen = charsToString(1, 30, LOWER_ALNUM).map((s) => s + '-');

    fc.assert(
      fc.property(nameEndHyphen, (name) => {
        const result = validateSkillName(name);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('end with a hyphen'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects names with consecutive hyphens', () => {
    const nameConsecutiveHyphens = fc
      .tuple(
        charsToString(1, 20, LOWER_ALNUM),
        charsToString(1, 20, LOWER_ALNUM),
      )
      .map(([a, b]) => `${a}--${b}`);

    fc.assert(
      fc.property(nameConsecutiveHyphens, (name) => {
        const result = validateSkillName(name);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('consecutive hyphens'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects names that do not match directory name', () => {
    const mismatchedPair = fc
      .tuple(
        charsToString(1, 20, LOWER_ALNUM),
        charsToString(1, 20, LOWER_ALNUM),
      )
      .filter(([a, b]) => a !== b);

    fc.assert(
      fc.property(mismatchedPair, ([name, dir]) => {
        const result = validateSkillName(name, dir);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('must match parent directory'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('validator accepts iff all rules are satisfied (bidirectional property)', () => {
    // Generate a mix of valid and invalid strings
    const anyString = fc.oneof(
      // Valid names
      validNameArb,
      // Names with uppercase
      fc.tuple(
        charsToString(0, 10, LOWER_ALNUM),
        fc.constantFrom(...UPPER_CHARS),
        charsToString(0, 10, LOWER_ALNUM),
      ).map(([a, u, b]) => a + u + b),
      // Names with hyphens (may be invalid)
      charsToString(1, 30, LOWER_ALNUM_HYPHEN),
      // Empty string
      fc.constant(''),
    );

    fc.assert(
      fc.property(anyString, (name) => {
        const result = validateSkillName(name, name);
        const shouldBeValid = satisfiesAllRules(name, name);
        expect(result.valid).toBe(shouldBeValid);
      }),
      { numRuns: 200 },
    );
  });
});
