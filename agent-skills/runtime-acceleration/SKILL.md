---
name: runtime-acceleration
description: >
  Product/plugin acceleration for @worktif/runtime — the provider-agnostic
  "acceleration" seam at the LambdaBuilder chokepoint and its first provider,
  Lambda Kata (@lambdakata/cdk). Covers the acceleration.kata configuration
  block (global, per-platform, and per-lambda), the enabled/unlicensedBehavior
  precedence rules, lazy optional-peer-dependency isolation, the synth-time
  transform model, the transformed/skipped/disabled/unknown status tally, and
  the strict scope (microservice Lambdas only). Use this skill when enabling or
  configuring acceleration, integrating a product plugin, or reasoning about why
  acceleration is off by default and how it stays out of the eager module graph.
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

`@worktif/runtime` integrates external **products** as Lambda **acceleration
providers** through a single provider-agnostic seam. The seam lives at the one
place every microservice Lambda is created — `LambdaBuilder.buildLambda()` — and
applies a provider transform to the constructed `lambda.Function` during CDK
synthesis. The first (and only v1) provider is **Lambda Kata**, delivered by the
optional peer dependency `@lambdakata/cdk`.

Acceleration is **OFF by default**. A consumer who never opts in gets identical
framework behavior and never loads the optional dependency. The configuration is
shaped as `acceleration: { kata: { ... } }` — an object whose `kata` key is the
v1 provider — so future providers are added as sibling keys without a breaking
change.

## When to Use

- When a consumer wants to accelerate microservice Lambdas (e.g. eliminate cold starts)
- When configuring the `acceleration.kata` block at global, per-platform, or per-lambda scope
- When reasoning about acceleration precedence (`enabled` and `unlicensedBehavior`)
- When deciding whether `@lambdakata/cdk` must be installed and how it is bundled
- When interpreting the deploy-time acceleration status tally
- When verifying that acceleration does not affect local execution or SSR/awake Lambdas
- When integrating a new product plugin behind the acceleration seam

## Core Concepts

### The Acceleration Seam (provider-agnostic)

Every microservice Lambda is created at a single chokepoint:
`LambdaBuilder.buildLambda()` → `new lambda.Function(...)`. Immediately after
construction, the builder calls a private `applyAcceleration()` seam that
delegates to an `AccelerationAdapter`:

```typescript
// Conceptual shape of the provider-agnostic boundary (CDK-only, src/infra/)
interface AccelerationAdapter {
  apply(fn: LambdaFunction, options: {
    unlicensedBehavior: 'warn' | 'fail';
    lambdaId: string;
  }): { fn: LambdaFunction; status: AccelerationStatus };
}

type AccelerationStatus = 'transformed' | 'skipped' | 'disabled' | 'unknown';
```

- The adapter is **synchronous** (CDK synth is synchronous).
- When the resolved decision is **disabled**, the adapter is NOT invoked and the
  exact same `lambda.Function` instance is returned unchanged.
- The interface never references any provider package, so a future product can
  implement it without touching `LambdaBuilder` (Dependency Inversion).

The production default is `KataAccelerationAdapter`. Tests inject a
`NoopAccelerationAdapter` for deterministic, offline synthesis.

### Lambda Kata — the v1 Provider

`KataAccelerationAdapter` delegates to Lambda Kata's `kata()` transform, lazily
loaded from `@lambdakata/cdk`:

```typescript
// Lazy isolation: require() happens ONLY inside apply(), only on the enabled path.
const mod = require('@lambdakata/cdk');
const result = mod.kata(fn, { unlicensedBehavior });
```

`kata()` mutates the Lambda construct in place at synth (runtime/handler/layers)
and returns it. It is synth-time side-effectful (account resolution, licensing
check) — not a pure transform.

### Configuration Contract

The `acceleration` block is optional at three scopes:

```typescript
// 1. Global (runtime.config.ts)
acceleration: {
  kata: {
    enabled: true,            // default: false
    unlicensedBehavior: 'warn' // default: 'warn' ('warn' | 'fail')
  },
}

// 2. Per-platform override (shallow-merged with global)
platforms: [
  { name: 'production', acceleration: { kata: { enabled: true, unlicensedBehavior: 'fail' } } },
  { name: 'preview',    acceleration: { kata: { enabled: false } } },
]

// 3. Per-lambda override (infrastructure knob, lives under config)
const handler: LambdaDefinition<MyTies> = {
  ties: { /* ... */ },
  handler: async (event) => { /* ... */ },
  http: { method: 'POST', path: '/charge' },
  config: { kata: { enabled: true } },  // force on/off for this one Lambda
};
```

### Precedence (exact resolution)

The builder resolves one decision per Lambda:

```
enabled            = perLambda.enabled ?? platformOrGlobal.enabled ?? false
unlicensedBehavior = platformOrGlobal.unlicensedBehavior ?? 'warn'
```

- `enabled`: per-lambda wins, then resolved platform/global, then **off**.
- `unlicensedBehavior`: resolved ONLY at platform/global scope. It is never a
  per-lambda field and never derived from one.

### `unlicensedBehavior`: warn vs fail

When the AWS account is not entitled OR `@lambdakata/cdk` is absent:

| Value | Behavior |
|-------|----------|
| `'warn'` (default) | Leave the Lambda unchanged, count it as `skipped`, continue synth |
| `'fail'` | Abort synth (throws `AccelerationPackageNotInstalledError` when the package is missing) |

### Status Tally

Each Lambda contributes one status; the deploy summary reports the totals:

| Status | Meaning |
|--------|---------|
| `transformed` | Provider mutated the Lambda |
| `skipped` | Enabled but no change (unlicensed under `warn`, or package absent under `warn`) |
| `disabled` | Resolved-disabled; adapter never invoked |
| `unknown` | Provider invoked but transformed-state could not be determined |

## Instructions

### Enable acceleration globally

1. Install the optional peer dependency: `npm i @lambdakata/cdk`.
2. Add the block to `runtime.config.ts`:

```typescript
import { RuntimeConfig } from '@worktif/runtime';

const config: RuntimeConfig = {
  projectName: 'my-app',
  stages: [{ name: 'prod', awsRegion: 'us-east-1' }],
  paths: { srcDir: 'src', reactEntry: 'src/index.tsx', outDir: 'out/dist' },
  acceleration: { kata: { enabled: true, unlicensedBehavior: 'warn' } },
};

export default config;
```

3. Deploy. The summary prints e.g. `Acceleration: 12 transformed, 0 skipped, 0 disabled`.

### Scope rules (hard)

- Acceleration applies **only to microservice Lambdas** built by `LambdaBuilder`.
- SSR handler Lambdas and RuntimeAwake Lambdas are **out of scope** by design
  (different handler/layer shapes, lower cold-start sensitivity).
- Default OFF is byte-identical to pre-feature CloudFormation. Never claim a
  behavior change for consumers who do not opt in.

### Dependency handling (do not bundle)

- `@lambdakata/cdk` and its native licensing addon (`@lambdakata/*`,
  `@lambda-kata/*`) are externalized in ALL build targets — never bundled into
  the framework output, the same rule as `aws-cdk-lib` and `constructs`.
- The package is resolved at synth from the consumer's `node_modules`. It is an
  OPTIONAL peer dependency (`peerDependenciesMeta`), so absence is valid when
  acceleration is off.

### Integrating a future product (provider #2)

Implement `AccelerationAdapter`, add a sibling key under `acceleration` (e.g.
`acceleration: { kata: {...}, myProvider: {...} }`), and lazy-load its package
inside `apply()`. Do NOT add a new top-level config key and do NOT touch
`LambdaBuilder` call sites — the seam already iterates providers.

## Common Mistakes

