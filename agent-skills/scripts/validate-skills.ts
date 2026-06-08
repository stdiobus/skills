// =============================================================================
// CI Validation Script: Agent Skills Structural Validation
// Feature: runtime-web-agent-skills
// Purpose: Validates all agent skills conform to agentskills.io specification
//
// Validation rules are sourced from declarative profile/overlay DATA
// (`agent-skills/runtime/validation/profile.ts`, Requirement 8.7, design §7) rather
// than from compile-time constants embedded in this file. The exported validator
// functions are a generic rule ENGINE: each accepts an optional profile/overlay that
// defaults to the base profile (+ published overlay where the prior behavior applied
// published-collection rules), so default behavior is identical to the pre-migration
// code path and current CI results for the published collection are preserved.
// =============================================================================

import {
  BASE_PROFILE,
  PUBLISHED_OVERLAY,
  normalizeHeading,
} from '../runtime/validation/profile.js';
import type {
  ValidationProfile,
  ValidationOverlay,
  LayerAssignmentEntry,
} from '../runtime/validation/profile.js';

/**
 * Result of a validation check. Each validator returns this structure.
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Parsed SKILL.md frontmatter structure.
 */
export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata: {
    author: string;
    version: string;
    framework: string;
    frameworkVersionRange: string;
    layer?: string;
    layerName?: string;
  };
}

/**
 * Error catalog entry structure.
 */
export interface ErrorCatalogEntry {
  id: string;
  pattern: string;
  meaning: string;
  causes: string[];
  resolution: Array<{
    step: number;
    action: string;
    code?: string;
  }>;
  decisionRule?: string;
}

// ---------------------------------------------------------------------------
// Layer assignment mapping (sourced from the published overlay)
// ---------------------------------------------------------------------------

/**
 * Layer-assignment map for the published collection.
 *
 * The source of truth is now the `stdiobus.published` overlay
 * (`runtime/validation/profile.ts`). This thin re-export preserves the previous
 * named export consumed across the test suite and CI integration tests.
 */
export const LAYER_ASSIGNMENT: Record<string, { layer: number; layerName: string }> =
  PUBLISHED_OVERLAY.layerAssignment;

// ---------------------------------------------------------------------------
// Validation Functions
// ---------------------------------------------------------------------------

/**
 * Validates a SKILL.md `name` field against agentskills.io naming rules.
 *
 * Rules:
 * - 1-64 characters
 * - Lowercase alphanumeric + hyphens only
 * - Does not start or end with a hyphen
 * - No consecutive hyphens
 * - Must match the parent directory name (when provided)
 *
 * @param name - The name field value from SKILL.md frontmatter
 * @param directoryName - The parent directory name (optional, for match validation)
 * @param profile - The validation profile supplying the name rules (defaults to base).
 */
