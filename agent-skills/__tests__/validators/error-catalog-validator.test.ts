// =============================================================================
// Property Test: Error catalog schema conformance
// Feature: runtime-web-agent-skills, Property 5: Error catalog schema conformance
// Validates: Requirements 10.1
// =============================================================================

import * as fc from 'fast-check';
import { validateErrorCatalog, ErrorCatalogEntry } from '../../scripts/validate-skills';

describe('validateErrorCatalog() — Property 5: Error catalog schema conformance', () => {
  /**
   * Arbitrary for a valid resolution step.
   */
  const validResolutionStepArb = fc.record({
    step: fc.nat(100),
    action: fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
    code: fc.option(fc.string({ minLength: 1, maxLength: 200 }), { nil: undefined }),
  });

  /**
   * Arbitrary for a valid error catalog entry.
   */
  const validEntryArb: fc.Arbitrary<ErrorCatalogEntry> = fc.record({
    id: fc.array(
      fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-'.split('')),
      { minLength: 1, maxLength: 20 },
    ).map((arr) => arr.join('')),
    pattern: fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
    meaning: fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
    causes: fc.array(
      fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
      { minLength: 1, maxLength: 5 },
    ),
    resolution: fc.array(validResolutionStepArb, { minLength: 1, maxLength: 5 }),
  });

  /**
   * Arbitrary for an array of valid entries with unique IDs.
   */
  const validEntriesArb = fc
    .array(validEntryArb, { minLength: 1, maxLength: 10 })
    .map((entries) => {
      // Ensure unique IDs by appending index
      return entries.map((e, i) => ({ ...e, id: `${e.id}-${i}` }));
    });

  it('accepts valid error catalog entries with all required fields', () => {
    fc.assert(
      fc.property(validEntriesArb, (entries) => {
        const result = validateErrorCatalog(entries);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }),
      { numRuns: 200 },
    );
  });

  it('rejects entries with missing id', () => {
    const missingId = validEntriesArb.map((entries) =>
      entries.map((e, i) => (i === 0 ? { ...e, id: '' } : e)),
    );

    fc.assert(
      fc.property(missingId, (entries) => {
        const result = validateErrorCatalog(entries as Partial<ErrorCatalogEntry>[]);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('id'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects entries with duplicate ids', () => {
    const duplicateIds = validEntryArb.map((entry) => [
      { ...entry, id: 'SAME-ID' },
      { ...entry, id: 'SAME-ID' },
    ]);

    fc.assert(
      fc.property(duplicateIds, (entries) => {
        const result = validateErrorCatalog(entries);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('Duplicate id'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects entries with missing pattern', () => {
    const missingPattern = validEntriesArb.map((entries) =>
      entries.map((e, i) => (i === 0 ? { ...e, pattern: '' } : e)),
    );

    fc.assert(
      fc.property(missingPattern, (entries) => {
        const result = validateErrorCatalog(entries as Partial<ErrorCatalogEntry>[]);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('pattern'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects entries with missing meaning', () => {
    const missingMeaning = validEntriesArb.map((entries) =>
      entries.map((e, i) => (i === 0 ? { ...e, meaning: '' } : e)),
    );

    fc.assert(
      fc.property(missingMeaning, (entries) => {
        const result = validateErrorCatalog(entries as Partial<ErrorCatalogEntry>[]);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('meaning'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects entries with empty causes array', () => {
    const emptyCauses = validEntriesArb.map((entries) =>
      entries.map((e, i) => (i === 0 ? { ...e, causes: [] } : e)),
    );

    fc.assert(
      fc.property(emptyCauses, (entries) => {
        const result = validateErrorCatalog(entries as Partial<ErrorCatalogEntry>[]);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('causes'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects entries with empty resolution array', () => {
    const emptyResolution = validEntriesArb.map((entries) =>
      entries.map((e, i) => (i === 0 ? { ...e, resolution: [] } : e)),
    );

    fc.assert(
      fc.property(emptyResolution, (entries) => {
        const result = validateErrorCatalog(entries as Partial<ErrorCatalogEntry>[]);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('resolution'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects resolution steps with missing action', () => {
    const missingAction = validEntriesArb.map((entries) =>
      entries.map((e, i) =>
        i === 0
          ? { ...e, resolution: [{ step: 1, action: '' }] }
          : e,
      ),
    );

    fc.assert(
      fc.property(missingAction, (entries) => {
        const result = validateErrorCatalog(entries as Partial<ErrorCatalogEntry>[]);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('action'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects resolution steps with non-number step field', () => {
    const badStep = validEntriesArb.map((entries) =>
      entries.map((e, i) =>
        i === 0
          ? { ...e, resolution: [{ step: 'one' as unknown as number, action: 'do something' }] }
          : e,
      ),
    );

    fc.assert(
      fc.property(badStep, (entries) => {
        const result = validateErrorCatalog(entries as Partial<ErrorCatalogEntry>[]);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('step') && e.includes('number'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
