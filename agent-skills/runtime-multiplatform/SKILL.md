---
name: runtime-multiplatform
description: >
  Multi-platform deployment with @worktif/runtime. Covers the
  RuntimeConfig.platforms array, the PlatformConfig shape (name, awsRegion,
  features, awake, acceleration overrides), the shallow-merge resolution
  semantics against global config, the default-platform sentinel for
  single-platform projects, per-platform resource naming via the platformName
  prop, duplicate-name validation, and the --platform CLI targeting on deploy
  and destroy. Use this skill when deploying the same application to multiple
  platforms, regions, or AWS accounts from one configuration, or when reasoning
  about how platform overrides merge with global settings.
license: Elastic-2.0
compatibility: Requires @worktif/runtime >=0.5.0 <1.0.0
metadata:
  author: worktif
  version: "1.0.0"
  framework: "@worktif/runtime"
  frameworkVersionRange: ">=0.5.0 <1.0.0"
  layer: "3"
  layerName: "Patterns"
---

## Overview

`@worktif/runtime` deploys one application to multiple **platforms** from a
single configuration. A platform is a named deployment dimension (for example
`web`, `api`, `eu`, `production`) that can override the AWS region, feature
flags, awake settings, and acceleration settings, and that isolates AWS resource
names. Multi-platform is OPTIONAL — projects that declare no platforms deploy on
a single default platform with identical behavior to before the feature existed.

## When to Use

- When deploying the same application to multiple platforms, regions, or AWS accounts
- When a platform needs different feature flags, awake, or acceleration than the global config
- When configuring the `platforms` array in `runtime.config.ts`
- When reasoning about how platform overrides merge with global settings
- When targeting a single platform from the CLI during deploy or destroy
- When reasoning about per-platform AWS resource naming

## Core Concepts

### The `platforms` Array

`RuntimeConfig.platforms` is an optional array of `PlatformConfig`. When omitted
or empty, the framework deploys a single **default platform** (internally a
sentinel `{ name: undefined }`) so the same code path runs for single- and
multi-platform deployments.

```typescript
import { RuntimeConfig } from '@worktif/runtime';

const config: RuntimeConfig = {
  projectName: 'my-app',
  stages: [{ name: 'prod', awsRegion: 'us-east-1' }],
  paths: { srcDir: 'src', reactEntry: 'src/index.tsx', outDir: 'out/dist' },
  platforms: [
    { name: 'web' },
    { name: 'api', awsRegion: 'eu-west-1' },
  ],
};

export default config;
```

### PlatformConfig Shape

```typescript
interface PlatformConfig {
  name: string;                       // ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$
  awsRegion?: string;                 // override stage region for this platform
  features?: FeaturesConfig;          // shallow-merged with global features
  awake?: RuntimeAwakeConfig;         // shallow-merged with global awake
  acceleration?: AccelerationConfig;  // shallow-merged with global acceleration
}
```

- `name` must be lowercase letters, numbers, and hyphens, and cannot start or
  end with a hyphen.
- Duplicate platform names are rejected by schema validation.

### Resolution: Shallow Merge

For each platform, the resolver merges platform overrides over global config:

```
awsRegion    = platform.awsRegion ?? stage.awsRegion
features     = { ...global.features, ...platform.features }
awake        = { ...global.awake, ...platform.awake }
acceleration = { ...global.acceleration, ...platform.acceleration }
```

The merge is **shallow** at the top level. For `acceleration`, a provided
platform `kata` object fully replaces the global `kata` object — there is no
deep merge of the fields inside `kata`. Inputs are never mutated; the resolved
value is always a new object.

### Per-Platform Resource Naming

All CDK stacks accept an optional `platformName` prop. When set, the platform
segment is included in resource names using:

```
[projectName, platformName, stackTitle, stage].filter(Boolean).join('-')
```

This isolates resources per platform so multiple platforms can coexist in the
same (or different) accounts without name collisions.

