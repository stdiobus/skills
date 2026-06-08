/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Declarative, data-driven validation rules (Requirement 8; design §7).
 *
 * The structural validators in `agent-skills/scripts/validate-skills.ts` historically
 * hard-coded their rules as module-level constants (`LAYER_ASSIGNMENT`, `SECTION_ORDER`,
 * `TERMINOLOGY_RULES`, plus the name/frontmatter literals). This module relocates those
 * rules **verbatim** into declarative data so the validator functions become a generic
 * rule *engine* that reads from a {@link ValidationProfile} (applied to every skill) and
 * an optional {@link ValidationOverlay} (applied only to the collection it targets):
 *
 * - {@link BASE_PROFILE} — the `agentskills.io` profile: name rules, frontmatter
 *   requirements, and the body section-order rule. Applies to ALL skills regardless of
 *   provider (Req 8.1, 8.7).
 * - {@link PUBLISHED_OVERLAY} — the `stdiobus.published` overlay: the layer-assignment map
 *   and terminology rules. Applies ONLY to the published collection (Req 8.2, 8.3).
 *
 * Section order is intentionally expressed as ONE migrated rule inside the base profile
 * ({@link BodyRuleSet}) rather than a fixed core shape, so it can evolve as data like any
 * other rule (Req 8.7, design §7).
 *
 * ─── BEHAVIOR PRESERVATION ─────────────────────────────────────────────────────────
 *
 * The relocated data reproduces the previous constants exactly. The validator defaults
 * resolve to `BASE_PROFILE` (structural rules) and `PUBLISHED_OVERLAY` (layer/terminology),
 * so the default behavior of every exported validator is identical to the pre-migration
 * code path and current CI results for the published collection are preserved. The
 * fatal-unknown → warning/fallback shift (Req 8.4–8.6) is a SEPARATE change owned by a
 * later task; this module performs the structural relocation only.
 */

// ---------------------------------------------------------------------------
// Profile rule-set shapes (base profile — applies to every skill)
// ---------------------------------------------------------------------------

/**
 * Naming rules for a skill `name`, relocated from `validateSkillName`.
 *
 * The numeric bounds, character pattern, and hyphen/directory toggles are data; the
 * detection logic (regex test, hyphen position checks) lives in the validator engine.
 */
export interface NameRuleSet {
  /** Minimum length (inclusive). */
  minLength: number;
  /** Maximum length (inclusive). */
  maxLength: number;
  /** Allowed-character pattern source, e.g. `^[a-z0-9-]+$`. */
  pattern: string;
  /** Whether a leading hyphen is permitted. */
  allowLeadingHyphen: boolean;
  /** Whether a trailing hyphen is permitted. */
  allowTrailingHyphen: boolean;
  /** Whether consecutive hyphens (`--`) are permitted. */
  allowConsecutiveHyphens: boolean;
  /** Whether the name must equal the parent directory name when one is provided. */
  mustMatchDirectory: boolean;
}

/** Length bounds for the `description` frontmatter field. */
export interface DescriptionRuleSet {
  /** Minimum non-empty length (inclusive). */
  minLength: number;
  /** Maximum length (inclusive). */
  maxLength: number;
}

/**
 * Frontmatter completeness rules, relocated from `validateFrontmatter`.
 */
export interface FrontmatterRuleSet {
  /** Required top-level frontmatter fields (e.g. `name`, `description`, `metadata`). */
  required: string[];
  /** Required `metadata.*` fields. */
  metadataRequired: string[];
  /** `metadata.*` fields validated as a semver range rather than a non-empty string. */
  semverRangeFields: string[];
  /** Optional top-level fields that, when present, must be strings (warning otherwise). */
  optionalStringFields: string[];
}

/**
 * A heading-normalization alias: any heading whose lowercased, trimmed text starts with
 * one of `prefixes` normalizes to `canonical`. Relocated from `normalizeHeading`.
 */
export interface SectionAlias {
  /** Canonical section key (e.g. `instructions`). */
  canonical: string;
  /** Lowercased heading prefixes that map to {@link canonical}. */
  prefixes: string[];
}

/**
 * Body-structure rules, relocated from `SECTION_ORDER` + `validateBodyStructure`.
 */
