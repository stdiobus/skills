---
name: runtime-versioning-and-migration
description: >
  Version-specific guidance and migration paths for @worktif/runtime. Documents
  the targeted framework version range (>=0.5.0 <1.0.0), breaking changes between
  versions, migration from deprecated array-based ties to object-based ties,
  compatibility requirements (Node.js, TypeScript, React, CDK), and version
  detection from package.json. Use this skill when a consumer's project version
  differs from skill targets, when upgrading the framework, when migrating
  deprecated patterns, or when verifying compatibility requirements.
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

This skill documents version-specific behavior, breaking changes, and migration
paths for `@worktif/runtime`. It enables AI agents to generate code compatible
with the consumer's installed framework version and to guide consumers through
upgrades safely.

## When to Use

- When a consumer's `package.json` shows a different framework version than what skills target
- When upgrading `@worktif/runtime` from one version to another
- When migrating from deprecated patterns (array-based ties → object-based ties)
- When verifying that a consumer's environment meets compatibility requirements
- When a type error or runtime error appeared after a framework upgrade
- When determining which patterns are appropriate for a specific version

## Core Concepts

### Targeted Version Range

All skills in this set target:

```
@worktif/runtime >=0.5.0 <1.0.0
```

This means:
- All code examples, templates, and type signatures are valid for versions 0.5.0 through 0.x.y
- The skills do NOT cover versions before 0.5.0 or versions 1.0.0 and above
- If a consumer's version is outside this range, warn them and suggest consulting updated skills

### Version Detection

To determine the consumer's framework version:

```json
// package.json
{
  "dependencies": {
    "@worktif/runtime": "^0.5.0"
  }
}
```

Or check the installed version:

```bash
yarn info @worktif/runtime version
```

### Compatibility Matrix

| Dependency | Required Version | Notes |
|-----------|-----------------|-------|
| Node.js | >=18.0.0 | Lambda runtime requirement |
| TypeScript | 5.8+ | Strict mode, experimental decorators |
| React | 19.x (dev) | Development and SSR rendering |
| React (peer) | 16.14–18.x | Consuming applications |
| React Router | 7.7+ | SSR and client-side routing |
| aws-cdk-lib | 2.x | Infrastructure deployment |
| constructs | 10.x | CDK construct library |
| AWS SDK | v3 only | Modular imports (@aws-sdk/client-*) |

### Semantic Versioning Policy

During the 0.x.y pre-release phase:
- **0.x.0** (minor bumps): May contain breaking changes — always check migration guide
- **0.x.y** (patch bumps): Bug fixes and non-breaking additions only
- **1.0.0** (future): First stable release — breaking changes only in major bumps after this

## Instructions

### Hard Decision Rule: Version-Appropriate Patterns

**RULE:** If the consumer's project uses version X (from `package.json`), use
patterns appropriate for that version. Do NOT mix patterns from different minor
versions during the pre-release phase.

Steps:
1. Read `@worktif/runtime` version from `package.json`
2. Verify it falls within `>=0.5.0 <1.0.0`
3. If it does: Use all patterns from these skills as-is
4. If it does not: Warn the consumer and suggest upgrading or finding version-appropriate documentation
5. Do NOT generate code using patterns from a different version than what is installed

### Breaking Changes: 0.4.x → 0.5.0

The 0.5.0 release introduced the following breaking changes:

#### 1. Object-Based Ties (Replaces Array-Based)

**Before (0.4.x — DEPRECATED):**

```typescript
// ❌ Array-based ties — deprecated in 0.5.0
const handler: LambdaDefinition = {
  ties: [UsersService, OrdersService],
  handler: (ties) => async (event) => {
    const userService = ties.userService as UsersService;  // Manual casting
    const orderService = ties.orderService as OrdersService;
    return { statusCode: 200, body: '{}' };
  },
  http: { method: 'GET', path: '/users' },
};
```

**After (0.5.0+ — RECOMMENDED):**

