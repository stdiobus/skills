---
name: runtime-constraints-and-guardrails
description: >
  Centralized reference of all hard constraints, anti-patterns, NOT SUPPORTED
  declarations, and hard decision rules for @worktif/runtime. Covers Lambda bundle
  size limits, browser bundle limits, AWS SDK v3 requirement, CDK L2/L3 construct
  requirement, dependency externalization rules, architecture boundary rules, and
  the complete NOT SUPPORTED list. Use this skill when validating generated code,
  checking for anti-patterns, enforcing framework rules, or determining whether a
  requested feature is supported.
license: Elastic-2.0
compatibility: Requires @worktif/runtime >=0.5.0 <1.0.0
metadata:
  author: worktif
  version: "1.0.0"
  framework: "@worktif/runtime"
  frameworkVersionRange: ">=0.5.0 <1.0.0"
  layer: "4"
  layerName: "Guardrails"
---

## Overview

This skill documents every hard constraint, anti-pattern, and decision rule that
governs correct usage of `@worktif/runtime`. It serves as the single source of
truth for what is allowed, what is forbidden, and what to do when a consumer
requests something outside the framework's scope.

## When to Use

- When validating generated code against framework rules before presenting it
- When a consumer asks for a feature and you need to verify it is supported
- When checking whether a dependency should be bundled or externalized
- When enforcing architecture boundaries between infra, runtime, and isomorphic code
- When determining the correct response to an unsupported feature request
- When reviewing code for anti-patterns (ties instantiation, SDK v2, relative imports)

## Core Concepts

### Global Hard Constraints

These constraints are enforced by AWS, the build system, or the framework. Violating
them causes deployment failures, runtime errors, or build breakage.

| Constraint | Limit | Enforcement |
|-----------|-------|-------------|
| Lambda bundle size | <10MB compressed | AWS rejects deployment if exceeded |
| Browser bundle size | <500KB gzipped | Performance target; build warns if exceeded |
| AWS SDK version | v3 modular imports ONLY | v2 `aws-sdk` creates 50MB+ bundles |
| CDK construct level | L2/L3 constructs ONLY | L1 CloudFormation is unsupported |
| Lambda cold start | <2s target | Performance budget |
| SSR render time | <500ms target | Performance budget |
| API Gateway timeout | 29s | AWS hard limit |

### NOT SUPPORTED List

The following features, technologies, and patterns are NOT supported by
`@worktif/runtime`. Do NOT generate code that uses them. Do NOT fabricate
framework features to accommodate them.

**Cloud Providers:**
- Non-AWS clouds (Azure, GCP, Alibaba, etc.) — NOT SUPPORTED

**Compute Models:**
- ECS / Fargate / EC2 — NOT SUPPORTED
- AWS App Runner — NOT SUPPORTED
- Any non-Lambda compute — NOT SUPPORTED

**Communication Protocols:**
- WebSockets (native) — NOT SUPPORTED
- GraphQL (native) — NOT SUPPORTED
- gRPC — NOT SUPPORTED

**Frontend Frameworks:**
- Non-React frontends (Vue, Angular, Svelte, etc.) — NOT SUPPORTED

**AWS SDK:**
- AWS SDK v2 (`aws-sdk` package) — NOT SUPPORTED, deprecated

**Integration Types:**
- Any IntegrationKind not in the 9 documented types — NOT SUPPORTED
- WebSocket, Kafka, IoT, AppSync, Cognito triggers — NOT SUPPORTED as integration kinds

**Other:**
- AWS CDK L1 constructs (raw CloudFormation) — NOT SUPPORTED
- Non-TypeScript languages for Lambda handlers — NOT SUPPORTED

## Instructions

### Hard Decision Rules

These rules define the ONLY correct response in specific situations. Do NOT
improvise alternatives.

**RULE 1 — Unsupported Feature Request:**
If a consumer asks for a feature not in the supported list, the ONLY correct response is:
1. State that the requested feature is not supported by `@worktif/runtime`
2. Explain why (not in scope, different compute model, etc.)
3. Suggest the closest supported alternative
4. Do NOT fabricate framework features or invent unsupported APIs