export interface BodyRuleSet {
  /** Maximum body line count (exclusive upper bound message: "under N lines"). */
  maxLines: number;
  /** Canonical section keys in required relative order. */
  sectionOrder: string[];
  /** Heading-normalization aliases applied before order checking. */
  sectionAliases: SectionAlias[];
  /** Canonical sections that MUST be present (fatal error if missing). */
  requiredSections: string[];
  /** Canonical sections that SHOULD be present (warning if missing). */
  recommendedSections: string[];
}

/**
 * The base structural profile. Applied to every skill regardless of provider (Req 8.1).
 */
export interface ValidationProfile {
  /** Profile id, e.g. `agentskills.io`. */
  id: string;
  /** Name rules. */
  name: NameRuleSet;
  /** Description length rules. */
  description: DescriptionRuleSet;
  /** Frontmatter completeness rules. */
  frontmatter: FrontmatterRuleSet;
  /** Body-structure rules (section order is one migrated rule, not a fixed core shape). */
  body: BodyRuleSet;
}

// ---------------------------------------------------------------------------
// Overlay rule-set shapes (collection overlay — applies only to its collection)
// ---------------------------------------------------------------------------

/** Layer/category assignment for a single skill. */
export interface LayerAssignmentEntry {
  layer: number;
  layerName: string;
}

/**
 * A non-canonical terminology rule, relocated verbatim from `TERMINOLOGY_RULES`.
 *
 * `pattern` flags a line; if `exclusion` is non-null and also matches the line, the
 * canonical term is already present and the line is skipped.
 */
export interface TerminologyRule {
  pattern: RegExp;
  exclusion: RegExp | null;
  canonical: string;
  context: string;
}

/**
 * An optional domain overlay applied only to a specific collection (Req 8.2, 8.3).
 */
export interface ValidationOverlay {
  /** Overlay id, e.g. `stdiobus.published`. */
  id: string;
  /** The collection this overlay applies to; never applied to skills outside it. */
  appliesToCollection: string;
  /** Layer-assignment map (the published-collection layer/category table). */
  layerAssignment: Record<string, LayerAssignmentEntry>;
  /** Terminology rules for the collection. */
  terminology: TerminologyRule[];
}

// ---------------------------------------------------------------------------
// Base profile — `agentskills.io` (relocated verbatim from validate-skills.ts)
// ---------------------------------------------------------------------------

/**
 * The base `agentskills.io` profile.
 *
 * Relocated verbatim from the previous module-level constants and literals:
 * - name rules: 1–64 chars, `^[a-z0-9-]+$`, no leading/trailing hyphen, no consecutive
 *   hyphens, must match the directory name when provided.
 * - frontmatter: `name`, `description` (1–1024 non-empty), `metadata.author`,
 *   `metadata.version`, `metadata.framework`, `metadata.frameworkVersionRange`
 *   (valid semver range); optional `license`, `compatibility`.
 * - body section order: overview → when to use → core concepts → instructions →
 *   common mistakes → references; plus heading normalization, body < 500 lines, and the
 *   required "Common Mistakes" / "Do NOT" section.
 */
export const BASE_PROFILE: ValidationProfile = {
  id: 'agentskills.io',
  name: {
    minLength: 1,
    maxLength: 64,
    pattern: '^[a-z0-9-]+$',
    allowLeadingHyphen: false,
    allowTrailingHyphen: false,
    allowConsecutiveHyphens: false,
    mustMatchDirectory: true,
  },
  description: {
    minLength: 1,
    maxLength: 1024,
  },
  frontmatter: {
    required: ['name', 'description', 'metadata'],
    metadataRequired: ['author', 'version', 'framework', 'frameworkVersionRange'],
    semverRangeFields: ['frameworkVersionRange'],
    optionalStringFields: ['license', 'compatibility'],
  },
  body: {
    maxLines: 500,
    sectionOrder: [
      'overview',
      'when to use',
      'core concepts',
      'instructions',
      'common mistakes',
      'references',
    ],
    sectionAliases: [
      { canonical: 'overview', prefixes: ['overview'] },
      { canonical: 'when to use', prefixes: ['when to use'] },
      { canonical: 'core concepts', prefixes: ['core concepts'] },
      {
        canonical: 'instructions',
        prefixes: ['instructions', 'templates', 'canonical templates'],
      },
      { canonical: 'common mistakes', prefixes: ['common mistakes', 'do not'] },
      { canonical: 'references', prefixes: ['references'] },
    ],
    requiredSections: ['common mistakes'],
    recommendedSections: ['overview'],
  },
};

