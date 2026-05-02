# CI Validation Pipeline

## Pipeline Overview

The CI validation pipeline runs automatically on each `@worktif/runtime` release
to ensure all 12 agent skills remain correct and compilable. It is implemented as
a TypeScript script at `agent-skills/scripts/validate-skills.ts`.

## Trigger Conditions

The pipeline runs when:
- A new version of `@worktif/runtime` is published (release trigger)
- A pull request modifies any file under `agent-skills/` (PR trigger)
- Manually triggered for ad-hoc validation (manual trigger)

## Pipeline Stages

### Stage 1: Discovery

Discover all skill directories and collect files for validation.

```typescript
// Pseudocode
const skillsRoot = 'agent-skills/';
const skillDirs = listDirectories(skillsRoot)
  .filter(dir => existsSync(join(dir, 'SKILL.md')));

// Expected: 12 skill directories
// Each must contain SKILL.md at the root
```

**Outputs:**
- List of 12 skill directory paths
- List of all SKILL.md files
- List of all template .ts files
- Path to error-catalog.json
- Path to skills-manifest.json

### Stage 2: Structural Validation

Validate each SKILL.md against the agentskills.io specification.

**Checks performed:**

| Check | Rule | Failure Action |
|-------|------|----------------|
| Name field | 1-64 chars, lowercase alphanumeric + hyphens, matches directory | Fatal error |
| Name format | No start/end hyphen, no consecutive hyphens | Fatal error |
| Description | 1-1024 non-empty characters | Fatal error |
| Metadata fields | author, version, framework, frameworkVersionRange present | Fatal error |
| Body line count | Under 500 lines | Warning (non-fatal) |
| Section order | Overview → When to Use → ... → Common Mistakes → References | Fatal error |
| Common Mistakes | Section heading exists | Fatal error |

**Implementation:**

```typescript
function validateStructure(skillPath: string): ValidationResult {
  const content = readFileSync(join(skillPath, 'SKILL.md'), 'utf-8');
  const { frontmatter, body } = parseFrontmatter(content);

  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate name
  const nameResult = validateSkillName(frontmatter.name, basename(skillPath));
  errors.push(...nameResult.errors);

  // Validate frontmatter
  const fmResult = validateFrontmatter(frontmatter);
  errors.push(...fmResult.errors);

  // Validate body
  const bodyResult = validateBodyStructure(body);
  errors.push(...bodyResult.errors);
  warnings.push(...bodyResult.warnings);

  return { valid: errors.length === 0, errors, warnings };
}
```

### Stage 3: Template Compilation

Compile all TypeScript templates against current framework types.

**Process:**

1. Collect all `.ts` files from `references/templates/` across all skills
2. Create a temporary `tsconfig.json` that includes the framework types
3. Run `tsc --noEmit` on each template file
4. Report compilation errors with file path and error details

