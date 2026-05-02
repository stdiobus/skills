---
name: runtime-api-core
description: >
  Exact TypeScript type signatures and field-by-field semantics for the core
  @worktif/runtime API surface: MicroserviceDefinition, LambdaDefinition,
  TiesConstructors, LambdaEvent, InitFunction, and related utility types.
  Use this skill when generating type-correct code, understanding the ties
  type transformation system, or verifying that generated code matches the
  actual public API. Covers consumer import paths, generic parameters,
  field constraints, and finite option sets.
license: Elastic-2.0
compatibility: Requires @worktif/runtime >=0.5.0 <1.0.0
metadata:
  author: worktif
  version: "1.0.0"
  framework: "@worktif/runtime"
  frameworkVersionRange: ">=0.5.0 <1.0.0"
  layer: "2"
  layerName: "API"
---

## Overview

This skill documents the exact TypeScript signatures for the core types that
consumers use to define microservices and Lambda functions with `@worktif/runtime`.
Every type name, field name, generic parameter, and import path in this skill
matches the actual public API. No types are invented or approximated.

## When to Use

- When generating code that uses `MicroserviceDefinition` or `LambdaDefinition`
- When configuring the `ties` property and needing to understand the type transformation
- When implementing an `init` function for cold-start caching
- When accessing `event.ties` or `event.snapshot` in a handler
- When verifying that generated code uses correct generic parameters
- When determining the correct import path for a type

## Core Concepts

### Consumer Import Paths

```typescript
// Core types for defining microservices and Lambda functions
import { MicroserviceDefinition, LambdaDefinition } from '@worktif/runtime';

// CDK constructs for infrastructure deployment
import { RuntimeInfraStack, BrowserProviderStack, RuntimeWebStack } from '@worktif/runtime/infra';
```

There are NO other import paths. Do NOT invent subpath exports.

### Type Transformation: TTies → TiesConstructors → event.ties

The framework uses a type transformation system that enables a single type
definition to serve two purposes:

1. **TTies** — Defines instance types (what the handler receives)
2. **TiesConstructors\<TTies\>** — Transforms to constructor types (what the `ties` property accepts)

```
Developer defines:
  type MyTies = { userService: UsersService; configService: ConfigService }

ties property type (TiesConstructors<MyTies>):
  { userService: new (...args: any[]) => UsersService;
    configService: new (...args: any[]) => ConfigService }

Accepts at the call site:
  ties: { userService: UsersService, configService: ConfigService }
  // UsersService and ConfigService here are CLASS CONSTRUCTORS ✓

Handler receives (event.ties typed as MyTies):
  event.ties.userService  → UsersService instance with methods
  event.ties.configService → ConfigService instance with methods
```

### MicroserviceDefinition\<TSnapshot\>

The top-level grouping type. A microservice contains Ties classes, an optional
init function, and an array of Lambda definitions.

```typescript
interface MicroserviceDefinition<TSnapshot = {}> {
  ties: TiesInstance[];
  init?: InitFunction<Record<string, unknown>, TSnapshot>;
  lambdas: Array<AnyLambdaDefinition>;
}
```

**Field semantics:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ties` | `TiesInstance[]` | Yes | Array of Ties class constructors. Each class implements a `static register(container)` method that registers services into the DI container. |
| `init` | `InitFunction<Record<string, unknown>, TSnapshot>` | No | Cold-start initialization function. Executes once per execution environment. Returns a snapshot cached for warm invocations. |
| `lambdas` | `Array<AnyLambdaDefinition>` | Yes | Array of Lambda definitions. Each defines one Lambda function with its dependencies, handler, and integration config. |

**Generic parameter:**
- `TSnapshot` (default: `{}`) — The type returned by the microservice-level init function. Available to all Lambda handlers via `event.snapshot`.

### LambdaDefinition\<TTies, TSnapshot, TIntegration\>

The primary type for defining a single Lambda function with typed dependencies.

```typescript
interface LambdaDefinition<
  TTies = any,
  TSnapshot = {},
  TIntegration extends IntegrationKind = 'http'