**RULE 2 — Lambda Definition:**
If a consumer wants to define a Lambda function, ALWAYS use `LambdaDefinition<TTies>`.
There is NO supported alternative. Do NOT create custom handler wrappers, do NOT
use raw AWS Lambda handler signatures, do NOT bypass the framework.

**RULE 3 — Object-Based Ties:**
If a consumer asks about ties (dependency injection), ALWAYS recommend the
object-based pattern over the deprecated array-based pattern:
- Object-based: `ties: { serviceName: ServiceClass }` — ✅ RECOMMENDED
- Array-based: `ties: [ServiceClass]` — ❌ DEPRECATED, less type-safe

**RULE 4 — AWS SDK Version:**
If code uses `import AWS from 'aws-sdk'` or any v2 import, the ONLY correct
response is to replace it with the equivalent AWS SDK v3 modular import.
Do NOT suggest keeping v2 "for compatibility" or "temporarily".

**RULE 5 — Integration Type Limit:**
If a consumer asks for an integration type not in the 9 supported types,
the ONLY correct response is to state it is not supported and list the 9
supported types: `http`, `sqs`, `eventbridge`, `s3`, `dynamodb`, `sns`,
`kinesis`, `schedule`, `direct`.

**RULE 6 — CDK Construct Level:**
If code uses L1 CloudFormation constructs (`CfnBucket`, `CfnFunction`, etc.),
the ONLY correct response is to replace them with L2/L3 constructs
(`Bucket`, `Function`, etc.).

See [Decision Rules Reference](references/decision-rules.md) for the complete
structured list.

### Dependency Externalization Rules

When adding dependencies to Lambda handlers, follow these externalization rules
to keep bundles under 10MB:

**ALWAYS externalize (never bundle):**
- All AWS SDK v3 clients (`@aws-sdk/client-*`, `@aws-sdk/lib-*`)
- Node.js built-in modules (`fs`, `path`, `crypto`, `http`, `https`, etc.)
- Packages larger than 1MB (`npm info <package> dist.unpackedSize`)
- `aws-lambda` type package
- `@middy/*` middleware packages

**ALWAYS externalize in CDK builds:**
- `aws-cdk-lib`
- `constructs`

**Safe to bundle (small utilities):**
- Packages under 100KB
- Pure utility libraries with no native dependencies

**Verification workflow:**
1. Check package size: `npm info <package> dist.unpackedSize`
2. If >1MB or AWS SDK: Add to `excludeDependencies` in build config
3. Build Lambda: `yarn cli:build:lambda`
4. Verify bundle: `.serverless/*.zip` MUST be <10MB
5. If exceeded: Externalize more dependencies or use Lambda layers

### Architecture Boundary Rules

These boundaries prevent runtime errors and build failures. Code in one layer
MUST NOT import from incompatible layers.

**Rule: Infrastructure code MUST NOT import runtime code**
- `src/infra/` MUST NOT import from `@core/*` or `@lib/*`
- CDK stacks define infrastructure: RuntimeInfraStack (base resources), BrowserProviderStack (SSR deployment), RuntimeWebStack (microservices)
- Shared types go in `@utils/*`

**Rule: Isomorphic code MUST NOT use environment-specific APIs**
- `src/lib/` MUST NOT use Node.js-only APIs (`fs`, `path`, `child_process`)
- `src/lib/` MUST NOT use browser-only APIs (`window`, `document`, `localStorage`)
- For browser-only code: wrap in `useEffect()` or `typeof window !== 'undefined'` guard
- For Node.js-only code: place in `src/core/` instead

**Rule: Handler code MUST NOT import CDK constructs**
- `src/core/` MUST NOT import from `@infra/*`
- Lambda handlers execute at runtime; CDK constructs exist only at deploy time
- If a handler needs a resource ARN, pass it via environment variables

