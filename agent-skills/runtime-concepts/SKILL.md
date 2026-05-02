---
name: runtime-concepts
description: >
  Product definition and core domain concepts for @worktif/runtime — an AWS Lambda
  serverless framework. Covers what the framework is, what it supports, what it does
  not support, and the relationships between Microservices, Lambda definitions,
  integration kinds, the Ties dependency injection pattern, the Snapshot cold-start
  pattern, and the multi-stack CDK deployment model with multi-platform support. Use this skill when encountering
  @worktif/runtime for the first time or when reasoning about framework scope and
  domain model.
license: Elastic-2.0
compatibility: Requires @worktif/runtime >=0.5.0 <1.0.0
metadata:
  author: worktif
  version: "1.0.0"
  framework: "@worktif/runtime"
  frameworkVersionRange: ">=0.5.0 <1.0.0"
  layer: "1"
  layerName: "Concepts"
---

## Overview

`@worktif/runtime` is an AWS Lambda serverless framework for building microservice-based
portals, platforms, and websites. Consumers install it as an npm package and use its
declarative TypeScript API to define Lambda functions with the typed Ties pattern,
configure integrations, and deploy infrastructure via AWS CDK.

## When to Use

- When an AI agent encounters `@worktif/runtime` for the first time and needs to understand what it is
- When reasoning about whether a requested feature is within framework scope
- When determining the correct domain concept for a consumer's question
- When establishing the mental model before generating code
- When verifying that generated code uses correct terminology and relationships

## Core Concepts

### Product Definition

`@worktif/runtime` is an AWS Lambda serverless framework that consumers install via
`npm install @worktif/runtime`. It provides:

- A declarative TypeScript API for defining Lambda microservices
- Typed Ties pattern for service resolution
- Cold-start optimization via the Snapshot pattern
- AWS CDK constructs for infrastructure deployment
- Optional server-side rendered React support

### Scope: What IS Supported

- AWS Lambda microservices with the typed Ties pattern
- HTTP APIs via API Gateway (v2 HTTP API or v1 REST API)
- Async event processing: SQS, EventBridge, SNS, Kinesis, S3 integrations, DynamoDB Streams, scheduled tasks
- CDK infrastructure deployment (multi-stack model)
- Optional SSR React with hydration
- AWS SDK v3 modular imports

### Scope: What is NOT Supported

- Non-AWS clouds (Azure, GCP, etc.)
- Non-Lambda compute (ECS, Fargate, EC2, containers)
- WebSockets (native)
- GraphQL (native)
- Non-React frontends (Vue, Angular, Svelte)
- AWS SDK v2 (`aws-sdk` package)
- Any IntegrationKind value not in the 9 documented types

### Domain Model

A **Microservice** is the top-level grouping. It contains:

1. **Ties** — An array of class constructors that register services into a DI container
2. **Init** (optional) — A function that executes on cold start and returns a cached Snapshot
3. **Lambdas** — An array of Lambda definitions, each representing one Lambda function

Each **LambdaDefinition** belongs to exactly one Microservice and has exactly one
**IntegrationKind** from EXACTLY these 9 supported types:

`'http' | 'sqs' | 'eventbridge' | 's3' | 'dynamodb' | 'sns' | 'kinesis' | 'schedule' | 'direct'`

No other integration types exist.

### The Ties Pattern

The Ties pattern provides typed service resolution for Lambda handlers:

1. Consumer declares class constructors in the `ties` property of a LambdaDefinition
2. The framework instantiates those classes (consumer does NOT instantiate them)
3. The handler receives fully typed instances via `event.ties.serviceName`

The type system uses `TiesConstructors<T>` to transform instance types to constructor
types. This means:

- The `ties` property accepts **class constructors** (the class itself)
- The handler's `event.ties` provides **instances** (objects with methods)

```typescript
type MyTies = { userService: UsersService };

const handler: LambdaDefinition<MyTies> = {
  ties: {
    userService: UsersService,  // Class constructor (NOT an instance)
  },
  handler: async (event, context) => {
    // event.ties.userService is a fully typed UsersService instance
    const user = await event.ties.userService.getUser('123');
    return { statusCode: 200, body: JSON.stringify(user) };
  },
  http: { method: 'GET', path: '/users/{id}' },
};
```

### The Snapshot Pattern (Cold-Start Caching)

The Snapshot pattern optimizes Lambda cold starts:

1. An `init` function executes once during cold start
2. It receives the ties instances and returns a snapshot object
3. The snapshot is cached for all subsequent warm invocations
4. Handlers access the cached result via `event.snapshot`

```typescript
type MyTies = { dbService: DatabaseService };
type MySnapshot = { connection: Connection };

const handler: LambdaDefinition<MyTies, MySnapshot> = {
  ties: { dbService: DatabaseService },
  init: async (ties) => {
    const connection = await ties.dbService.connect();
    return { connection };
  },
  handler: async (event, context) => {
    // event.snapshot.connection is cached from cold start
    const result = await event.snapshot.connection.query('SELECT 1');
    return { statusCode: 200, body: JSON.stringify(result) };
  },
};
```

### Multi-Stack CDK Architecture

The framework uses 3 core stacks plus 1 optional stack for deployment, with
multi-platform support via the `platformName` prop on all stacks:

1. **RuntimeInfraStack** — Slow-changing base infrastructure:
   - S3 bucket for static assets and cache
   - IAM role for Lambda execution
   - Optional DynamoDB table for SEO metadata
   - CloudFront OAI configuration

2. **BrowserProviderStack** — SSR deployment (optional):
   - Lambda functions for server-side rendering
   - CloudFront distribution for content delivery
   - API Gateway for HTTP routing to render Lambda
   - Lambda warmup via CloudWatch Events