> {
  id?: string;
  service?: string;
  ties: TTies extends Record<string, any>
    ? TiesConstructors<TTies>
    : Array<new (...args: unknown[]) => unknown>;
  init?: InitFunction<TTies, TSnapshot>;
  handler: TTies extends Record<string, any>
    ? LambdaHandler<TTies, TSnapshot, IntegrationEventMap[TIntegration]>
    : LambdaHandlerFactory;
  http?: HttpIntegration;
  sqs?: SqsIntegration;
  eventbridge?: EventBridgeIntegration;
  schedule?: ScheduleIntegration;
  s3?: S3Integration;
  dynamodb?: DynamoDbStreamIntegration;
  sns?: SnsIntegration;
  kinesis?: KinesisIntegration;
  config?: LambdaConfig;
}
```

**Field semantics:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | No | Unique identifier within the microservice. Auto-generated if omitted. Final ID: `{serviceName}.{id}`. |
| `service` | `string` | No | **Internal — do NOT set manually.** Auto-populated by the framework during registration. |
| `ties` | `TiesConstructors<TTies>` or `Array<Constructor>` | Yes | Object of class constructors (recommended) or array of class constructors (legacy). |
| `init` | `InitFunction<TTies, TSnapshot>` | No | Lambda-level cold-start init. Executes after microservice-level init. |
| `handler` | `LambdaHandler<TTies, TSnapshot, TEvent>` or `LambdaHandlerFactory` | Yes | Direct async function (object ties) or factory function (array ties). |
| `http` | `HttpIntegration` | No | HTTP integration config. Set this for API Gateway endpoints. |
| `sqs` | `SqsIntegration` | No | SQS queue trigger config. |
| `eventbridge` | `EventBridgeIntegration` | No | EventBridge rule trigger config. |
| `schedule` | `ScheduleIntegration` | No | Scheduled task config (cron/rate). |
| `s3` | `S3Integration` | No | S3 bucket notification config. |
| `dynamodb` | `DynamoDbStreamIntegration` | No | DynamoDB Streams trigger config. |
| `sns` | `SnsIntegration` | No | SNS topic subscription config. |
| `kinesis` | `KinesisIntegration` | No | Kinesis stream trigger config. |
| `config` | `LambdaConfig` | No | Per-Lambda overrides: memorySize, timeout, environment. |

**Generic parameters:**
- `TTies` (default: `any`) — Instance types for handler access. When `Record<string, any>`, enables object-based ties with full type safety.
- `TSnapshot` (default: `{}`) — Return type of the init function. Available via `event.snapshot`.
- `TIntegration` (default: `'http'`) — The integration kind. Determines the base event type in the handler via `IntegrationEventMap[TIntegration]`.

**Constraint:** The `ties` property accepts ONLY class constructors. Not instances, not factory functions, not plain objects. The framework is responsible for instantiation.

### LambdaEvent\<TTies, TSnapshot, TBaseEvent\>

The augmented event type received by handlers. Extends the base AWS event with
typed `ties` and `snapshot` properties.

```typescript
type LambdaEvent<TTies, TSnapshot = {}, TBaseEvent = APIGatewayProxyEvent> =
  TBaseEvent & {
    ties: TTies;
    snapshot: TSnapshot;
  };
```

The handler receives this augmented event. `TBaseEvent` is determined by the
integration kind via `IntegrationEventMap[TIntegration]`.

### InitFunction\<TTies, TSnapshot\>

The cold-start initialization function type.

```typescript
type InitFunction<TTies, TSnapshot> = (ties: TTies) => Promise<TSnapshot>;
```

- Receives the typed ties instances as input
- Returns a Promise of the snapshot object
- Executes once per Lambda execution environment (cold start only)
- Result is cached for all subsequent warm invocations

### Utility Types

```typescript
// Transforms instance type to constructor type
type Constructor<T> = new (...args: any[]) => T;

// Transforms object of instance types to object of constructor types
type TiesConstructors<T> = { [K in keyof T]: Constructor<T[K]> };

// Wildcard LambdaDefinition for mixed arrays
type AnyLambdaDefinition = LambdaDefinition<any, any, any>;

// Ties class constructor type (for MicroserviceDefinition.ties)
type TiesInstance<T = unknown> = new (...args: unknown[]) => T;
```

## Instructions

### Finite Option Sets

When generating code, use ONLY these values. No others exist.

**IntegrationKind** — EXACTLY 9 values:
`'http'`, `'sqs'`, `'eventbridge'`, `'s3'`, `'dynamodb'`, `'sns'`, `'kinesis'`, `'schedule'`, `'direct'`

**HttpMethod** — EXACTLY 6 values:
`'GET'`, `'POST'`, `'PUT'`, `'PATCH'`, `'DELETE'`, `'OPTIONS'`

**AuthConfig types** — EXACTLY 5 discriminated union members:
`AuthConfigNone` (`type: 'none'`), `AuthConfigIam` (`type: 'iam'`), `AuthConfigJwt` (`type: 'jwt'`), `AuthConfigCognito` (`type: 'cognito'`), `AuthConfigCustom` (`type: 'custom'`)

### Object-Based Ties Pattern (Recommended)

```typescript
// Step 1: Define service classes
class UsersService {
  async getUser(id: string): Promise<User> { /* ... */ }
}

