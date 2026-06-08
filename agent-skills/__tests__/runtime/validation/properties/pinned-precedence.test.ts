/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Property test — Pinned precedence — Task 6.4
//
// Property 12 (design.md §"Correctness Properties" — Pinned precedence):
//   For pinned-subset members, the PINNED layer/category overrides any inferred
//   classification on the validation path. The validator's precedence rule is
//   `expected = pinned?.get(skillName) ?? overlay.layerAssignment[skillName]`,
//   so when a pinned entry exists for a skill it is the SOLE authority for that
//   skill's layer/category and the overlay's inferred value is NOT consulted.
//   (Extended to the classification path in Task 10.3.)
//   **Validates: Requirements 8.8**
//
// These tests drive the REAL `validateLayerAssignment` engine over the REAL
// `PUBLISHED_OVERLAY` data (no mocking). The pinned map is the only thing varied,
// so the assertions isolate the precedence rule itself.
//
// Validates: Requirements 8.8
// =============================================================================

import * as fc from 'fast-check';

import {
  validateLayerAssignment,
} from '../../../../scripts/validate-skills.js';
import {
  PUBLISHED_OVERLAY,
  type LayerAssignmentEntry,
} from '../../../../runtime/validation/profile.js';

// -----------------------------------------------------------------------------
// Generators
// -----------------------------------------------------------------------------

/** The published collection's overlay-categorized skill names. */
const PUBLISHED_KEYS = Object.keys(PUBLISHED_OVERLAY.layerAssignment);
const PUBLISHED_KEY_SET = new Set(PUBLISHED_KEYS);

/** Arbitrary layer number in the valid 1-5 range. */
const layerArb = fc.integer({ min: 1, max: 5 });

/**
 * A small pool of layer names so a generated pinned `layerName` can both match
 * and differ from an overlay entry's name across runs.
 */
const layerNameArb = fc.constantFrom(
  'Concepts',
  'API',
  'Patterns',
  'Guardrails',
  'Diagnostics',
  'Custom',
);

/** A pinned classification entry {layer, layerName}. */
const pinnedEntryArb: fc.Arbitrary<LayerAssignmentEntry> = fc.record({
  layer: layerArb,
  layerName: layerNameArb,
});

/** A skill name guaranteed ABSENT from the published overlay. */
const externalNameArb = fc
  .stringMatching(/^[a-z]{1,8}$/)
  .map((s) => `ext-${s}`)
  .filter((name) => !PUBLISHED_KEY_SET.has(name));

/** Build a single-entry pinned map. */
function pinnedMap(name: string, entry: LayerAssignmentEntry): ReadonlyMap<string, LayerAssignmentEntry> {
  return new Map<string, LayerAssignmentEntry>([[name, entry]]);
}

// =============================================================================
// Property 12a — Pinned overrides the overlay for a published (overlay-known) name
//
// Generate a published skill name (which the overlay WOULD categorize) plus a
// pinned entry whose layer DIFFERS from the overlay's. The pinned classification
// must be the sole authority:
//   - declaring the PINNED layer/name validates clean (pinned wins), and
//   - declaring the OVERLAY layer is a fatal mismatch (the overlay value is NOT
//     used when a pinned entry is present).
// =============================================================================

