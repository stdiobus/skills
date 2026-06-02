# Acceleration Contract: Precedence, Status, and Lazy Isolation

## Configuration Shape

`acceleration` is an object (not a discriminated union) so future providers are
added as sibling keys without a breaking change. `kata` is the only v1 provider.

```typescript
interface AccelerationConfig {
  kata?: KataAccelerationConfig;
}

interface KataAccelerationConfig {
  enabled: boolean;                      // default: false
  unlicensedBehavior: 'warn' | 'fail';   // default: 'warn'
}
```

Per-lambda override lives under `LambdaConfig` and is `enabled`-only:

```typescript
interface LambdaConfig {
  memorySize?: number;
  timeout?: number;
  environment?: Record<string, string>;
  kata?: { enabled?: boolean };   // per-lambda toggle (NO unlicensedBehavior)
}
```

## Precedence (exact)

The `LambdaBuilder` resolves one decision per Lambda:

```
enabled            = perLambda.enabled ?? platformOrGlobal.kata?.enabled ?? false
unlicensedBehavior = platformOrGlobal.kata?.unlicensedBehavior ?? 'warn'
```

| Field | Sources (highest → lowest) | Fallback |
|-------|----------------------------|----------|
| `enabled` | per-lambda `config.kata.enabled` → resolved platform/global `acceleration.kata.enabled` | `false` |
| `unlicensedBehavior` | resolved platform/global `acceleration.kata.unlicensedBehavior` | `'warn'` |

`unlicensedBehavior` is NEVER read from a per-lambda field.

The platform/global value is itself produced by the platform resolver via a
**shallow merge**: a provided platform `kata` object fully replaces the global
`kata` object (no deep merge of fields inside `kata`).

## Decision → Action

| Resolved `enabled` | Action |
|--------------------|--------|
| `false` | Increment `disabled` tally; return the SAME `lambda.Function` instance; adapter NOT invoked |
| `true` | Invoke `adapter.apply(fn, { unlicensedBehavior, lambdaId })` exactly once; tally returned status |

Adapter errors propagate unmodified — there is no try/catch in the seam, so a
`'fail'` synth aborts without returning a Lambda.

## Status Semantics

| Status | Produced when |
|--------|---------------|
| `transformed` | Provider mutated the Lambda (runtime/handler/layers) |
| `skipped` | Enabled but no change: unlicensed under `'warn'`, or `@lambdakata/cdk` absent under `'warn'` |
| `disabled` | Resolved-disabled; the seam short-circuited before the adapter |
| `unknown` | Provider was invoked but its transformed-state could not be determined best-effort |

Deploy summary example (only printed when acceleration was engaged for ≥1 Lambda):

```
Acceleration: 12 transformed, 0 skipped, 0 disabled
```

## Lazy Isolation Invariant

The production `KataAccelerationAdapter` `require('@lambdakata/cdk')` **only**
inside `apply()`, **only** on the enabled path, **only** at CDK synth time. This
guarantees:

- The optional dependency stays out of the eager module graph.
- The **local** execution path (MicroserviceBundle → factory → dev runtime
  loader) NEVER touches the adapter and NEVER loads `@lambdakata/cdk`.
- Default-OFF synthesis produces byte-identical CloudFormation to the
  pre-feature template (verified by snapshot equality with `NoopAccelerationAdapter`).

## Build Externalization

`@lambdakata/cdk` and its native licensing addon are externalized in ALL build
targets (never bundled), the same rule as `aws-cdk-lib` and `constructs`:

```
@lambdakata/cdk
@lambdakata/licensing
@lambdakata/*
@lambda-kata/licensing
@lambda-kata/*
```

Rationale: esbuild resolves `require()` targets statically at build time even
when the call is lazy. Without externalization the build would attempt to embed
the ~7MB Marketplace-coupled package (and a platform-specific prebuilt binary).

## Error: AccelerationPackageNotInstalledError

Thrown when acceleration is enabled for a Lambda, `@lambdakata/cdk` is not
installed, AND `unlicensedBehavior` is `'fail'`. The original `require()` failure
is attached via `cause`. Resolution: install the package (`npm i @lambdakata/cdk`)
or set `acceleration.kata.enabled = false` (or use `'warn'` to skip gracefully).

## Scope Boundary (v1)

- **In scope**: microservice Lambdas created by `LambdaBuilder.buildLambda()`.
- **Out of scope**: SSR render handler Lambdas and RuntimeAwake Lambdas —
  different handler/layer shapes; intentionally not accelerated in v1.