// ---------------------------------------------------------------------------
// Published overlay — `stdiobus.published` (relocated verbatim)
// ---------------------------------------------------------------------------

/**
 * The `stdiobus.published` overlay.
 *
 * Relocated verbatim from `LAYER_ASSIGNMENT` (the 17-skill layer/category table) and
 * `TERMINOLOGY_RULES` (the 5 terminology rules). Applied ONLY to the published
 * collection; external skills never receive this overlay (Req 8.2, 8.3).
 */
export const PUBLISHED_OVERLAY: ValidationOverlay = {
  id: 'stdiobus.published',
  appliesToCollection: 'stdiobus.published',
  layerAssignment: {
    'runtime-concepts': { layer: 1, layerName: 'Concepts' },
    'runtime-lifecycle': { layer: 1, layerName: 'Concepts' },
    'runtime-api-core': { layer: 2, layerName: 'API' },
    'runtime-api-integrations': { layer: 2, layerName: 'API' },
    'runtime-patterns-http': { layer: 3, layerName: 'Patterns' },
    'runtime-patterns-async': { layer: 3, layerName: 'Patterns' },
    'runtime-patterns-data-events': { layer: 3, layerName: 'Patterns' },
    'runtime-ssr-and-web': { layer: 3, layerName: 'Patterns' },
    'runtime-multiplatform': { layer: 3, layerName: 'Patterns' },
    'runtime-acceleration': { layer: 3, layerName: 'Patterns' },
    'runtime-constraints-and-guardrails': { layer: 4, layerName: 'Guardrails' },
    'runtime-errors-and-diagnostics': { layer: 5, layerName: 'Diagnostics' },
    'runtime-versioning-and-migration': { layer: 5, layerName: 'Diagnostics' },
    'runtime-validation-and-ci': { layer: 5, layerName: 'Diagnostics' },
    'stdiobus-sdk-cpp': { layer: 1, layerName: 'Concepts' },
    'stdiobus-sdk-node': { layer: 1, layerName: 'Concepts' },
    'stdiobus-sdk-rust': { layer: 1, layerName: 'Concepts' },
  },
  terminology: [
    {
      pattern: /\b(?:dependencies|dependency injection)\b/i,
      exclusion: /\bties\b/i,
      canonical: 'ties',
      context:
        'Use "ties" instead of "dependencies" or "dependency injection" when referring to the ties pattern',
    },
    {
      pattern: /\bDI\b/,
      exclusion: /\bties\b/i,
      canonical: 'ties',
      context: 'Use "ties" instead of "DI" when referring to the ties pattern',
    },
    {
      pattern: /\bhandler definition\b/i,
      exclusion: null,
      canonical: 'LambdaDefinition',
      context: 'Use "LambdaDefinition" instead of "handler definition"',
    },
    {
      pattern: /\b(?:the user|the developer|a user|a developer)\b/i,
      exclusion: /\bconsumer\b/i,
      canonical: 'consumer',
      context:
        'Use "consumer" instead of "user" or "developer" when referring to framework users',
    },
    {
      pattern: /\b(?:trigger|event source)\b/i,
      exclusion: /\bintegration\b/i,
      canonical: 'integration',
      context: 'Use "integration" instead of "trigger" or "event source"',
    },
  ],
};

/**
 * Normalizes a heading against a profile's section aliases (relocated from the previous
 * module-private `normalizeHeading`). Returns the canonical section key, or the
 * lowercased/trimmed heading when no alias matches.
 *
 * @param heading - raw heading text (without the leading `#` markers).
 * @param aliases - the profile's {@link SectionAlias} list, in priority order.
 */
export function normalizeHeading(heading: string, aliases: SectionAlias[]): string {
  const lower = heading.toLowerCase().trim();
  for (const alias of aliases) {
    if (alias.prefixes.some((prefix) => lower.startsWith(prefix))) {
      return alias.canonical;
    }
  }
  return lower;
}