### CLI Targeting

`deploy` and `destroy` accept `--platform <name>`:

- Provided → operate on that single platform only (invalid name → error listing
  available names).
- Omitted → operate on all declared platforms (or the default platform when none
  are declared).

## Instructions

### Deploy to multiple regions/accounts

```typescript
const config: RuntimeConfig = {
  projectName: 'my-app',
  stages: [{ name: 'prod', awsRegion: 'us-east-1' }],
  paths: { srcDir: 'src', reactEntry: 'src/index.tsx', outDir: 'out/dist' },
  features: { enableSeo: true, enableManifest: true, enableWarmup: false, clearCacheOnDeploy: true },
  platforms: [
    { name: 'us' },                                  // inherits us-east-1 + global features
    { name: 'eu', awsRegion: 'eu-west-1' },          // region override only
    { name: 'canary', features: { enableWarmup: true } }, // feature override (shallow-merged)
  ],
};
```

### Target one platform from the CLI

```bash
runtime deploy --stage prod --platform eu     # deploy only the 'eu' platform
runtime destroy --stage prod --platform eu    # destroy only the 'eu' platform
runtime deploy --stage prod                   # deploy ALL platforms
```

### Override acceleration per platform

```typescript
platforms: [
  { name: 'production', acceleration: { kata: { enabled: true, unlicensedBehavior: 'fail' } } },
  { name: 'preview',    acceleration: { kata: { enabled: false } } },
]
```

## Common Mistakes

### ❌ WRONG: Expecting a deep merge of nested override fields

```typescript
// global: acceleration: { kata: { enabled: true, unlicensedBehavior: 'fail' } }
// platform override below does NOT keep unlicensedBehavior: 'fail'
{ name: 'preview', acceleration: { kata: { enabled: false } } }
// ❌ Result is { kata: { enabled: false } } — the platform kata REPLACES global kata.
```

### ✅ CORRECT: Restate every field you rely on in the override

```typescript
{ name: 'preview', acceleration: { kata: { enabled: false, unlicensedBehavior: 'warn' } } }
// ✅ Shallow merge replaces the whole kata object, so spell out the fields you need.
```

### ❌ WRONG: Duplicate or malformed platform names

```typescript
platforms: [
  { name: 'web' },
  { name: 'web' },        // ❌ duplicate names rejected by validation
  { name: 'Web-API' },    // ❌ uppercase not allowed
  { name: '-edge' },      // ❌ cannot start with a hyphen
]
```

### ✅ CORRECT: Unique, lowercase, hyphen-safe names

```typescript
platforms: [
  { name: 'web' },
  { name: 'api' },
  { name: 'edge-eu' },
]
```

### ❌ WRONG: Assuming a single platform behaves differently from "no platforms"

```typescript
// ❌ Declaring one platform is NOT required for single-target deploys.
platforms: [{ name: 'default' }]  // unnecessary; omit `platforms` entirely instead
```

### ✅ CORRECT: Omit `platforms` for single-target projects

```typescript
const config: RuntimeConfig = {
  projectName: 'my-app',
  stages: [{ name: 'prod', awsRegion: 'us-east-1' }],
  paths: { srcDir: 'src', reactEntry: 'src/index.tsx', outDir: 'out/dist' },
  // no `platforms` → single default platform, identical resource naming as before
};
```

## References

- [runtime-concepts](../runtime-concepts/SKILL.md) (Layer 1: Concepts) — Multi-stack CDK architecture and the platformName prop
- [runtime-api-core](../runtime-api-core/SKILL.md) (Layer 2: API) — `RuntimeConfig`, `PlatformConfig` type signatures
- [runtime-lifecycle](../runtime-lifecycle/SKILL.md) (Layer 1: Concepts) — Deploy commands and stages
- [runtime-acceleration](../runtime-acceleration/SKILL.md) (Layer 3: Patterns) — Per-platform acceleration overrides
