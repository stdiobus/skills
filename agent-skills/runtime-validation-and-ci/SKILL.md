---
name: runtime-validation-and-ci
description: >
  Documents the CI validation pipeline that ensures all agent skill code examples
  compile against the current @worktif/runtime types. Covers the skills-manifest.json
  structure and purpose, the validation pipeline (structural checks, template
  compilation, API existence, error code verification, cross-reference integrity),
  what "validated" means for consumers, and the process for updating skills when
  the framework API changes. Use this skill when maintaining skills, understanding
  validation status, updating skills after API changes, or verifying skill
  correctness.
license: Elastic-2.0
compatibility: Requires @worktif/runtime >=0.5.0 <1.0.0
metadata:
  author: worktif
  version: "1.0.0"
  framework: "@worktif/runtime"
  frameworkVersionRange: ">=0.5.0 <1.0.0"
  layer: "5"
  layerName: "Diagnostics"
---

## Overview

This skill documents how the 12 agent skills are validated as first-class release
artifacts. Every code example in every skill is validated against the current
`@worktif/runtime` TypeScript types during CI, ensuring consumers never receive
outdated or incorrect information.

## When to Use

- When checking whether a skill's examples are still valid for the current framework version
- When updating skills after a framework API change
- When understanding what "validated" means for skill examples
- When investigating why a skill example does not compile for a consumer
- When maintaining the skills-manifest.json validation state
- When adding new skills or templates to the skill set

## Core Concepts

### What "Validated" Means

When a skill is marked as `"status": "valid"` in the manifest, it means:

1. All TypeScript templates in `references/templates/` compile with `tsc --noEmit`
2. All referenced type names exist in the `@worktif/runtime` public API exports
3. All import paths resolve correctly
4. The SKILL.md frontmatter is structurally valid
5. The SKILL.md body follows the required section order
6. All cross-references to other skills resolve to existing files
7. Terminology is consistent with canonical terms

This guarantee means: **if a consumer copies a template from a validated skill and
uses the targeted framework version, the code will compile without type errors.**

### Validation Scope

| What Is Validated | How |
|-------------------|-----|
| Template compilation | `tsc --noEmit` against current types |
| Type existence | Check public API exports for referenced types |
| Import paths | Verify `@worktif/runtime` and `@worktif/runtime/infra` resolve |
| Frontmatter structure | YAML parsing + required field validation |
| Body structure | Section order, line count, required sections |
| Cross-references | All `../skill-name/SKILL.md` links resolve |
| Terminology | Canonical terms used consistently |
| Error catalog | JSON schema validation |

### What Is NOT Validated

- Prose accuracy (requires human review)
- Completeness of explanations
- Whether examples cover all edge cases
- Runtime behavior of templates (only compilation is checked)
- Performance characteristics of example code

## Instructions

### skills-manifest.json Structure

The manifest tracks validation state for all 12 skills:

```json
{
  "version": "1.0.0",
  "frameworkVersion": "0.5.0-beta.2",
  "skills": [
    {
      "name": "runtime-concepts",
      "layer": 1,
      "versionRange": ">=0.5.0 <1.0.0",
      "status": "valid",
      "lastValidated": "2026-01-15T10:00:00Z"
    },
    {
      "name": "runtime-lifecycle",
      "layer": 1,
      "versionRange": ">=0.5.0 <1.0.0",
      "status": "valid",
      "lastValidated": "2026-01-15T10:00:00Z"
    }
  ],
  "lastValidated": "2026-01-15T10:00:00Z"
}
```

**Fields:**
- `version` — Manifest schema version
- `frameworkVersion` — Current `@worktif/runtime` version at last validation
- `skills[]` — Array of skill validation records
- `skills[].name` — Skill directory name (matches SKILL.md `name` field)
- `skills[].layer` — Layer number (1–5)
- `skills[].versionRange` — Targeted framework version range
- `skills[].status` — `"valid"` | `"outdated"` | `"failed"`
- `skills[].lastValidated` — ISO 8601 timestamp of last successful validation
- `skills[].validationErrors` — Array of error messages (only when status is `"failed"`)
- `lastValidated` — ISO 8601 timestamp of last full validation run

