// =============================================================================
// CI Validation Script: Agent Skills Structural Validation
// Feature: runtime-web-agent-skills
// Purpose: Validates all 12 agent skills conform to agentskills.io specification
// =============================================================================

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
// Layer assignment mapping (canonical source of truth)
// ---------------------------------------------------------------------------

export const LAYER_ASSIGNMENT: Record<string, { layer: number; layerName: string }> = {
  'runtime-concepts': { layer: 1, layerName: 'Concepts' },
  'runtime-lifecycle': { layer: 1, layerName: 'Concepts' },
  'runtime-api-core': { layer: 2, layerName: 'API' },
  'runtime-api-integrations': { layer: 2, layerName: 'API' },
  'runtime-patterns-http': { layer: 3, layerName: 'Patterns' },
  'runtime-patterns-async': { layer: 3, layerName: 'Patterns' },
  'runtime-patterns-data-events': { layer: 3, layerName: 'Patterns' },
  'runtime-ssr-and-web': { layer: 3, layerName: 'Patterns' },
  'runtime-constraints-and-guardrails': { layer: 4, layerName: 'Guardrails' },
  'runtime-errors-and-diagnostics': { layer: 5, layerName: 'Diagnostics' },
  'runtime-versioning-and-migration': { layer: 5, layerName: 'Diagnostics' },
  'runtime-validation-and-ci': { layer: 5, layerName: 'Diagnostics' },
};

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
 */