class ConfigService {
  getValue(key: string): string { /* ... */ }
}

// Step 2: Define ties type (instance types for handler access)
type GetUserTies = {
  userService: UsersService;
  configService: ConfigService;
};

// Step 3: Create Lambda definition with typed ties
export const getUserHandler: LambdaDefinition<GetUserTies> = {
  id: 'get-user',
  ties: {
    userService: UsersService,     // Class constructor ✓
    configService: ConfigService,  // Class constructor ✓
  },
  handler: async (event, context) => {
    // event.ties.userService is typed as UsersService instance
    // event.ties.configService is typed as ConfigService instance
    const user = await event.ties.userService.getUser(event.pathParameters?.id ?? '');
    return { statusCode: 200, body: JSON.stringify(user) };
  },
  http: { method: 'GET', path: '/users/{id}' },
};
```

### Using Init for Cold-Start Caching

```typescript
type MyTies = { dbService: DatabaseService };
type MySnapshot = { connection: Connection; config: AppConfig };

export const handler: LambdaDefinition<MyTies, MySnapshot> = {
  ties: { dbService: DatabaseService },
  init: async (ties) => {
    // Executes once on cold start
    const connection = await ties.dbService.connect();
    const config = await ties.dbService.loadConfig();
    return { connection, config };
  },
  handler: async (event, context) => {
    // event.snapshot.connection is cached from cold start
    // event.snapshot.config is cached from cold start
    const result = await event.snapshot.connection.query('SELECT 1');
    return { statusCode: 200, body: JSON.stringify(result) };
  },
  http: { method: 'GET', path: '/health' },
};
```

### Microservice with Multiple Lambdas

```typescript
import { MicroserviceDefinition, LambdaDefinition } from '@worktif/runtime';

class PaymentsTies {
  static register(container: PureContainer<string>) {
    container.tie('paymentsService', PaymentsService, []);
    container.tie('billingService', BillingService, []);
  }
}

type ChargeTies = { paymentsService: PaymentsService };
type RefundTies = { paymentsService: PaymentsService; billingService: BillingService };

const chargeHandler: LambdaDefinition<ChargeTies> = {
  id: 'charge',
  ties: { paymentsService: PaymentsService },
  handler: async (event, context) => {
    const result = await event.ties.paymentsService.charge(JSON.parse(event.body ?? '{}'));
    return { statusCode: 200, body: JSON.stringify(result) };
  },
  http: { method: 'POST', path: '/payments/charge', auth: { type: 'jwt', issuer: 'https://auth.example.com' } },
};

const refundHandler: LambdaDefinition<RefundTies> = {
  id: 'refund',
  ties: { paymentsService: PaymentsService, billingService: BillingService },
  handler: async (event, context) => {
    const result = await event.ties.paymentsService.refund(JSON.parse(event.body ?? '{}'));
    await event.ties.billingService.recordRefund(result);
    return { statusCode: 200, body: JSON.stringify(result) };
  },
  http: { method: 'POST', path: '/payments/refund', auth: { type: 'jwt', issuer: 'https://auth.example.com' } },
};

export const paymentsService: MicroserviceDefinition = {
  ties: [PaymentsTies],
  lambdas: [chargeHandler, refundHandler],
};
```

### Integration Kind Determines Handler Event Type

The third generic parameter `TIntegration` determines the base event type:

```typescript
// HTTP handler receives APIGatewayProxyEvent
const httpHandler: LambdaDefinition<MyTies, {}, 'http'> = { /* ... */ };

// SQS handler receives SQSEvent
const sqsHandler: LambdaDefinition<MyTies, {}, 'sqs'> = { /* ... */ };