**Configuration:**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "node",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "paths": {
      "@worktif/runtime": ["./src/index.tsx"],
      "@worktif/runtime/infra": ["./src/infra/index.ts"]
    }
  },
  "include": [
    "agent-skills/**/references/templates/**/*.ts"
  ]
}
```

**Expected template locations:**

| Skill | Templates |
|-------|-----------|
| runtime-patterns-http | single-get.ts, crud-microservice.ts, jwt-auth.ts, cognito-auth.ts |
| runtime-patterns-async | sqs-worker.ts, eventbridge-fanout.ts, sns-pubsub.ts, kinesis-processor.ts, scheduled-task.ts |
| runtime-patterns-data-events | s3-trigger.ts, dynamodb-stream.ts |

### Stage 4: API Existence Check

Verify all referenced type names exist in the public API.

**Types to verify:**

```typescript
const requiredExports = [
  // From @worktif/runtime
  'MicroserviceDefinition',
  'LambdaDefinition',
  'IntegrationKind',
  'HttpMethod',
  'AuthType',
  'AuthConfig',
  'AuthConfigNone',
  'AuthConfigIam',
  'AuthConfigJwt',
  'AuthConfigCognito',
  'AuthConfigCustom',
  'HttpIntegration',
  'SqsIntegration',
  'EventBridgeIntegration',
  'S3Integration',
  'DynamoDbStreamIntegration',
  'SnsIntegration',
  'KinesisIntegration',
  'ScheduleIntegration',
  'InitFunction',
  'LambdaEvent',
  'TiesConstructors',

  // From @worktif/runtime/infra
  'RuntimeInfraStack',
  'RuntimeWebStack',
  'BrowserProviderStack',
];
```

**Verification method:**

```typescript
function verifyApiExistence(): ValidationResult {
  const errors: string[] = [];

  // Check main package exports
  const mainExports = getExportsFrom('src/index.tsx');
  for (const name of requiredExports.main) {
    if (!mainExports.includes(name)) {
      errors.push(`Missing export from @worktif/runtime: ${name}`);
    }
  }

  // Check infra package exports
  const infraExports = getExportsFrom('src/infra/index.ts');
  for (const name of requiredExports.infra) {
    if (!infraExports.includes(name)) {
      errors.push(`Missing export from @worktif/runtime/infra: ${name}`);
    }
  }

  return { valid: errors.length === 0, errors, warnings: [] };
}
```

### Stage 5: Error Catalog Validation

Validate the structured error catalog against its JSON schema.

**Checks:**
- File parses as valid JSON
- Top-level structure matches schema (version, frameworkVersionRange, categories)
- Each category is one of: build, deployment, runtime, type-system
- Each error entry has: id (unique), pattern, meaning, causes (non-empty array), resolution (non-empty array)
- Each resolution step has: step (integer), action (string), optional code (string)
- Error IDs are unique across all categories

**Implementation:**

```typescript
function validateErrorCatalogFile(): ValidationResult {
  const catalog = JSON.parse(
    readFileSync('agent-skills/runtime-errors-and-diagnostics/references/error-catalog.json', 'utf-8')
  );

  return validateErrorCatalog(catalog);
}
```

### Stage 6: Cross-Reference Integrity

Verify all inter-skill links resolve correctly.

**Process:**

1. Scan all SKILL.md files for markdown links matching `../skill-name/SKILL.md`
2. For each link:
   - Verify the target directory exists
   - Verify the target SKILL.md file exists
   - Verify the layer annotation `(Layer N: LayerName)` is present
   - Verify the layer number matches the target skill's actual layer

**Implementation:**

```typescript
function validateAllCrossReferences(): ValidationResult {
  const errors: string[] = [];
  const linkPattern = /\[.*?\]\(\.\.\/([\w-]+)\/SKILL\.md\)\s*\(Layer (\d+): ([\w\s]+)\)/g;

  for (const skillDir of skillDirectories) {
    const content = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8');
    let match;

    while ((match = linkPattern.exec(content)) !== null) {
      const [, targetSkill, layerNum, layerName] = match;
      const result = validateCrossReferences(
        targetSkill,
        parseInt(layerNum),
        layerName.trim()
      );
      errors.push(...result.errors);
    }
  }

  return { valid: errors.length === 0, errors, warnings: [] };
}
```

### Stage 7: Terminology Check

Scan for non-canonical terminology across all skills.

**Non-canonical terms to flag:**

| Non-Canonical | Canonical | Context |
|---------------|-----------|---------|
| dependencies, DI | ties | When referring to the ties pattern |
| handler definition | LambdaDefinition | When referring to the type |
| user, developer | consumer | When referring to framework users |
| trigger, event source | integration | When used interchangeably |

**Implementation:**

```typescript
function checkAllTerminology(): ValidationResult {
  const warnings: string[] = [];

  for (const skillDir of skillDirectories) {
    const content = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8');
    const result = checkTerminology(content);
    warnings.push(
      ...result.warnings.map(w => `${basename(skillDir)}: ${w}`)
    );
  }

  return { valid: true, errors: [], warnings };
}
```

### Stage 8: Manifest Update

Update `skills-manifest.json` with validation results.

```typescript
function updateManifest(results: Map<string, ValidationResult>): void {
  const manifest = {
    version: '1.0.0',
    frameworkVersion: getCurrentFrameworkVersion(),
    skills: Array.from(results.entries()).map(([name, result]) => ({
      name,
      layer: getLayerForSkill(name),
      versionRange: '>=0.5.0 <1.0.0',
      status: result.valid ? 'valid' : 'failed',
      lastValidated: new Date().toISOString(),
      ...(result.errors.length > 0 && { validationErrors: result.errors }),
    })),
    lastValidated: new Date().toISOString(),
  };

  writeFileSync(
    'agent-skills/skills-manifest.json',
    JSON.stringify(manifest, null, 2)
  );
}
```

## Pipeline Execution

### Running Locally

```bash
# Full validation
npx ts-node agent-skills/scripts/validate-skills.ts

# Template compilation only
npx tsc --noEmit --project agent-skills/tsconfig.validation.json
```

### CI Integration

The pipeline integrates with the project's existing CI system:

```yaml
# Example CI configuration (conceptual)
validate-skills:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: '18'
    - run: yarn install
    - run: npx ts-node agent-skills/scripts/validate-skills.ts
    - run: |
        # Fail if any skill has status "failed"
        if grep -q '"status": "failed"' agent-skills/skills-manifest.json; then
          echo "Skill validation failed"
          exit 1
        fi
```

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All skills pass validation |
| 1 | One or more skills have fatal errors |
| 2 | Script execution error (missing files, parse errors) |

## Failure Handling

### When a Template Fails to Compile

1. Identify the specific template and error from pipeline output
2. Check if the framework API changed (new version released)
3. Update the template to match the current API
4. Re-run validation to confirm the fix
5. The manifest is automatically updated

### When a Type No Longer Exists

1. Check the framework changelog for the removed type
2. Find the replacement type (if any)
3. Update all skills that reference the removed type
4. Update templates that import the removed type
5. If no replacement exists: Remove the reference and document in migration guide

### When Cross-References Break

1. A skill was renamed or removed
2. Update all links pointing to the old skill name
3. If skill was removed: Remove references or point to the replacement skill
4. Re-run cross-reference validation

## Performance

The full validation pipeline completes in under 30 seconds for all 12 skills:
- Structural validation: ~2s (file I/O + parsing)
- Template compilation: ~15s (TypeScript compiler)
- API existence: ~3s (export analysis)
- Error catalog: ~1s (JSON parsing + schema check)
- Cross-references: ~2s (regex scanning)
- Terminology: ~2s (pattern matching)
- Manifest update: ~1s (JSON write)

## Maintenance Schedule

- **On each framework release:** Full pipeline run (automated)
- **On skill PR:** Full pipeline run (automated)
- **Monthly:** Manual review of terminology and prose accuracy
- **Quarterly:** Review whether version range needs updating
