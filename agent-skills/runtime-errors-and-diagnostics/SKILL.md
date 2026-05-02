---
name: runtime-errors-and-diagnostics
description: >
  Structured error catalog mapping error codes and message patterns to meanings,
  causes, and deterministic resolution steps for @worktif/runtime. Covers build
  errors (bundle size exceeded, missing dependencies, path alias failures, TypeScript
  compilation), deployment errors (CDK synthesis failures, CloudFormation errors,
  Lambda package too large, missing IAM permissions), runtime errors (missing DI
  service, duplicate Lambda ID, handler type mismatches, integration config errors),
  and type-system errors. Use this skill when troubleshooting consumer errors,
  diagnosing build failures, resolving deployment issues, or debugging runtime
  exceptions.
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

This skill provides a structured error catalog for `@worktif/runtime`. Each error
entry maps an error code or message pattern to its meaning, common causes, and
step-by-step resolution. The catalog enables deterministic troubleshooting — given
an error, the resolution path is fixed and unambiguous.

## When to Use

- When a consumer reports an error message or stack trace from build, deploy, or runtime
- When a build command fails and you need to identify the root cause
- When CDK synthesis or CloudFormation deployment fails
- When a Lambda function throws an error at runtime
- When TypeScript compilation produces type errors related to framework types
- When you need to provide step-by-step resolution instead of guessing at fixes

## Core Concepts

### Error Catalog Structure

Every error in the catalog follows this structure:

1. **ID** — Unique identifier (e.g., BUILD-001, DEPLOY-002, RUNTIME-003)
2. **Pattern** — The error message or regex pattern that identifies this error
3. **Meaning** — What this error means in plain language
4. **Causes** — Common causes (ordered by likelihood)
5. **Resolution** — Step-by-step fix with code examples where applicable
6. **Decision Rule** — The hard rule: "If you see this error, do X — do NOT do Y"

### Error Categories

| Category | Prefix | When It Occurs |
|----------|--------|----------------|
| Build | BUILD-xxx | During `yarn build`, `yarn cli:build:lambda`, `yarn cli:build:react` |
| Deployment | DEPLOY-xxx | During CDK synthesis or CloudFormation stack operations |
| Runtime | RUNTIME-xxx | During Lambda execution (cold start or invocation) |
| Type System | TYPE-xxx | During TypeScript compilation (`tsc`, `yarn types`) |

### Diagnostic Approach

When a consumer reports an error:

1. Match the error message against known patterns in the catalog
2. Identify the error category (build, deployment, runtime, type-system)
3. Follow the resolution steps in exact order — do NOT skip steps
4. If the error does not match any known pattern, check the consumer's framework
   version against the skill's targeted version range

## Instructions

### Resolution Order

Always resolve errors in this order: **types → build → deploy → runtime**.
Fixing later-stage errors before earlier ones wastes time because earlier fixes
often resolve downstream issues.

```bash
yarn types             # 1. Fix type errors first
yarn cli:build:lambda  # 2. Fix build errors
yarn deploy:dev        # 3. Fix deployment errors
# Test endpoint        # 4. Fix runtime errors
```

### Build Errors

**BUILD-001: Bundle Size Exceeded** (`Bundle size exceeds 10MB`)
- Cause: Large dependency not externalized, or AWS SDK v2 included
- Fix: Add to `excludeDependencies` in `src/bin/deploy/cloud.build/esbuild.config.ts`
- Verify: `yarn cli:build:lambda` then check `.serverless/*.zip` <10MB
- Rule: Do NOT suggest splitting Lambdas or ignoring — externalize dependencies

**BUILD-002: Missing Dependencies** (`Cannot find module '<package>'`)
- Cause: Package not in `package.json` or not installed
- Fix: `yarn add <package>` then `yarn install`
- Rule: Do NOT suggest alternative packages unless original is deprecated