// EventBridge handler receives EventBridgeEvent
const ebHandler: LambdaDefinition<MyTies, {}, 'eventbridge'> = { /* ... */ };
```

The mapping is defined by `IntegrationEventMap`:

| IntegrationKind | Event Type |
|-----------------|------------|
| `'http'` | `APIGatewayProxyEvent` |
| `'sqs'` | `SQSEvent` |
| `'eventbridge'` | `EventBridgeEvent<string, unknown>` |
| `'s3'` | `S3Event` |
| `'dynamodb'` | `DynamoDBStreamEvent` |
| `'sns'` | `SNSEvent` |
| `'kinesis'` | `KinesisStreamEvent` |
| `'schedule'` | `ScheduledEvent` |
| `'direct'` | `any` |

## Common Mistakes

### ❌ WRONG: Instantiating ties (passing instances instead of constructors)

```typescript
const handler: LambdaDefinition<MyTies> = {
  ties: {
    userService: new UsersService(),  // ❌ Instance — framework instantiates, not you
  },
  handler: async (event) => { /* ... */ },
};
```

### ✅ CORRECT: Passing class constructors

```typescript
const handler: LambdaDefinition<MyTies> = {
  ties: {
    userService: UsersService,  // ✅ Class constructor
  },
  handler: async (event) => { /* ... */ },
};
```

### ❌ WRONG: Importing from non-existent subpaths

```typescript
import { LambdaDefinition } from '@worktif/runtime/types';  // ❌ Does not exist
import { RuntimeWebStack } from '@worktif/runtime/cdk';     // ❌ Does not exist
import { HttpIntegration } from '@worktif/runtime/http';    // ❌ Does not exist
```

### ✅ CORRECT: Using the two valid import paths

```typescript
import { MicroserviceDefinition, LambdaDefinition } from '@worktif/runtime';                    // ✅
import { RuntimeInfraStack, BrowserProviderStack, RuntimeWebStack } from '@worktif/runtime/infra';  // ✅
```

### ❌ WRONG: Omitting the generic parameter (losing type safety)

```typescript
// ❌ No generic — event.ties is typed as 'any', no IntelliSense
const handler: LambdaDefinition = {
  ties: { userService: UsersService },
  handler: async (event) => {
    event.ties.userService.getUser('123');  // No type checking
  },
};
```

### ✅ CORRECT: Providing the TTies generic parameter

```typescript
type MyTies = { userService: UsersService };

// ✅ Generic provides full type safety for event.ties
const handler: LambdaDefinition<MyTies> = {
  ties: { userService: UsersService },
  handler: async (event) => {
    event.ties.userService.getUser('123');  // ✅ Fully typed, IntelliSense works
  },
};
```

### ❌ WRONG: Setting the `service` field manually

```typescript
const handler: LambdaDefinition<MyTies> = {
  id: 'get-user',
  service: 'users',  // ❌ Internal field — auto-populated by framework
  ties: { userService: UsersService },
  handler: async (event) => { /* ... */ },
};
```

### ✅ CORRECT: Letting the framework set `service`

```typescript
const handler: LambdaDefinition<MyTies> = {
  id: 'get-user',  // ✅ Only set id — service is auto-populated
  ties: { userService: UsersService },
  handler: async (event) => { /* ... */ },
};
```

### ❌ WRONG: Using array-based ties for new code

```typescript
// ❌ Legacy pattern — less type-safe, requires casting
const handler: LambdaDefinition = {
  ties: [UsersService, ConfigService],
  handler: (ties) => async (event, context) => {
    const userService = ties.userService as UsersService;  // Manual casting
  },
};
```

### ✅ CORRECT: Using object-based ties (recommended)

```typescript
type MyTies = { userService: UsersService; configService: ConfigService };

// ✅ Object-based ties — full type safety, no casting needed
const handler: LambdaDefinition<MyTies> = {
  ties: { userService: UsersService, configService: ConfigService },
  handler: async (event) => {
    event.ties.userService.getUser('123');  // ✅ Fully typed
    event.ties.configService.getValue('key');  // ✅ Fully typed
  },
};
```

## References

- [Type Signatures Reference](references/type-signatures.md) — Complete type signatures with JSDoc documentation
- [runtime-concepts](../runtime-concepts/SKILL.md) (Layer 1: Concepts) — Domain model and framework scope
- [runtime-api-integrations](../runtime-api-integrations/SKILL.md) (Layer 2: API) — Configuration interfaces for all 9 integration types
- [runtime-patterns-http](../runtime-patterns-http/SKILL.md) (Layer 3: Patterns) — Canonical HTTP endpoint templates
- [runtime-constraints-and-guardrails](../runtime-constraints-and-guardrails/SKILL.md) (Layer 4: Guardrails) — Hard constraints and anti-patterns