```typescript
// ✅ Object-based ties — full type safety
type MyTies = {
  userService: UsersService;
  orderService: OrdersService;
};

const handler: LambdaDefinition<MyTies> = {
  ties: {
    userService: UsersService,
    orderService: OrdersService,
  },
  handler: async (event) => {
    const users = await event.ties.userService.listUsers();  // Fully typed
    const orders = await event.ties.orderService.getOrders();
    return { statusCode: 200, body: JSON.stringify({ users, orders }) };
  },
  http: { method: 'GET', path: '/users' },
};
```

**Migration steps:**
1. Define a type alias for your ties (e.g., `type MyTies = { ... }`)
2. Change `ties` from array to object with named keys
3. Add the generic parameter to `LambdaDefinition<MyTies>`
4. Change handler from factory pattern `(ties) => async (event) => {}` to direct `async (event) => {}`
5. Access ties via `event.ties.serviceName` instead of manual casting
6. Remove all `as ServiceType` casts — they are no longer needed

#### 2. Handler Signature Change

**Before (0.4.x):**

```typescript
// ❌ Factory-style handler — deprecated
handler: (ties) => async (event) => {
  return { statusCode: 200, body: '{}' };
}
```

**After (0.5.0+):**

```typescript
// ✅ Direct handler — ties available on event
handler: async (event, context) => {
  // event.ties is automatically populated
  return { statusCode: 200, body: '{}' };
}
```

#### 3. LambdaDefinition Generic Parameters

**Before (0.4.x):**

```typescript
// No generic parameters — untyped
const handler: LambdaDefinition = { /* ... */ };
```

**After (0.5.0+):**

```typescript
// Generic parameters for full type safety
const handler: LambdaDefinition<MyTies, MySnapshot, 'http'> = { /* ... */ };
```

#### 4. InitFunction Signature

**Before (0.4.x):**

```typescript
// ❌ Init received raw container
init: async (container) => {
  return { db: container.get('database') };
}
```

**After (0.5.0+):**

```typescript
// ✅ Init receives typed ties instances
init: async (ties) => {
  return { cachedData: await ties.dataService.loadCache() };
}
```

### Breaking Changes: 0.5.0-beta.1 → 0.5.0-beta.2

Minor adjustments within the beta phase:

#### 1. IntegrationKind Type Narrowing

The `direct` integration kind was added in 0.5.0-beta.2. Projects on beta.1 have
only 8 integration kinds. Projects on beta.2+ have all 9.

#### 2. AuthConfig Union Expansion

`AuthConfigCustom` (with `authorizerLambda` field) was added in 0.5.0-beta.2.

### Migration Guide: Array-Based to Object-Based Ties

This is the most common migration consumers need to perform. Follow these steps
for each Lambda definition in the project:

**Step 1: Identify all array-based ties usage**

Search for the pattern:
```typescript
ties: [ClassName, ClassName, ...]
```

**Step 2: Create a type alias for each handler's ties**

```typescript
// Before: no type alias
// After:
type GetUsersTies = {
  userService: UsersService;
  authService: AuthService;
};
```

**Step 3: Convert ties array to object**

```typescript
// Before:
ties: [UsersService, AuthService]

// After:
ties: {
  userService: UsersService,
  authService: AuthService,
}
```

**Step 4: Update handler signature**

```typescript
// Before (factory pattern):
handler: (ties) => async (event) => {
  const userService = ties.userService as UsersService;
  // ...
}

// After (direct pattern):
handler: async (event) => {
  const users = await event.ties.userService.listUsers();
  // ...
}
```

**Step 5: Add generic parameter**

```typescript
// Before:
const handler: LambdaDefinition = { /* ... */ };

// After:
const handler: LambdaDefinition<GetUsersTies> = { /* ... */ };
```

**Step 6: Remove manual type casts**

```typescript
// Before:
const userService = ties.userService as UsersService;  // Remove this

// After:
event.ties.userService  // Already typed as UsersService
```

**Step 7: Verify compilation**

```bash
yarn types   # Should pass with no errors
yarn build   # Full build verification
```

### Environment Compatibility Checks

When starting work on a consumer's project, verify these requirements:

```bash
# Node.js version (must be >=18)
node --version

# TypeScript version (must be 5.8+)
npx tsc --version

# Framework version
yarn info @worktif/runtime version

# React version
yarn info react version
```

If any requirement is not met:

| Issue | Resolution |
|-------|-----------|
| Node.js <18 | Upgrade Node.js to 18+ (required for Lambda runtime) |
| TypeScript <5.8 | `yarn add -D typescript@^5.8` |
| React <16.14 | Upgrade React (minimum peer dependency) |
| aws-cdk-lib <2.0 | `yarn add -D aws-cdk-lib@^2` |

### Version Mismatch Handling

If the consumer's framework version does not match the skill's targeted range:

1. **Version too old (<0.5.0):** Recommend upgrading. The array-based ties pattern
   is deprecated and these skills do not cover it as the primary pattern.

2. **Version too new (>=1.0.0):** These skills may be outdated. Check for updated
   skill versions. Core concepts likely still apply but specific APIs may differ.

3. **Version within range but different patch:** Skills are valid. Patch versions
   contain only bug fixes and non-breaking additions.

## Common Mistakes

### ❌ WRONG: Mixing patterns from different versions

```typescript
// ❌ Mixing array-based ties (0.4.x) with direct handler (0.5.0+)
const handler: LambdaDefinition = {
  ties: [UsersService],  // ❌ Array-based (old pattern)
  handler: async (event) => {  // ❌ Direct handler expects object-based ties
    event.ties.userService;  // ❌ Will be undefined — ties is array
  },
  http: { method: 'GET', path: '/users' },
};
```

### ✅ CORRECT: Using consistent patterns for the installed version

```typescript
// ✅ All patterns from 0.5.0+ — consistent and type-safe
type MyTies = { userService: UsersService };

const handler: LambdaDefinition<MyTies> = {
  ties: { userService: UsersService },  // ✅ Object-based
  handler: async (event) => {  // ✅ Direct handler
    const users = await event.ties.userService.listUsers();  // ✅ Typed
    return { statusCode: 200, body: JSON.stringify(users) };
  },
  http: { method: 'GET', path: '/users' },
};
```

### ❌ WRONG: Upgrading framework without migrating patterns

```bash
# ❌ Upgrading version but keeping old code patterns
yarn add @worktif/runtime@^0.5.0
# Old array-based ties code still in place — will cause type errors
```

### ✅ CORRECT: Migrating patterns when upgrading

```bash
# ✅ Upgrade and migrate in sequence
yarn add @worktif/runtime@^0.5.0
# Then: migrate all ties from array to object pattern
# Then: migrate all handlers from factory to direct pattern
# Then: add generic parameters to all LambdaDefinition usages
yarn types  # Verify no type errors
yarn build  # Verify full build passes
```

### ❌ WRONG: Using @ts-ignore to suppress version-related type errors

```typescript
// ❌ Hiding version incompatibility with @ts-ignore
// @ts-ignore — "works on my machine"
const handler: LambdaDefinition = {
  ties: [UsersService],  // Type error suppressed — will fail at runtime
};
```

### ✅ CORRECT: Fixing the root cause by migrating to current patterns

```typescript
// ✅ Migrate to the pattern supported by the installed version
type MyTies = { userService: UsersService };

const handler: LambdaDefinition<MyTies> = {
  ties: { userService: UsersService },
  handler: async (event) => {
    return { statusCode: 200, body: '{}' };
  },
  http: { method: 'GET', path: '/users' },
};
```

## References

- [Migration Guides](references/migration-guides.md) — Step-by-step migration paths with code diffs
- [runtime-api-core](../runtime-api-core/SKILL.md) (Layer 2: API) — Current type signatures (0.5.0+)
- [runtime-concepts](../runtime-concepts/SKILL.md) (Layer 1: Concepts) — Core domain model
- [runtime-errors-and-diagnostics](../runtime-errors-and-diagnostics/SKILL.md) (Layer 5: Diagnostics) — Error resolution after upgrades
- [runtime-validation-and-ci](../runtime-validation-and-ci/SKILL.md) (Layer 5: Diagnostics) — How skills are validated against framework versions