**Rule: Isomorphic code MUST NOT import Lambda-only code**
- `src/lib/` MUST NOT import from `@core/*`
- Shared logic goes in `@utils/*`

**Import boundary summary:**

| Source | Can Import | MUST NOT Import |
|--------|-----------|-----------------|
| `src/infra/` | `@utils/*` | `@core/*`, `@lib/*` |
| `src/core/` | `@utils/*`, `@lib/*` | `@infra/*`, Browser APIs |
| `src/lib/` | `@utils/*` | `@core/*`, `@infra/*`, Node/Browser APIs |
| `src/utils/` | (self only) | Everything else |

### Path Alias Requirement

Cross-directory imports MUST use path aliases. Relative imports (`../../`) break
when files move and violate architecture boundaries.

**Path alias mappings:**
- `@core/*` → `src/core/*`
- `@lib/*` → `src/lib/*`
- `@utils/*` → `src/utils/*`
- `@infra/*` → `src/infra/*`
- `@bin/*` → `src/bin/*`

**Exception:** Relative imports within the same directory (`./helper.ts`) are acceptable.

## Common Mistakes

### ❌ WRONG: Instantiating ties directly

```typescript
const handler: LambdaDefinition<MyTies> = {
  ties: {
    userService: new UsersService(),  // ❌ Framework instantiates, not you
  },
  handler: async (event) => { /* ... */ },
  http: { method: 'GET', path: '/users' },
};
```

### ✅ CORRECT: Passing class constructors to ties

```typescript
const handler: LambdaDefinition<MyTies> = {
  ties: {
    userService: UsersService,  // ✅ Class constructor — framework handles instantiation
  },
  handler: async (event) => { /* ... */ },
  http: { method: 'GET', path: '/users' },
};
```

### ❌ WRONG: Using deprecated array-based ties

```typescript
// ❌ Legacy pattern — less type-safe, requires manual casting
const handler: LambdaDefinition = {
  ties: [UsersService, OrdersService],
  handler: (ties) => async (event) => {
    const userService = ties.userService as UsersService;  // Manual casting
    return { statusCode: 200, body: '{}' };
  },
  http: { method: 'GET', path: '/users' },
};
```

### ✅ CORRECT: Using object-based ties

```typescript
type MyTies = { userService: UsersService; ordersService: OrdersService };

// ✅ Object-based ties — full type safety, no casting
const handler: LambdaDefinition<MyTies> = {
  ties: { userService: UsersService, ordersService: OrdersService },
  handler: async (event) => {
    const users = await event.ties.userService.listUsers();  // Fully typed
    return { statusCode: 200, body: JSON.stringify(users) };
  },
  http: { method: 'GET', path: '/users' },
};
```

### ❌ WRONG: Accessing ties not declared in the ties property

```typescript
type MyTies = { userService: UsersService };

const handler: LambdaDefinition<MyTies> = {
  ties: { userService: UsersService },
  handler: async (event) => {
    // ❌ configService was never declared — runtime error
    const config = event.ties.configService.get('key');
    return { statusCode: 200, body: '{}' };
  },
  http: { method: 'GET', path: '/config' },
};
```

### ✅ CORRECT: Declaring all required services in ties

```typescript
type MyTies = { userService: UsersService; configService: ConfigService };

const handler: LambdaDefinition<MyTies> = {
  ties: { userService: UsersService, configService: ConfigService },
  handler: async (event) => {
    const config = event.ties.configService.get('key');  // ✅ Declared and typed
    return { statusCode: 200, body: JSON.stringify({ config }) };
  },
  http: { method: 'GET', path: '/config' },
};
```

### ❌ WRONG: Using relative imports across directories

```typescript
// ❌ Breaks when files move, violates architecture boundaries
import { UsersService } from '../../core/services/users';
import { RuntimeWebStack } from '../../../infra/runtime-web';
```

### ✅ CORRECT: Using path aliases for cross-directory imports

```typescript
// ✅ Stable, enforces architecture boundaries
import { UsersService } from '@core/services/users';
import { RuntimeWebStack } from '@infra/runtime-web';
```

