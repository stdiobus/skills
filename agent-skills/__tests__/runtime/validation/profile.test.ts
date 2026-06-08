/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Unit tests for declarative profile/overlay validation (Migration Step 4, Task 6.3)
//
// Subject: the re-parameterized validator engine in
// `agent-skills/scripts/validate-skills.ts`, reading rules from the declarative
// `BASE_PROFILE` / `PUBLISHED_OVERLAY` data in
// `agent-skills/runtime/validation/profile.ts`.
//
// These tests exercise the REAL validators and REAL profile/overlay data (no
// mocking). They assert four behaviors required by Requirement 8:
//
//   1. The base `agentskills.io` profile applies to ALL skills regardless of
//      provider — an external (non-published) skill is held to exactly the same
//      structural name/frontmatter/body rules as a published one (Req 8.1, 8.7).
//   2. The published overlay (layer-assignment + terminology) applies ONLY to the
//      published collection and NOT to external skills; supplying a different
//      collection overlay changes behavior, proving the overlay is collection-scoped
//      (Req 8.2, 8.3).
//   3. A resolved-but-uncategorized skill yields a non-fatal warning + a
//      custom/uncategorized fallback instead of the former fatal "Unknown skill
//      name" error (Req 8.4, 8.6).
//   4. Current CI behavior for the published collection is preserved: every
//      published skill passes with its declared layer, and a wrong declared layer
//      for a known skill is still a fatal error (regression guard).
//
// Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.6
// =============================================================================

import {
  validateSkillName,
  validateFrontmatter,
  validateBodyStructure,
  checkTerminology,
  validateLayerAssignment,
  LAYER_ASSIGNMENT,
  type SkillFrontmatter,
} from '../../../scripts/validate-skills.js';
import {
  BASE_PROFILE,
  PUBLISHED_OVERLAY,
  type ValidationOverlay,
} from '../../../runtime/validation/profile.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A skill name that is intentionally NOT in the published overlay. */
const EXTERNAL_NAME = 'acme-external-skill';

/** A published skill name (present in the overlay). */
const PUBLISHED_NAME = 'runtime-concepts';

/** Sanity: the external fixture must not collide with the published collection. */
const PUBLISHED_NAMES = Object.keys(PUBLISHED_OVERLAY.layerAssignment);

/** A valid frontmatter object for an external skill (passes the base profile). */
function validExternalFrontmatter(): SkillFrontmatter {
  return {
    name: EXTERNAL_NAME,
    description: 'A valid external skill that conforms to the base structural profile.',
    license: 'Elastic-2.0',
    metadata: {
      author: 'Acme Corp',
      version: '1.0.0',
      framework: 'acme-runtime',
      frameworkVersionRange: '>=1.0.0 <2.0.0',
    },
  };
}

/** A well-formed body with all canonical sections in the required order. */
const VALID_BODY = [
  '## Overview',
  'An external skill body used to exercise the base profile.',
  '',
  '## When to Use',
  'When demonstrating that the base profile is provider-agnostic.',
  '',
  '## Core Concepts',
  'Concepts go here.',
  '',
  '## Instructions',
  'Steps go here.',
  '',
  '## Common Mistakes',
  '- ❌ Wrong thing. ✅ Right thing.',
  '',
  '## References',
  '- See related material.',
  '',
].join('\n');

/** A custom overlay for a DIFFERENT collection (not the published one). */
const ACME_OVERLAY: ValidationOverlay = {
  id: 'acme.collection',
  appliesToCollection: 'acme.collection',
  layerAssignment: {
    [EXTERNAL_NAME]: { layer: 2, layerName: 'API' },
  },
  terminology: [],
};

// ---------------------------------------------------------------------------
// 1. Base profile applies to ALL skills regardless of provider (Req 8.1, 8.7)
// ---------------------------------------------------------------------------