**BUILD-003: Path Alias Failure** (`Cannot find module '@core/...'`)
- Cause: `tsconfig.json` paths incorrect or `tsc-alias` not running
- Fix: Verify paths config, run `yarn types`, then `yarn build`
- Rule: Do NOT replace path aliases with relative imports

**BUILD-004: TypeScript Compilation** (`error TS2xxx:`)
- Cause: Wrong type usage, missing imports, or version incompatibility
- Fix: Read error, check correct signature in runtime-api-core skill, fix types
- Rule: Do NOT use `@ts-ignore` or `as any` casts

### Deployment Errors

**DEPLOY-001: CDK Synthesis Failure** (`Synthesis failed`)
- Cause: `src/infra/` imports from `@core/*` or `@lib/*` (architecture violation)
- Fix: Remove violating imports, verify CDK deps installed
- Rule: Do NOT add `@core/*` or `@lib/*` to infra code

**DEPLOY-002: CloudFormation Stack Error** (`UPDATE_ROLLBACK_COMPLETE`)
- Cause: IAM insufficient, resource name conflict, or limit exceeded
- Fix: Check Events tab, read StatusReason, fix specific resource
- Rule: Do NOT retry without fixing cause, do NOT delete stack without asking

**DEPLOY-003: Lambda Package Too Large** (`RequestEntityTooLargeException`)
- Cause: Dependencies not externalized, source maps included
- Fix: Review `excludeDependencies`, use Lambda layers for native binaries
- Rule: Do NOT suggest increasing limits (they are fixed by AWS)

**DEPLOY-004: Missing IAM Permissions** (`AccessDeniedException`)
- Cause: New SDK call without corresponding IAM policy
- Fix: Add via CDK L2 grant methods (e.g., `bucket.grantRead(fn)`)
- Rule: Do NOT use wildcard `*` permissions or `AdministratorAccess`

### Runtime Errors

**RUNTIME-001: Missing Service in DI Container** (`No matching bindings found`)
- Cause: Ties class has unresolvable constructor or not registered
- Fix: Ensure class has proper constructor; for SSR, register in `runtime.container.ts`
- Rule: Do NOT catch and ignore — fix the registration

**RUNTIME-002: Duplicate Lambda ID** (`Duplicate lambda id`)
- Cause: Copy-paste error — two handlers with same `id`
- Fix: Rename one to a unique, descriptive identifier
- Rule: Do NOT remove the `id` field

**RUNTIME-003: Handler Type Mismatch** (`Handler is not a function`)
- Cause: Factory-style handler with object-based ties, or missing `async`
- Fix: Use direct handler pattern: `handler: async (event) => { ... }`
- Rule: Do NOT wrap in try-catch that returns generic response

**RUNTIME-004: Integration Config Error** (`Invalid integration config`)
- Cause: Missing required field or wrong property name
- Fix: Check exact interface in runtime-api-integrations skill, fix config
- Rule: Do NOT invent fields — use only documented ones

### Type System Errors

**TYPE-001: Incorrect Generic Parameters** (`not assignable to type 'LambdaDefinition<'`)
- Cause: TTies type does not match `ties` property keys
- Fix: Define type alias matching ties object keys exactly
- Rule: Do NOT use `any` or `unknown` to suppress

**TYPE-002: TiesConstructors Error** (`not assignable to type 'TiesConstructors<'`)
- Cause: Passing `new Service()` instead of `Service` class
- Fix: Pass class constructors, not instances
- Rule: Framework handles instantiation — do NOT instantiate manually

**TYPE-003: Missing Import** (`Cannot find module '@worktif/runtime'`)
- Cause: Wrong import path or package not installed
- Fix: Use `import { ... } from '@worktif/runtime'` or `'@worktif/runtime/infra'`
- Rule: Do NOT import from internal paths

**TYPE-004: Wrong Event Properties** (`Property does not exist on type '...Event'`)
- Cause: Accessing properties from wrong integration type
- Fix: Match event properties to the configured integration kind
- Rule: Do NOT cast event to `any`

### Hard Decision Rules Summary