### ❌ WRONG: Importing @core/* in isomorphic code (src/lib/)

```typescript
// In src/lib/shared-utils.ts
import { S3StaticService } from '@core/services/aws/s3';  // ❌ Breaks browser builds
import { LambdaApi } from '@core/functions';               // ❌ Node.js only
```

### ✅ CORRECT: Keeping isomorphic code environment-agnostic

```typescript
// In src/lib/shared-utils.ts
import { formatDate } from '@utils/common';  // ✅ Pure utility, works everywhere
import type { UserData } from '@utils/types'; // ✅ Type-only import, no runtime cost
```

### ❌ WRONG: Using AWS SDK v2

```typescript
import AWS from 'aws-sdk';  // ❌ Deprecated, 50MB+ bundle
const s3 = new AWS.S3();
const result = await s3.getObject({ Bucket: 'my-bucket', Key: 'file.txt' }).promise();
```

### ✅ CORRECT: Using AWS SDK v3 modular imports

```typescript
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';  // ✅ Modular, <1MB
const client = new S3Client({});
const result = await client.send(new GetObjectCommand({ Bucket: 'my-bucket', Key: 'file.txt' }));
```

### ❌ WRONG: Using CDK L1 constructs

```typescript
import { CfnBucket } from 'aws-cdk-lib/aws-s3';  // ❌ L1 CloudFormation
const bucket = new CfnBucket(this, 'Bucket', {
  bucketName: 'my-bucket',
});
```

### ✅ CORRECT: Using CDK L2/L3 constructs

```typescript
import { Bucket } from 'aws-cdk-lib/aws-s3';  // ✅ L2 construct
const bucket = new Bucket(this, 'Bucket', {
  versioned: true,
  encryption: BucketEncryption.S3_MANAGED,
});
```

### ❌ WRONG: Using browser APIs in isomorphic code without guards

```typescript
// In src/lib/analytics.ts
// ❌ Crashes in Lambda SSR — window does not exist in Node.js
const userId = window.localStorage.getItem('userId');
document.title = 'My App';
```

### ✅ CORRECT: Guarding browser-only APIs

```typescript
// In src/lib/analytics.ts
// ✅ Safe in both Lambda and browser
export function getStoredUserId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem('userId');
}

// ✅ Or use useEffect in React components
useEffect(() => {
  document.title = 'My App';
}, []);
```

### ❌ WRONG: Importing CDK constructs in Lambda handler code

```typescript
// In src/core/functions/my-handler/lambda.my-handler.ts
import { Bucket } from 'aws-cdk-lib/aws-s3';  // ❌ CDK is deploy-time only
const bucket = new Bucket(/* ... */);           // ❌ Cannot create infra at runtime
```

### ✅ CORRECT: Using environment variables for resource references

```typescript
// In src/core/functions/my-handler/lambda.my-handler.ts
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';  // ✅ Runtime SDK
const bucketName = process.env.BUCKET_NAME;  // ✅ Passed via CDK environment config
```

See [Anti-Patterns Reference](references/anti-patterns.md) for the complete
categorized list of ❌/✅ pairs.

## References

- [Decision Rules](references/decision-rules.md) — All hard decision rules in structured format
- [Anti-Patterns](references/anti-patterns.md) — All ❌/✅ pairs organized by category
- [runtime-concepts](../runtime-concepts/SKILL.md) (Layer 1: Concepts) — Product definition and scope boundaries
- [runtime-api-core](../runtime-api-core/SKILL.md) (Layer 2: API) — Core type signatures and constraints
- [runtime-api-integrations](../runtime-api-integrations/SKILL.md) (Layer 2: API) — Integration types and NOT SUPPORTED rule
- [runtime-errors-and-diagnostics](../runtime-errors-and-diagnostics/SKILL.md) (Layer 5: Diagnostics) — Error resolution when constraints are violated
- [runtime-versioning-and-migration](../runtime-versioning-and-migration/SKILL.md) (Layer 5: Diagnostics) — Version-specific constraint differences