export function validateSkillName(name: string, directoryName?: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof name !== 'string' || name.length === 0) {
    errors.push('Name must be a non-empty string');
    return { valid: false, errors, warnings };
  }

  if (name.length > 64) {
    errors.push(`Name must be 1-64 characters, got ${name.length}`);
  }

  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push('Name must contain only lowercase alphanumeric characters and hyphens');
  }

  if (name.startsWith('-')) {
    errors.push('Name must not start with a hyphen');
  }

  if (name.endsWith('-')) {
    errors.push('Name must not end with a hyphen');
  }

  if (/--/.test(name)) {
    errors.push('Name must not contain consecutive hyphens');
  }

  if (directoryName !== undefined && name !== directoryName) {
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
 */
export function validateFrontmatter(frontmatter: Partial<SkillFrontmatter>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate name
  if (!frontmatter.name || typeof frontmatter.name !== 'string') {
    errors.push('Missing required field: name');
  } else {
    const nameResult = validateSkillName(frontmatter.name);
    errors.push(...nameResult.errors);
    warnings.push(...nameResult.warnings);
  }

  // Validate description
  if (!frontmatter.description || typeof frontmatter.description !== 'string') {
    errors.push('Missing required field: description');
  } else if (frontmatter.description.trim().length === 0) {
    errors.push('Description must not be empty');
  } else if (frontmatter.description.length > 1024) {
    errors.push(`Description must be 1-1024 characters, got ${frontmatter.description.length}`);
  }

  // Validate metadata
  if (!frontmatter.metadata || typeof frontmatter.metadata !== 'object') {
    errors.push('Missing required field: metadata');
  } else {
    const meta = frontmatter.metadata;

    if (!meta.author || typeof meta.author !== 'string' || meta.author.trim().length === 0) {
      errors.push('Missing required metadata field: author');
    }

    if (!meta.version || typeof meta.version !== 'string' || meta.version.trim().length === 0) {
      errors.push('Missing required metadata field: version');
    }

    if (!meta.framework || typeof meta.framework !== 'string' || meta.framework.trim().length === 0) {
      errors.push('Missing required metadata field: framework');
    }

    if (!meta.frameworkVersionRange || typeof meta.frameworkVersionRange !== 'string') {
      errors.push('Missing required metadata field: frameworkVersionRange');
    } else if (!isValidSemverRange(meta.frameworkVersionRange)) {
      errors.push(`Invalid semver range in frameworkVersionRange: "${meta.frameworkVersionRange}"`);
    }
  }

  // Validate optional fields (warn if present but invalid)
  if (frontmatter.license !== undefined && typeof frontmatter.license !== 'string') {
    warnings.push('Optional field "license" should be a string');
  }

  if (frontmatter.compatibility !== undefined && typeof frontmatter.compatibility !== 'string') {
    warnings.push('Optional field "compatibility" should be a string');
  }

  return { valid: errors.length === 0, errors, warnings };
}


/**
 * Known section headings and their canonical forms for body structure validation.
 */
const SECTION_ORDER = [
  'overview',
  'when to use',
  'core concepts',
  'instructions',
  'common mistakes',
  'references',
] as const;

/**
 * Normalizes a heading to match against known sections.
 * Handles variations like "Instructions / Templates", "Do NOT", etc.
 */
function normalizeHeading(heading: string): string {
  const lower = heading.toLowerCase().trim();
  if (lower.startsWith('overview')) return 'overview';
  if (lower.startsWith('when to use')) return 'when to use';
  if (lower.startsWith('core concepts')) return 'core concepts';
  if (
    lower.startsWith('instructions') ||
    lower.startsWith('templates') ||
    lower.startsWith('canonical templates')
  ) {
    return 'instructions';
  }
  if (lower.startsWith('common mistakes') || lower.startsWith('do not')) {
    return 'common mistakes';
  }
  if (lower.startsWith('references')) return 'references';
  return lower;
}

/**
 * Validates SKILL.md markdown body structure.
 *
 * Checks:
 * - Body is under 500 lines
 * - Contains "Common Mistakes" or "Do NOT" section heading
 * - Section order: Overview → When to Use → (optional Core Concepts) →
 *   Instructions/Templates → Common Mistakes → References
 *
 * @param body - The markdown body content (everything after frontmatter)
 */
export function validateBodyStructure(body: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check line count
  const lines = body.split('\n');
  if (lines.length > 500) {
    errors.push(`Body must be under 500 lines, got ${lines.length}`);
  }

  // Extract headings (## level)
  const headingPattern = /^#{1,3}\s+(.+)$/;
  const headings: Array<{ text: string; normalized: string; line: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(headingPattern);
    if (match) {
      headings.push({
        text: match[1],
        normalized: normalizeHeading(match[1]),
        line: i + 1,
      });
    }
  }

  // Check for "Common Mistakes" or "Do NOT" section
  const hasCommonMistakes = headings.some(
    (h) => h.normalized === 'common mistakes',
  );
  if (!hasCommonMistakes) {
    errors.push('Body must contain a "Common Mistakes" or "Do NOT" section heading');
  }

  // Validate section order
  // Required order: overview → when to use → (optional core concepts) → instructions → common mistakes → references
  const knownSections = headings
    .map((h) => h.normalized)
    .filter((n) => SECTION_ORDER.includes(n as typeof SECTION_ORDER[number]));

  // Check that known sections appear in the correct relative order
  const orderIndices = knownSections.map((s) =>
    SECTION_ORDER.indexOf(s as typeof SECTION_ORDER[number]),
  );

  for (let i = 1; i < orderIndices.length; i++) {
    if (orderIndices[i] < orderIndices[i - 1]) {
      errors.push(
        `Section order violation: "${knownSections[i]}" appears after "${knownSections[i - 1]}" but should come before it`,
      );
      break;
    }
  }

  // Check that at minimum "overview" is present
  if (!knownSections.includes('overview')) {
    warnings.push('Body should contain an "Overview" section');
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
 * Non-canonical terminology patterns to flag.
 * Each entry: { pattern: RegExp, exclusion: RegExp | null, canonical: string, context: string }
 *
 * The exclusion regex, if present, means "do NOT flag if this also matches the line"
 * (i.e., the canonical term is already present on the same line).
 */
const TERMINOLOGY_RULES: Array<{
  pattern: RegExp;
  exclusion: RegExp | null;
  canonical: string;
  context: string;
}> = [
    {
      pattern: /\b(?:dependencies|dependency injection)\b/i,
      exclusion: /\bties\b/i,
      canonical: 'ties',
      context: 'Use "ties" instead of "dependencies" or "dependency injection" when referring to the ties pattern',
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
      context: 'Use "consumer" instead of "user" or "developer" when referring to framework users',
    },
    {
      pattern: /\b(?:trigger|event source)\b/i,
      exclusion: /\bintegration\b/i,
      canonical: 'integration',
      context: 'Use "integration" instead of "trigger" or "event source"',
    },
  ];

/**
 * Checks for non-canonical terminology in SKILL.md content.
 *
 * Flags:
 * - "dependencies" or "DI" used as synonym for ties pattern
 * - "handler definition" instead of "LambdaDefinition"
 * - "user" or "developer" instead of "consumer"
 * - "trigger" or "event source" used interchangeably with "integration"
 *
 * @param content - The full SKILL.md content to check
 */
export function checkTerminology(content: string): ValidationResult {
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

    for (const rule of TERMINOLOGY_RULES) {
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
 */
export function validateCrossReferences(
  content: string,
  availableSkills: Set<string>,
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
    const expected = LAYER_ASSIGNMENT[skillName];
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
 * @param skillName - The skill directory name
 * @param declaredLayer - The layer value from SKILL.md metadata
 * @param declaredLayerName - The layerName value from SKILL.md metadata
 */
export function validateLayerAssignment(
  skillName: string,
  declaredLayer: string | number,
  declaredLayerName?: string,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const expected = LAYER_ASSIGNMENT[skillName];

  if (!expected) {
    errors.push(`Unknown skill name: "${skillName}" — not in the 12-skill set`);
    return { valid: false, errors, warnings };
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