For every error in the catalog, a hard decision rule applies:

1. **Never ignore errors** — fix the root cause before proceeding
2. **Never use @ts-ignore** — fix the type error at its source
3. **Never use `as any`** — provide correct types
4. **Never add try-catch to hide errors** — fix why the error occurs
5. **Never retry deployment without fixing the cause** — identify the failed resource
6. **Never use wildcard IAM** — use least-privilege via CDK grant methods
7. **Never replace path aliases with relative imports** — fix the alias configuration
8. **Never suggest increasing AWS limits** — externalize or use layers

See [Error Catalog](references/error-catalog.json) for the complete structured
catalog with full resolution steps and code examples.

## Common Mistakes

### ❌ WRONG: Ignoring build errors and deploying anyway

```bash
# ❌ Build shows errors but consumer deploys regardless
yarn cli:build:lambda  # Shows "Bundle size exceeds 10MB"
yarn deploy:dev        # ❌ Will fail at AWS — wasted time
```

### ✅ CORRECT: Fix errors before deploying

```bash
# ✅ Fix the root cause first
yarn cli:build:lambda  # Shows "Bundle size exceeds 10MB"
# Fix: externalize large dependency in esbuild.config.ts
yarn cli:build:lambda  # Verify: bundle now <10MB
yarn deploy:dev        # ✅ Deployment succeeds
```

### ❌ WRONG: Using @ts-ignore to suppress type errors

```typescript
// ❌ Hides the real problem — will cause runtime errors
// @ts-ignore
const handler: LambdaDefinition<MyTies> = {
  ties: { userService: new UsersService() },  // Still wrong at runtime
  handler: async (event) => { /* ... */ },
};
```

### ✅ CORRECT: Fixing the type error at its source

```typescript
// ✅ Fix the actual issue — pass constructor, not instance
const handler: LambdaDefinition<MyTies> = {
  ties: { userService: UsersService },  // ✅ Correct: class constructor
  handler: async (event) => { /* ... */ },
  http: { method: 'GET', path: '/users' },
};
```

### ❌ WRONG: Resolving errors in wrong order

```bash
# ❌ Trying to fix deployment errors before fixing build errors
yarn deploy:dev        # Fails — but real issue is bundle too large
```

### ✅ CORRECT: Following the resolution order

```bash
# ✅ Fix in order: types → build → deploy → runtime
yarn types             # 1. Fix type errors first
yarn cli:build:lambda  # 2. Fix build errors
yarn deploy:dev        # 3. Fix deployment errors
```

### ❌ WRONG: Adding try-catch to hide runtime errors

```typescript
// ❌ Hides the real problem — service is not registered
handler: async (event) => {
  try {
    const result = await event.ties.userService.getUser(id);
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (e) {
    return { statusCode: 200, body: '{}' };  // ❌ Silent failure
  }
}
```

### ✅ CORRECT: Fixing the root cause of runtime errors

```typescript
// ✅ Ensure the service is properly declared in ties
type MyTies = { userService: UsersService };

const handler: LambdaDefinition<MyTies> = {
  ties: { userService: UsersService },  // ✅ Properly declared
  handler: async (event) => {
    const result = await event.ties.userService.getUser(id);
    return { statusCode: 200, body: JSON.stringify(result) };
  },
  http: { method: 'GET', path: '/users/{id}' },
};
```

## References

- [Error Catalog](references/error-catalog.json) — Complete structured error catalog in JSON format
- [runtime-constraints-and-guardrails](../runtime-constraints-and-guardrails/SKILL.md) (Layer 4: Guardrails) — Constraints that prevent errors
- [runtime-api-core](../runtime-api-core/SKILL.md) (Layer 2: API) — Correct type signatures
- [runtime-api-integrations](../runtime-api-integrations/SKILL.md) (Layer 2: API) — Integration config interfaces
- [runtime-versioning-and-migration](../runtime-versioning-and-migration/SKILL.md) (Layer 5: Diagnostics) — Version-specific error differences