3. **RuntimeWebStack** — Microservices deployment:
   - Lambda functions from MicroserviceDefinition registrations
   - API Gateway routes (HTTP API or REST API)
   - Event source mappings (SQS, EventBridge, S3, DynamoDB Streams, etc.)

4. **RuntimeAwakeStack** (optional) — Local debugging infrastructure:
   - AWS IoT Core MQTT for routing requests to local CLI
   - DynamoDB session table for developer session tracking
   - S3 bucket for large payload storage

All stacks accept an optional `platformName` prop that enables per-platform resource
isolation. When set, resource names include the platform segment using the formula
`[projectName, platformName, stackTitle, stage].filter(Boolean).join('-')`.

```typescript
import { RuntimeInfraStack, BrowserProviderStack } from '@worktif/runtime/infra';
import { RuntimeWebStack } from '@worktif/runtime/infra';

const infraStack = new RuntimeInfraStack(app, 'MyApp-Infra-dev', {
  stage: 'dev',
  serviceName: 'my-app',
  platformName: 'web',  // Optional: multi-platform isolation
});

// SSR deployment (optional)
new BrowserProviderStack(app, 'MyApp-Browser-dev', {
  stage: 'dev',
  serviceName: 'my-app',
  appEntryPoint: './src/index.tsx',
  infraStack,
  platformName: 'web',
});

// Microservices deployment
new RuntimeWebStack(app, 'MyApp-API-dev', {
  stage: 'dev',
  serviceName: 'my-app',
  infraStack,
  register: { payments: paymentsService, users: usersService },
  platformName: 'web',
});
```

## Instructions

### Finite Option Sets

When generating code for this framework, use ONLY these values:

**IntegrationKind** (9 values, no others exist):
`'http'`, `'sqs'`, `'eventbridge'`, `'s3'`, `'dynamodb'`, `'sns'`, `'kinesis'`, `'schedule'`, `'direct'`

**HttpMethod** (6 values):
`'GET'`, `'POST'`, `'PUT'`, `'PATCH'`, `'DELETE'`, `'OPTIONS'`

**AuthConfig types** (5 discriminated union members):
`AuthConfigNone`, `AuthConfigIam`, `AuthConfigJwt`, `AuthConfigCognito`, `AuthConfigCustom`

### Consumer Import Paths

```typescript
// Core types for defining microservices and Lambda functions
import { MicroserviceDefinition, LambdaDefinition } from '@worktif/runtime';

// CDK constructs for infrastructure deployment
import { RuntimeInfraStack, BrowserProviderStack } from '@worktif/runtime/infra';
import { RuntimeWebStack } from '@worktif/runtime/infra';
```

### Key Constraints

- `ties` accepts ONLY class constructors (not instances, not factory functions, not plain objects)
- The framework is responsible for instantiation — consumers never call `new` on ties classes
- Each Lambda has exactly one integration kind (set via the corresponding config property: `http`, `sqs`, `eventbridge`, etc.)
- AWS SDK v3 modular imports only — never use the deprecated `aws-sdk` v2 package
- Lambda bundle must be <10MB compressed (AWS hard limit)
- Browser bundle must be <500KB gzipped (performance target)

## Common Mistakes

### ❌ WRONG: Instantiating ties directly

```typescript
const handler: LambdaDefinition<MyTies> = {
  ties: {
    userService: new UsersService(),  // ❌ Framework instantiates, not you
  },
  handler: async (event) => { /* ... */ },
};
```

### ✅ CORRECT: Passing class constructors

```typescript
const handler: LambdaDefinition<MyTies> = {
  ties: {
    userService: UsersService,  // ✅ Class constructor — framework handles instantiation
  },
  handler: async (event) => { /* ... */ },
};
```

### ❌ WRONG: Inventing unsupported integration types

```typescript
const handler: LambdaDefinition<MyTies> = {
  // ...
  websocket: { route: '$connect' },  // ❌ WebSocket is NOT a supported IntegrationKind
};
```

### ✅ CORRECT: Using one of the 9 supported integration types

```typescript
const handler: LambdaDefinition<MyTies> = {
  // ...
  http: { method: 'GET', path: '/connect' },  // ✅ Use a supported integration
};
```

### ❌ WRONG: Using AWS SDK v2

```typescript
import AWS from 'aws-sdk';  // ❌ Deprecated, creates massive bundles
const s3 = new AWS.S3();
```

### ✅ CORRECT: Using AWS SDK v3 modular imports

```typescript
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';  // ✅ Modular v3
const client = new S3Client({});
```

### ❌ WRONG: Accessing ties not declared in the ties property

```typescript
type MyTies = { userService: UsersService };

const handler: LambdaDefinition<MyTies> = {
  ties: { userService: UsersService },
  handler: async (event) => {
    // ❌ configService was never declared in ties
    const config = event.ties.configService.getValue('key');
  },
};
```

### ✅ CORRECT: Declaring all required services in ties

```typescript
type MyTies = { userService: UsersService; configService: ConfigService };

const handler: LambdaDefinition<MyTies> = {
  ties: { userService: UsersService, configService: ConfigService },
  handler: async (event) => {
    // ✅ configService is declared and typed
    const config = event.ties.configService.getValue('key');
  },
};
```

## References

- [Domain Model Details](references/domain-model.md) — Detailed entity relationships and type mappings
- [runtime-api-core](../runtime-api-core/SKILL.md) (Layer 2: API) — Exact type signatures for MicroserviceDefinition and LambdaDefinition
- [runtime-api-integrations](../runtime-api-integrations/SKILL.md) (Layer 2: API) — Configuration interfaces for all 9 integration types
- [runtime-constraints-and-guardrails](../runtime-constraints-and-guardrails/SKILL.md) (Layer 4: Guardrails) — Complete list of constraints and anti-patterns