### CI Validation Pipeline

The validation pipeline runs on each framework release:

**Stage 1: Structural Validation**
- Each skill directory contains a `SKILL.md` file
- `name` field matches directory name (1-64 chars, lowercase alphanumeric + hyphens)
- Frontmatter contains all required fields
- Body is under 500 lines
- Body contains required sections in correct order
- "Common Mistakes" or "Do NOT" section exists

**Stage 2: Template Compilation**
- Collect all `.ts` files from `references/templates/` across all skills
- Compile each with `tsc --noEmit` against current `@worktif/runtime` types
- Report any compilation errors with file path and error message

**Stage 3: API Existence Check**
- Extract all type names referenced in skills (MicroserviceDefinition, LambdaDefinition, etc.)
- Verify each exists in the public API exports of `@worktif/runtime`
- Verify import paths (`@worktif/runtime`, `@worktif/runtime/infra`) resolve

**Stage 4: Error Catalog Validation**
- Parse `error-catalog.json` against the defined JSON schema
- Verify each entry has required fields (id, pattern, meaning, causes, resolution)
- Verify error IDs are unique across all categories

**Stage 5: Cross-Reference Integrity**
- Find all `../skill-name/SKILL.md` links across all skills
- Verify each target skill directory and SKILL.md file exists
- Verify layer annotations `(Layer N: LayerName)` are correct

**Stage 6: Terminology Check**
- Scan all SKILL.md files for non-canonical terminology
- Flag: "dependencies" or "DI" used as synonym for ties pattern
- Flag: "handler definition" instead of "LambdaDefinition"
- Flag: "user" or "developer" instead of "consumer"
- Flag: "trigger" or "event source" used interchangeably with "integration"

**Stage 7: Manifest Update**
- Update `skills-manifest.json` with validation results
- Set `status` to `"valid"` or `"failed"` for each skill
- Update `lastValidated` timestamps
- Record any `validationErrors`

### Skill Update Process When API Changes

When the framework API changes (new types, renamed fields, removed exports):

**Step 1: Identify affected skills**
- Run the CI validation pipeline
- Skills with compilation failures are marked `"status": "failed"`
- Review `validationErrors` to identify which templates broke

**Step 2: Update affected templates**
- Open each failed template file
- Update type names, field names, or import paths to match the new API
- Ensure the template still demonstrates the intended pattern

**Step 3: Update SKILL.md content**
- If type signatures changed: Update the documented signatures
- If new options added: Add them to the enumerated option sets
- If options removed: Remove them and add to "NOT SUPPORTED" if applicable

**Step 4: Re-validate**
- Run the full validation pipeline
- All skills must pass before merging

**Step 5: Update manifest**
- `skills-manifest.json` is automatically updated by the pipeline
- Verify all skills show `"status": "valid"`
- Update `frameworkVersion` to the new version

**Step 6: Update version range (if needed)**
- If the change is a new minor version within the supported range: No change needed
- If the change requires a new major version: Update `frameworkVersionRange` in all skills

### Consumer Troubleshooting

If a consumer reports that a skill example does not compile:

1. Check the consumer's framework version: `yarn info @worktif/runtime version`
2. Compare against the skill's `frameworkVersionRange` in frontmatter
3. If version is within range: The skill may need updating — check `skills-manifest.json`
4. If version is outside range: Direct consumer to [runtime-versioning-and-migration](../runtime-versioning-and-migration/SKILL.md) (Layer 5: Diagnostics)
5. If skill status is `"failed"`: The skill is known to be outdated — use with caution

### Adding New Skills

When adding a new skill to the set:

1. Create the skill directory under `agent-skills/`
2. Write `SKILL.md` following the standard structure (frontmatter + 6 sections)
3. Add any templates to `references/templates/`
4. Add the skill entry to `skills-manifest.json`
5. Run the validation pipeline to verify
6. Ensure all cross-references from other skills are updated

### Validation Script Location

The validation script is located at:

```
agent-skills/scripts/validate-skills.ts
```

It exports these validation functions:
- `validateSkillName()` — Validates SKILL.md name field
- `validateFrontmatter()` — Validates YAML frontmatter completeness
- `validateBodyStructure()` — Validates markdown body structure
- `validateErrorCatalog()` — Validates error-catalog.json schema
- `checkTerminology()` — Checks for non-canonical terminology
- `validateCrossReferences()` — Validates cross-skill links
- `validateLayerAssignment()` — Verifies layer metadata correctness

## Common Mistakes

### ❌ WRONG: Assuming skill examples are always current

```typescript
// ❌ Copying a template without checking the skill's validation status
// The skill might be marked "failed" in the manifest
import { SomeType } from '@worktif/runtime';  // May not exist in current version
```

### ✅ CORRECT: Checking validation status before using examples

```bash
# ✅ Check skills-manifest.json first
cat agent-skills/skills-manifest.json | jq '.skills[] | select(.name == "runtime-patterns-http")'
# Verify: "status": "valid" and lastValidated is recent
```

### ❌ WRONG: Updating templates without running validation

```typescript
// ❌ Editing a template and committing without verifying it compiles
// references/templates/single-get.ts — edited but not validated
export const handler: LambdaDefinition<MyTies> = {
  ties: { userService: UsersService },
  handler: async (event) => { /* ... */ },
  http: { method: 'GET', path: '/users' },
  newField: 'value',  // ❌ May not exist — not validated
};
```

### ✅ CORRECT: Running validation after any template change

```bash
# ✅ Always validate after editing templates
yarn ts-node agent-skills/scripts/validate-skills.ts
# Or run the specific template compilation check:
npx tsc --noEmit agent-skills/runtime-patterns-http/references/templates/single-get.ts
```

### ❌ WRONG: Ignoring "failed" status in the manifest

```json
// ❌ Leaving a skill in "failed" state and using it anyway
{
  "name": "runtime-patterns-http",
  "status": "failed",
  "validationErrors": ["Template single-get.ts: Cannot find name 'HttpMethod'"]
}
// Consumer copies the template — gets compilation errors
```

### ✅ CORRECT: Fixing failed skills before release

```bash
# ✅ Fix the template, re-validate, update manifest
# 1. Fix the template code
# 2. Run validation
yarn ts-node agent-skills/scripts/validate-skills.ts
# 3. Verify all skills pass
# 4. Commit updated manifest with "status": "valid"
```

### ❌ WRONG: Manually editing skills-manifest.json status

```json
// ❌ Setting status to "valid" without actually running validation
{
  "name": "runtime-patterns-http",
  "status": "valid",  // ❌ Manually set — not verified by pipeline
  "lastValidated": "2026-01-15T10:00:00Z"
}
```

### ✅ CORRECT: Letting the CI pipeline update the manifest

```bash
# ✅ The validation pipeline updates the manifest automatically
yarn ts-node agent-skills/scripts/validate-skills.ts
# Manifest is updated with actual validation results
```

## References

- [CI Pipeline](references/ci-pipeline.md) — Detailed CI validation pipeline steps and configuration
- [runtime-versioning-and-migration](../runtime-versioning-and-migration/SKILL.md) (Layer 5: Diagnostics) — Version-specific guidance when skills target a different version
- [runtime-errors-and-diagnostics](../runtime-errors-and-diagnostics/SKILL.md) (Layer 5: Diagnostics) — Error resolution for validation failures
- [runtime-api-core](../runtime-api-core/SKILL.md) (Layer 2: API) — Type signatures that templates are validated against