describe('base profile applies to all skills (Req 8.1, 8.7)', () => {
  it('confirms the external fixture name is outside the published collection', () => {
    expect(PUBLISHED_NAMES).not.toContain(EXTERNAL_NAME);
  });

  it('accepts a valid external name under the base profile, just like a published name', () => {
    const external = validateSkillName(EXTERNAL_NAME, EXTERNAL_NAME);
    const published = validateSkillName(PUBLISHED_NAME, PUBLISHED_NAME);

    expect(external.valid).toBe(true);
    expect(external.errors).toHaveLength(0);
    // The same structural rules pass a published name — the profile is provider-agnostic.
    expect(published.valid).toBe(true);
    expect(published.errors).toHaveLength(0);
  });

  it('rejects an invalid external name under the base rules (uppercase + leading hyphen)', () => {
    const result = validateSkillName('-Acme_External', '-Acme_External', BASE_PROFILE);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('lowercase alphanumeric'))).toBe(true);
    expect(result.errors.some((e) => e.includes('start with a hyphen'))).toBe(true);
  });

  it('accepts valid external frontmatter under the base profile', () => {
    const result = validateFrontmatter(validExternalFrontmatter());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects external frontmatter missing a required metadata field', () => {
    const fm = validExternalFrontmatter();
    // Drop a required metadata field.
    delete (fm.metadata as Partial<SkillFrontmatter['metadata']>).author;
    const result = validateFrontmatter(fm);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('author'))).toBe(true);
  });

  it('accepts a well-formed external body under the base profile', () => {
    const result = validateBodyStructure(VALID_BODY);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects an external body missing the required Common Mistakes section', () => {
    const body = VALID_BODY.replace('## Common Mistakes', '## Something Else');
    const result = validateBodyStructure(body);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes('Common Mistakes') || e.includes('Do NOT')),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Published overlay applies ONLY to the published collection (Req 8.2, 8.3)
// ---------------------------------------------------------------------------

describe('published overlay is collection-scoped (Req 8.2, 8.3)', () => {
  it('does NOT categorize an external skill via the published overlay (uncategorized fallback)', () => {
    const result = validateLayerAssignment(EXTERNAL_NAME, 2, 'API');
    // The published overlay has no entry for the external skill, so its layer rules
    // do not apply: the result is the non-fatal uncategorized fallback, not a layer match.
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.some((w) => /custom\/uncategorized/i.test(w))).toBe(true);
  });

  it('categorizes the same external skill when given an overlay for ITS collection', () => {
    const ok = validateLayerAssignment(EXTERNAL_NAME, 2, 'API', ACME_OVERLAY);
    expect(ok.valid).toBe(true);
    expect(ok.errors).toHaveLength(0);
    expect(ok.warnings).toHaveLength(0);

    // A wrong declared layer against the matching overlay is a fatal error.
    const wrong = validateLayerAssignment(EXTERNAL_NAME, 5, 'Diagnostics', ACME_OVERLAY);
    expect(wrong.valid).toBe(false);
    expect(wrong.errors.some((e) => e.includes('Layer mismatch'))).toBe(true);
  });

  it('applies published terminology rules with the default overlay', () => {
    const content = 'This module wires its dependencies at startup.';
    const result = checkTerminology(content);
    // Terminology issues are warnings, never fatal.
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => /ties/i.test(w))).toBe(true);
  });

  it('does not flag terminology when given a collection overlay with no terminology rules', () => {
    const content = 'This module wires its dependencies at startup.';
    const result = checkTerminology(content, ACME_OVERLAY);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Resolved-but-uncategorized → non-fatal custom/uncategorized (Req 8.4, 8.6)
// ---------------------------------------------------------------------------

describe('resolved-but-uncategorized skill is non-fatal (Req 8.4, 8.6)', () => {
  it('returns valid with a custom/uncategorized warning and no fatal Unknown skill name', () => {
    const result = validateLayerAssignment('some-external-skill', 1, 'Concepts');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.some((w) => /custom\/uncategorized/i.test(w))).toBe(true);
    // The former fatal error must no longer be produced.
    expect(result.errors.some((e) => e.includes('Unknown skill name'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Regression: published-collection CI behavior is preserved (Req 8.2)
// ---------------------------------------------------------------------------

describe('published-collection regression guard (Req 8.2)', () => {
  it('exposes the same published layer table through both the overlay and the re-export', () => {
    expect(LAYER_ASSIGNMENT).toBe(PUBLISHED_OVERLAY.layerAssignment);
    expect(PUBLISHED_NAMES.length).toBeGreaterThanOrEqual(17);
  });

  it('accepts every published skill with its declared layer and layer name', () => {
    for (const skillName of PUBLISHED_NAMES) {
      const { layer, layerName } = PUBLISHED_OVERLAY.layerAssignment[skillName];
      const result = validateLayerAssignment(skillName, layer, layerName);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      // Known published skills are categorized — no uncategorized fallback warning.
      expect(result.warnings).toHaveLength(0);
    }
  });

  it('still rejects a wrong declared layer for a known published skill (fatal)', () => {
    const { layer, layerName } = PUBLISHED_OVERLAY.layerAssignment[PUBLISHED_NAME];
    const wrongLayer = layer === 5 ? 1 : layer + 1;
    const result = validateLayerAssignment(PUBLISHED_NAME, wrongLayer, layerName);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Layer mismatch'))).toBe(true);
  });
});