export function validateSkillName(
  name: string,
  directoryName?: string,
  profile: ValidationProfile = BASE_PROFILE,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const rules = profile.name;

  if (typeof name !== 'string' || name.length === 0) {
    errors.push('Name must be a non-empty string');
    return { valid: false, errors, warnings };
  }

  if (name.length > rules.maxLength) {
    errors.push(
      `Name must be ${rules.minLength}-${rules.maxLength} characters, got ${name.length}`,
    );
  }

  if (!new RegExp(rules.pattern).test(name)) {
    errors.push('Name must contain only lowercase alphanumeric characters and hyphens');
  }

  if (!rules.allowLeadingHyphen && name.startsWith('-')) {
    errors.push('Name must not start with a hyphen');
  }

  if (!rules.allowTrailingHyphen && name.endsWith('-')) {
    errors.push('Name must not end with a hyphen');
  }

  if (!rules.allowConsecutiveHyphens && /--/.test(name)) {
    errors.push('Name must not contain consecutive hyphens');
  }

  if (rules.mustMatchDirectory && directoryName !== undefined && name !== directoryName) {
    errors.push(`Name "${name}" must match parent directory name "${directoryName}"`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Checks if a string looks like a valid semver range.
 * Accepts common patterns: >=X.Y.Z <X.Y.Z, ^X.Y.Z, ~X.Y.Z, X.Y.Z, >=X.Y.Z, etc.
 */
function isValidSemverRange(range: string): boolean {
  if (typeof range !== 'string' || range.trim().length === 0) {
    return false;
  }
  // Accept common semver range patterns
  const semverPart = '\\d+\\.\\d+\\.\\d+(?:-[a-zA-Z0-9.]+)?';
  const operator = '(?:[><=!~^]{0,2})';
  const singleRange = `${operator}\\s*${semverPart}`;
  const fullPattern = new RegExp(`^\\s*${singleRange}(?:\\s+${singleRange})*\\s*$`);
  // Also accept || separated ranges
  const parts = range.split('||').map((p) => p.trim());
  return parts.every((part) => fullPattern.test(part));
}

/**
 * Validates SKILL.md YAML frontmatter completeness and correctness.
 *
 * Required fields:
 * - name (valid per naming rules)
 * - description (1-1024 non-empty chars)
 * - metadata.author
 * - metadata.version
 * - metadata.framework
 * - metadata.frameworkVersionRange (valid semver range)
 *
 * @param frontmatter - Parsed frontmatter object
 * @param profile - The validation profile supplying the frontmatter rules (defaults to base).
 */
export function validateFrontmatter(
  frontmatter: Partial<SkillFrontmatter>,
  profile: ValidationProfile = BASE_PROFILE,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { required, metadataRequired, semverRangeFields, optionalStringFields } =
    profile.frontmatter;

  // Validate name
  if (required.includes('name')) {
    if (!frontmatter.name || typeof frontmatter.name !== 'string') {
      errors.push('Missing required field: name');
    } else {
      const nameResult = validateSkillName(frontmatter.name, undefined, profile);
      errors.push(...nameResult.errors);
      warnings.push(...nameResult.warnings);
    }
  }

  // Validate description
  if (required.includes('description')) {
    if (!frontmatter.description || typeof frontmatter.description !== 'string') {
      errors.push('Missing required field: description');
    } else if (frontmatter.description.trim().length === 0) {
      errors.push('Description must not be empty');
    } else if (frontmatter.description.length > profile.description.maxLength) {
      errors.push(
        `Description must be ${profile.description.minLength}-${profile.description.maxLength} characters, got ${frontmatter.description.length}`,
      );
    }
  }

  // Validate metadata
  if (required.includes('metadata')) {
    if (!frontmatter.metadata || typeof frontmatter.metadata !== 'object') {
      errors.push('Missing required field: metadata');
    } else {
      const meta = frontmatter.metadata as unknown as Record<string, unknown>;

      for (const field of metadataRequired) {
        const value = meta[field];

        if (semverRangeFields.includes(field)) {
          if (!value || typeof value !== 'string') {
            errors.push(`Missing required metadata field: ${field}`);
          } else if (!isValidSemverRange(value)) {
            errors.push(`Invalid semver range in ${field}: "${value}"`);
          }
        } else if (!value || typeof value !== 'string' || value.trim().length === 0) {
          errors.push(`Missing required metadata field: ${field}`);
        }
      }
    }
  }

  // Validate optional fields (warn if present but invalid)
  for (const field of optionalStringFields) {
    const value = (frontmatter as unknown as Record<string, unknown>)[field];
    if (value !== undefined && typeof value !== 'string') {
      warnings.push(`Optional field "${field}" should be a string`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}


/**
 * Validates SKILL.md markdown body structure.
 *
 * Checks (all sourced from the profile's body rule set):
 * - Body is under the configured max line count
 * - Contains the required "Common Mistakes" / "Do NOT" section heading
 * - Section order follows the profile's `sectionOrder`
 *
 * @param body - The markdown body content (everything after frontmatter)
 * @param profile - The validation profile supplying the body rules (defaults to base).
 */
export function validateBodyStructure(
  body: string,
  profile: ValidationProfile = BASE_PROFILE,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const bodyRules = profile.body;

  // Check line count
  const lines = body.split('\n');
  if (lines.length > bodyRules.maxLines) {
    errors.push(`Body must be under ${bodyRules.maxLines} lines, got ${lines.length}`);
  }

  // Extract headings (## level)
  const headingPattern = /^#{1,3}\s+(.+)$/;
  const headings: Array<{ text: string; normalized: string; line: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(headingPattern);
    if (match) {
      headings.push({
        text: match[1],
        normalized: normalizeHeading(match[1], bodyRules.sectionAliases),
        line: i + 1,
      });
    }
  }

  // Check for required sections (e.g. "Common Mistakes" / "Do NOT")
  const missingRequired = bodyRules.requiredSections.some(
    (required) => !headings.some((h) => h.normalized === required),
  );
  if (missingRequired) {
    errors.push('Body must contain a "Common Mistakes" or "Do NOT" section heading');
  }

  // Validate section order against the profile's canonical order
  const knownSections = headings
    .map((h) => h.normalized)
    .filter((n) => bodyRules.sectionOrder.includes(n));

  // Check that known sections appear in the correct relative order
  const orderIndices = knownSections.map((s) => bodyRules.sectionOrder.indexOf(s));

  for (let i = 1; i < orderIndices.length; i++) {
    if (orderIndices[i] < orderIndices[i - 1]) {
      errors.push(
        `Section order violation: "${knownSections[i]}" appears after "${knownSections[i - 1]}" but should come before it`,
      );
      break;
    }
  }

  // Check that recommended sections are present
  for (const recommended of bodyRules.recommendedSections) {
    if (!knownSections.includes(recommended)) {
      const label = recommended
        .split(' ')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      warnings.push(`Body should contain an "${label}" section`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validates error-catalog.json schema conformance.
 *
 * Each entry must have:
 * - id (unique string)
 * - pattern (error message pattern)
 * - meaning (string)
 * - causes (non-empty array of strings)
 * - resolution (non-empty array of step objects with step, action, optional code)
 *
 * @param entries - Array of error catalog entries to validate
 */
export function validateErrorCatalog(entries: Partial<ErrorCatalogEntry>[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!Array.isArray(entries)) {
    errors.push('Error catalog must be an array of entries');
    return { valid: false, errors, warnings };
  }

  const seenIds = new Set<string>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const prefix = `Entry[${i}]`;

    // Validate id
    if (!entry.id || typeof entry.id !== 'string' || entry.id.trim().length === 0) {
      errors.push(`${prefix}: Missing or empty "id" field`);
    } else if (seenIds.has(entry.id)) {
      errors.push(`${prefix}: Duplicate id "${entry.id}"`);
    } else {
      seenIds.add(entry.id);
    }

    // Validate pattern
    if (!entry.pattern || typeof entry.pattern !== 'string' || entry.pattern.trim().length === 0) {
      errors.push(`${prefix}: Missing or empty "pattern" field`);
    }

    // Validate meaning
    if (!entry.meaning || typeof entry.meaning !== 'string' || entry.meaning.trim().length === 0) {
      errors.push(`${prefix}: Missing or empty "meaning" field`);
    }

    // Validate causes
    if (!Array.isArray(entry.causes) || entry.causes.length === 0) {
      errors.push(`${prefix}: "causes" must be a non-empty array`);
    } else {
      for (let j = 0; j < entry.causes.length; j++) {
        if (typeof entry.causes[j] !== 'string' || entry.causes[j].trim().length === 0) {
          errors.push(`${prefix}: causes[${j}] must be a non-empty string`);
        }
      }
    }

    // Validate resolution
    if (!Array.isArray(entry.resolution) || entry.resolution.length === 0) {
      errors.push(`${prefix}: "resolution" must be a non-empty array`);
    } else {
      for (let j = 0; j < entry.resolution.length; j++) {
        const step = entry.resolution[j];
        if (typeof step !== 'object' || step === null) {
          errors.push(`${prefix}: resolution[${j}] must be an object`);
          continue;
        }
        if (typeof step.step !== 'number') {
          errors.push(`${prefix}: resolution[${j}].step must be a number`);
        }
        if (!step.action || typeof step.action !== 'string' || step.action.trim().length === 0) {
          errors.push(`${prefix}: resolution[${j}].action must be a non-empty string`);
        }
        if (step.code !== undefined && typeof step.code !== 'string') {
          errors.push(`${prefix}: resolution[${j}].code must be a string if present`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Checks for non-canonical terminology in SKILL.md content.
 *
 * Flags (sourced from the overlay's terminology rules):
 * - "dependencies" or "DI" used as synonym for ties pattern
 * - "handler definition" instead of "LambdaDefinition"
 * - "user" or "developer" instead of "consumer"
 * - "trigger" or "event source" used interchangeably with "integration"
 *
 * @param content - The full SKILL.md content to check
 * @param overlay - The collection overlay supplying the terminology rules
 *   (defaults to the published overlay).
 */
export function checkTerminology(
  content: string,
  overlay: ValidationOverlay = PUBLISHED_OVERLAY,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof content !== 'string' || content.trim().length === 0) {
    return { valid: true, errors, warnings };
  }

  // Check each line individually for better context
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip code blocks
    if (line.trim().startsWith('```') || line.trim().startsWith('//')) {
      continue;
    }
    // Skip lines that are inside code blocks
    // (simple heuristic: skip lines that look like code)
    if (line.trim().startsWith('import ') || line.trim().startsWith('export ')) {
      continue;
    }

    for (const rule of overlay.terminology) {
      if (rule.pattern.test(line)) {
        // If exclusion regex is set and matches, the canonical term is present — skip
        if (rule.exclusion && rule.exclusion.test(line)) {
          continue;
        }
        warnings.push(`Line ${i + 1}: ${rule.context}`);
      }
    }
  }

  // Terminology issues are warnings, not errors — the content is still structurally valid
  return { valid: true, errors, warnings };
}

/**
 * Validates cross-skill references in SKILL.md content.
 *
 * Finds all `../skill-name/SKILL.md` links and verifies:
 * - Target skill exists in the skill set
 * - Layer annotation `(Layer N: LayerName)` is present and correct
 *
 * @param content - The full SKILL.md content to check
 * @param availableSkills - Set of valid skill directory names
 * @param overlay - The collection overlay supplying the layer-assignment map
 *   (defaults to the published overlay).
 */
export function validateCrossReferences(
  content: string,
  availableSkills: Set<string>,
  overlay: ValidationOverlay = PUBLISHED_OVERLAY,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof content !== 'string') {
    return { valid: true, errors, warnings };
  }

  // Find all cross-references: [text](../skill-name/SKILL.md)
  const refPattern = /\[([^\]]*)\]\(\.\.\/([\w-]+)\/SKILL\.md\)(?:\s*\(Layer\s+(\d+):\s*([^)]+)\))?/g;
  let match: RegExpExecArray | null;

  while ((match = refPattern.exec(content)) !== null) {
    const skillName = match[2];
    const layerNum = match[3];
    const layerName = match[4];

    // Check target skill exists
    if (!availableSkills.has(skillName)) {
      errors.push(`Cross-reference to non-existent skill: "${skillName}"`);
      continue;
    }

    // Check layer annotation is present
    if (!layerNum || !layerName) {
      errors.push(
        `Cross-reference to "${skillName}" is missing layer annotation "(Layer N: LayerName)"`,
      );
      continue;
    }

    // Check layer annotation is correct
    const expected = overlay.layerAssignment[skillName];
    if (expected) {
      if (parseInt(layerNum, 10) !== expected.layer) {
        errors.push(
          `Cross-reference to "${skillName}" has wrong layer number: expected ${expected.layer}, got ${layerNum}`,
        );
      }
      if (layerName.trim() !== expected.layerName) {
        errors.push(
          `Cross-reference to "${skillName}" has wrong layer name: expected "${expected.layerName}", got "${layerName.trim()}"`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validates that a skill's metadata.layer matches the defined layer assignment.
 *
 * Layer mapping:
 * - Layer 1: runtime-concepts, runtime-lifecycle
 * - Layer 2: runtime-api-core, runtime-api-integrations
 * - Layer 3: runtime-patterns-http, runtime-patterns-async,
 *            runtime-patterns-data-events, runtime-ssr-and-web
 * - Layer 4: runtime-constraints-and-guardrails
 * - Layer 5: runtime-errors-and-diagnostics, runtime-versioning-and-migration,
 *            runtime-validation-and-ci
 *
 * ─── UNKNOWN NAME IS NON-FATAL (Req 8.4, 8.5, 8.6, 8.8) ────────────────────────────
 *
 * Categorization precedence is **pinned metadata → overlay inference**: a pinned-subset
 * member uses its pinned layer/category and pinning takes precedence over any inferred
 * overlay classification (Req 8.8). When neither pinned metadata nor the overlay can
 * determine a skill's layer/category, the skill is **resolved but uncategorized**: the
 * validator assigns a custom/uncategorized fallback, emits a NON-FATAL warning, and
 * returns `valid: true` rather than the former fatal `Unknown skill name` error
 * (Req 8.4, 8.6). An *unresolved* unknown name is a `not_found` at resolution time
 * (a runtime concern), never a fatal validation error here (Req 8.5).
 *
 * KNOWN skills (categorized via pinned metadata or overlay) keep the existing fatal
 * checks for a wrong declared layer, wrong layer name, or a non-numeric (NaN) layer.
 *
 * @param skillName - The skill directory name
 * @param declaredLayer - The layer value from SKILL.md metadata
 * @param declaredLayerName - The layerName value from SKILL.md metadata
 * @param overlay - The collection overlay supplying the layer-assignment map
 *   (defaults to the published overlay).
 * @param pinned - Optional pinned layer/category lookup. When it has an entry for
 *   `skillName`, that pinned classification takes precedence over the overlay (Req 8.8).
 */
export function validateLayerAssignment(
  skillName: string,
  declaredLayer: string | number,
  declaredLayerName?: string,
  overlay: ValidationOverlay = PUBLISHED_OVERLAY,
  pinned?: ReadonlyMap<string, LayerAssignmentEntry>,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Pinning takes precedence over overlay inference (Req 8.8).
  const expected = pinned?.get(skillName) ?? overlay.layerAssignment[skillName];

  if (!expected) {
    // Resolved-but-uncategorized: non-fatal warning + custom/uncategorized fallback
    // (Req 8.4, 8.6). This is NOT a fatal error, and an unresolved unknown name is a
    // `not_found` at resolution (Req 8.5), not handled here.
    warnings.push(
      `Skill "${skillName}" has no layer/category in pinned metadata or the active overlay — assigning custom/uncategorized fallback`,
    );
    return { valid: true, errors, warnings };
  }

  const numericLayer = typeof declaredLayer === 'string' ? parseInt(declaredLayer, 10) : declaredLayer;

  if (isNaN(numericLayer)) {
    errors.push(`Invalid layer value: "${declaredLayer}" — must be a number 1-5`);
  } else if (numericLayer !== expected.layer) {
    errors.push(
      `Layer mismatch for "${skillName}": expected layer ${expected.layer}, got ${numericLayer}`,
    );
  }

  if (declaredLayerName !== undefined && declaredLayerName !== expected.layerName) {
    errors.push(
      `Layer name mismatch for "${skillName}": expected "${expected.layerName}", got "${declaredLayerName}"`,
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}