describe('Property 12a: pinned overrides overlay inference (Req 8.8)', () => {
  it('uses the pinned layer/category, ignoring the overlay, for an overlay-known name', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PUBLISHED_KEYS),
        pinnedEntryArb,
        (skillName, pinnedEntry) => {
          const overlayEntry = PUBLISHED_OVERLAY.layerAssignment[skillName];

          // Only exercise inputs where the pinned layer genuinely DIFFERS from the
          // overlay's inferred layer, so "pinned wins" is observable rather than
          // trivially equal to the overlay outcome.
          fc.pre(pinnedEntry.layer !== overlayEntry.layer);

          const pinned = pinnedMap(skillName, pinnedEntry);

          // (1) Declaring the PINNED values validates clean — pinned is authoritative.
          const pinnedDeclared = validateLayerAssignment(
            skillName,
            pinnedEntry.layer,
            pinnedEntry.layerName,
            PUBLISHED_OVERLAY,
            pinned,
          );
          expect(pinnedDeclared.valid).toBe(true);
          expect(pinnedDeclared.errors).toHaveLength(0);
          // A pinned-categorized skill is NOT an uncategorized fallback.
          expect(
            pinnedDeclared.warnings.some((w) => /custom\/uncategorized/i.test(w)),
          ).toBe(false);

          // (2) Declaring the OVERLAY layer is a fatal mismatch, because the overlay
          //     value is NOT consulted when a pinned entry is present.
          const overlayDeclared = validateLayerAssignment(
            skillName,
            overlayEntry.layer,
            overlayEntry.layerName,
            PUBLISHED_OVERLAY,
            pinned,
          );
          expect(overlayDeclared.valid).toBe(false);
          expect(overlayDeclared.errors.some((e) => e.includes('Layer mismatch'))).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

// =============================================================================
// Property 12b — Pinned categorizes a name the overlay does NOT know
//
// A pinned entry for a name absent from the overlay makes that name categorized
// (no uncategorized fallback): declaring the pinned values validates clean, and a
// wrong declared layer is a fatal mismatch — proving the pinned entry, not the
// overlay, is the source of truth.
// =============================================================================

describe('Property 12b: pinned categorizes an overlay-unknown name (Req 8.8)', () => {
  it('categorizes via pinned metadata with no uncategorized fallback', () => {
    fc.assert(
      fc.property(externalNameArb, pinnedEntryArb, (name, pinnedEntry) => {
        const pinned = pinnedMap(name, pinnedEntry);

        const declared = validateLayerAssignment(
          name,
          pinnedEntry.layer,
          pinnedEntry.layerName,
          PUBLISHED_OVERLAY,
          pinned,
        );
        expect(declared.valid).toBe(true);
        expect(declared.errors).toHaveLength(0);
        // Pinned presence means categorized — NOT the custom/uncategorized fallback.
        expect(declared.warnings.some((w) => /custom\/uncategorized/i.test(w))).toBe(false);

        // A wrong declared layer against the pinned entry is fatal.
        const wrongLayer = pinnedEntry.layer === 5 ? 1 : pinnedEntry.layer + 1;
        const wrong = validateLayerAssignment(
          name,
          wrongLayer,
          pinnedEntry.layerName,
          PUBLISHED_OVERLAY,
          pinned,
        );
        expect(wrong.valid).toBe(false);
        expect(wrong.errors.some((e) => e.includes('Layer mismatch'))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

// =============================================================================
// Property 12c — Neither pinned nor overlay → non-fatal uncategorized fallback
//
// When a name has no pinned entry AND no overlay entry, the validator must NOT
// be fatal: it assigns the custom/uncategorized fallback with a non-fatal warning
// (the boundary condition that makes pinned/overlay precedence meaningful).
// =============================================================================

describe('Property 12c: no pinned & no overlay → uncategorized fallback (Req 8.8)', () => {
  it('returns a non-fatal custom/uncategorized warning, never a fatal unknown error', () => {
    fc.assert(
      fc.property(externalNameArb, layerArb, layerNameArb, (name, declaredLayer, declaredLayerName) => {
        // Empty pinned map: the name is neither pinned nor in the published overlay.
        const result = validateLayerAssignment(
          name,
          declaredLayer,
          declaredLayerName,
          PUBLISHED_OVERLAY,
          new Map<string, LayerAssignmentEntry>(),
        );
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
        expect(result.warnings.some((w) => /custom\/uncategorized/i.test(w))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

// =============================================================================
// Explicit example — a single, concrete pinned-overrides-overlay case.
// `runtime-concepts` is overlay layer 1 (Concepts); pinning it to layer 4
// (Guardrails) makes the pinned value authoritative.
// =============================================================================

describe('Property 12: explicit pinned-overrides-overlay example (Req 8.8)', () => {
  it('pins runtime-concepts to layer 4, overriding its overlay layer 1', () => {
    const name = 'runtime-concepts';
    expect(PUBLISHED_OVERLAY.layerAssignment[name]).toEqual({ layer: 1, layerName: 'Concepts' });

    const pinned = pinnedMap(name, { layer: 4, layerName: 'Guardrails' });

    // Pinned value validates clean.
    const okPinned = validateLayerAssignment(name, 4, 'Guardrails', PUBLISHED_OVERLAY, pinned);
    expect(okPinned.valid).toBe(true);
    expect(okPinned.errors).toHaveLength(0);

    // The original overlay value is now a fatal mismatch.
    const overlayMismatch = validateLayerAssignment(name, 1, 'Concepts', PUBLISHED_OVERLAY, pinned);
    expect(overlayMismatch.valid).toBe(false);
    expect(overlayMismatch.errors.some((e) => e.includes('Layer mismatch'))).toBe(true);
  });
});