### ❌ WRONG: Assuming acceleration is on by default

```typescript
// ❌ Without an explicit acceleration block, NOTHING is accelerated.
const config: RuntimeConfig = {
  projectName: 'my-app',
  stages: [{ name: 'prod', awsRegion: 'us-east-1' }],
  paths: { srcDir: 'src', reactEntry: 'src/index.tsx', outDir: 'out/dist' },
  // no `acceleration` → default OFF, @lambdakata/cdk never loaded
};
```

### ✅ CORRECT: Opt in explicitly

```typescript
const config: RuntimeConfig = {
  projectName: 'my-app',
  stages: [{ name: 'prod', awsRegion: 'us-east-1' }],
  paths: { srcDir: 'src', reactEntry: 'src/index.tsx', outDir: 'out/dist' },
  acceleration: { kata: { enabled: true } },  // ✅ explicit
};
```

### ❌ WRONG: Putting `unlicensedBehavior` on a per-lambda override

```typescript
// ❌ unlicensedBehavior is NOT a per-lambda field; it is ignored here.
const handler: LambdaDefinition<MyTies> = {
  ties: { /* ... */ },
  handler: async (event) => { /* ... */ },
  http: { method: 'GET', path: '/x' },
  config: { kata: { enabled: true, unlicensedBehavior: 'fail' } },  // ❌ invalid shape
};
```

### ✅ CORRECT: Per-lambda toggles `enabled` only; behavior resolves at platform/global

```typescript
const handler: LambdaDefinition<MyTies> = {
  ties: { /* ... */ },
  handler: async (event) => { /* ... */ },
  http: { method: 'GET', path: '/x' },
  config: { kata: { enabled: true } },  // ✅ only `enabled`
};
// unlicensedBehavior comes from acceleration.kata at global/platform scope
```

### ❌ WRONG: Enabling acceleration without installing the optional package under `fail`

```typescript
// ❌ acceleration.kata.enabled: true + unlicensedBehavior: 'fail'
// without @lambdakata/cdk installed → AccelerationPackageNotInstalledError aborts synth.
acceleration: { kata: { enabled: true, unlicensedBehavior: 'fail' } }
```

### ✅ CORRECT: Install the package, or use `warn` to skip gracefully

```typescript
// ✅ Either: npm i @lambdakata/cdk
// ✅ Or: use 'warn' so missing/unlicensed Lambdas are skipped, not fatal.
acceleration: { kata: { enabled: true, unlicensedBehavior: 'warn' } }
```

### ❌ WRONG: Expecting SSR or awake Lambdas to be accelerated

```typescript
// ❌ Acceleration only covers microservice Lambdas (the LambdaBuilder chokepoint).
// SSR render handler and RuntimeAwake Lambdas are intentionally out of scope.
```

### ✅ CORRECT: Accelerate microservice endpoints; treat SSR/awake as unaffected

```typescript
// ✅ Microservice Lambdas (http/sqs/eventbridge/... definitions) are accelerated.
// SSR (BrowserProviderStack) and RuntimeAwake Lambdas keep their normal shape.
```

## References

- [Acceleration Contract](references/acceleration-contract.md) — Precedence table, status semantics, and the lazy-isolation invariant
- [runtime-concepts](../runtime-concepts/SKILL.md) (Layer 1: Concepts) — Acceleration seam in the domain model and framework scope
- [runtime-api-core](../runtime-api-core/SKILL.md) (Layer 2: API) — `RuntimeConfig`, `AccelerationConfig`, `LambdaConfig.kata` type signatures
- [runtime-constraints-and-guardrails](../runtime-constraints-and-guardrails/SKILL.md) (Layer 4: Guardrails) — Default-OFF guarantee, scope limits, dependency externalization
- [runtime-errors-and-diagnostics](../runtime-errors-and-diagnostics/SKILL.md) (Layer 5: Diagnostics) — `AccelerationPackageNotInstalledError` resolution
