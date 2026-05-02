---
name: runtime-api-integrations
description: >
  Exact configuration interfaces for all 9 supported IntegrationKind values in
  @worktif/runtime: http, sqs, eventbridge, s3, dynamodb, sns, kinesis, schedule,
  and direct. Documents each integration's fields, valid value ranges, and constraints.
  Also covers the 5 AuthConfig discriminated union types for HTTP authentication.
  Use this skill when configuring event sources for Lambda functions, setting up
  authentication, or verifying that integration configuration is correct.
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

This skill documents the exact configuration interfaces for each of the 9 supported
integration types in `@worktif/runtime`. Each integration type maps to a specific
AWS event source and has a corresponding configuration interface with precise fields
and constraints. All field names, types, and valid values match the actual public API.

## When to Use

- When configuring an event source for a Lambda function (SQS, EventBridge, S3, etc.)
- When setting up HTTP authentication for an API endpoint
- When a consumer asks for an integration type and you need to verify it exists
- When determining valid field values for an integration configuration
- When choosing between CDK construct references and string identifiers

## Core Concepts

### IntegrationKind — EXACTLY 9 Values

The framework supports EXACTLY these 9 integration types. **NO OTHER integration types exist.**

| Kind | AWS Service | Event Type | Config Property |
|------|-------------|------------|-----------------|
| `'http'` | API Gateway | `APIGatewayProxyEvent` | `http` |
| `'sqs'` | Amazon SQS | `SQSEvent` | `sqs` |
| `'eventbridge'` | Amazon EventBridge | `EventBridgeEvent<string, unknown>` | `eventbridge` |
| `'s3'` | Amazon S3 | `S3Event` | `s3` |
| `'dynamodb'` | DynamoDB Streams | `DynamoDBStreamEvent` | `dynamodb` |
| `'sns'` | Amazon SNS | `SNSEvent` | `sns` |
| `'kinesis'` | Kinesis Data Streams | `KinesisStreamEvent` | `kinesis` |
| `'schedule'` | EventBridge Scheduler | `ScheduledEvent` | `schedule` |
| `'direct'` | Direct invocation | `any` | (none) |

**RULE**: If a consumer asks for an integration type not in this list (WebSocket, GraphQL,
Kafka, IoT, AppSync, etc.), the ONLY correct response is:
1. State that the requested integration type is not supported
2. List the 9 supported types
3. Suggest the closest supported alternative
4. Do NOT fabricate framework features or invent unsupported integration types

### How Integration Config Properties Work

Each Lambda definition has optional config properties corresponding to integration types.
Set exactly ONE integration config property to define the event source:

```typescript
const handler: LambdaDefinition<MyTies> = {
  ties: { /* ... */ },
  handler: async (event, context) => { /* ... */ },
  // Set exactly ONE of these:
  http: { /* HttpIntegration */ },
  // OR sqs: { /* SqsIntegration */ },
  // OR eventbridge: { /* EventBridgeIntegration */ },
  // OR s3: { /* S3Integration */ },
  // OR dynamodb: { /* DynamoDbStreamIntegration */ },
  // OR sns: { /* SnsIntegration */ },
  // OR kinesis: { /* KinesisIntegration */ },
  // OR schedule: { /* ScheduleIntegration */ },
  // OR (none for 'direct')
};
```

## Instructions

### HttpIntegration

Configures an API Gateway HTTP endpoint for the Lambda function.

```typescript
interface HttpIntegration {
  method: HttpMethod;           // Required: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'OPTIONS'
  path: string;                 // Required: URL path with {param} syntax
  auth?: AuthType | AuthConfig; // Optional: Authentication (default: 'none')
  cors?: boolean;               // Optional: Enable CORS (default: true)
  corsConfig?: CorsConfig;      // Optional: Detailed CORS settings
}
```

**HttpMethod** — EXACTLY 6 values: `'GET'`, `'POST'`, `'PUT'`, `'PATCH'`, `'DELETE'`, `'OPTIONS'`

**Path parameter syntax**: Use `{paramName}` for dynamic segments.
- `/users` — static path
- `/users/{id}` — single parameter
- `/users/{userId}/orders/{orderId}` — multiple parameters

**Example:**
```typescript
http: {
  method: 'POST',
  path: '/users/{userId}/orders',
  auth: { type: 'jwt', issuer: 'https://auth.example.com', audience: ['api.example.com'] },
  cors: true,
}
```

### SqsIntegration

Configures an SQS queue as the event source.

```typescript
interface SqsIntegration {
  queue: IQueue | string;                  // Required: CDK construct or ARN string
  batchSize?: number;                      // Optional: 1–10000 (default: 10)
  maxBatchingWindowSeconds?: number;       // Optional: 0–300
  reportBatchItemFailures?: boolean;       // Optional: Enable partial failure reporting
  enabled?: boolean;                       // Optional: Enable/disable mapping
}
```

### EventBridgeIntegration

Configures an EventBridge rule to trigger the Lambda.

```typescript
interface EventBridgeIntegration {
  eventBus?: IEventBus | string;   // Optional: CDK construct, ARN, or name (default: default bus)
  eventPattern: {                  // Required: Event pattern to match
    source?: string[];
    detailType?: string[];
    detail?: Record<string, unknown>;
  };
  description?: string;            // Optional: Rule description
}
```

### S3Integration

Configures S3 bucket notifications to trigger the Lambda.

```typescript
interface S3Integration {
  bucket: IBucket | string;   // Required: CDK construct or bucket name
  events: string[];           // Required: S3 event types (e.g., 's3:ObjectCreated:*')
  prefix?: string;            // Optional: Key prefix filter
  suffix?: string;            // Optional: Key suffix filter
}
```

### DynamoDbStreamIntegration

Configures a DynamoDB table stream to trigger the Lambda.

```typescript
interface DynamoDbStreamIntegration {
  table: ITable | string;                    // Required: CDK construct or table name/ARN
  startingPosition: 'TRIM_HORIZON' | 'LATEST';  // Required: Stream starting position
  batchSize?: number;                        // Optional: Records per batch
  maxBatchingWindowSeconds?: number;         // Optional: Max batching window
  reportBatchItemFailures?: boolean;         // Optional: Partial failure reporting
}
```

**startingPosition values:**
- `'TRIM_HORIZON'` — Process all records from the beginning of the stream
- `'LATEST'` — Process only new records added after the mapping is created

### SnsIntegration

Configures an SNS topic subscription to trigger the Lambda.

```typescript
interface SnsIntegration {
  topic: ITopic | string;                   // Required: CDK construct or topic ARN
  filterPolicy?: Record<string, unknown>;   // Optional: Subscription filter policy
  rawMessageDelivery?: boolean;             // Optional: Raw message delivery
}
```

### KinesisIntegration

Configures a Kinesis stream to trigger the Lambda.

```typescript
interface KinesisIntegration {
  stream: IStream | string;                      // Required: CDK construct or stream ARN
  startingPosition: 'TRIM_HORIZON' | 'LATEST';  // Required: Stream starting position
  batchSize?: number;                            // Optional: Records per batch
  maxBatchingWindowSeconds?: number;             // Optional: Max batching window
}
```

### ScheduleIntegration

Configures a scheduled rule (cron or rate) to trigger the Lambda.

```typescript
interface ScheduleIntegration {
  schedule: string;       // Required: Cron or rate expression
  description?: string;   // Optional: Rule description
  enabled?: boolean;      // Optional: Enable/disable
}
```

**Schedule expression formats:**
- Rate: `'rate(5 minutes)'`, `'rate(1 hour)'`, `'rate(7 days)'`
- Cron: `'cron(0 12 * * ? *)'` (noon UTC daily), `'cron(0 0 1 * ? *)'` (first of month)

### Direct Integration

The `'direct'` integration kind has no configuration property. It represents
Lambda functions invoked directly (via AWS SDK `Invoke` API) without an event
source mapping. The handler receives an arbitrary payload typed as `any`.

### AuthConfig — 5 Discriminated Union Types

The `auth` property on `HttpIntegration` accepts either a string (`AuthType`) or
a full configuration object (`AuthConfig`).

**AuthType strings** (convenience): `'none'`, `'jwt'`, `'iam'`, `'cognito'`, `'custom'`

**AuthConfig objects** (EXACTLY 5 types, discriminated by `type` field):

| Type | Required Fields | Use Case |
|------|----------------|----------|
| `AuthConfigNone` | `type: 'none'` | Public endpoint |
| `AuthConfigIam` | `type: 'iam'` | Service-to-service (AWS IAM) |
| `AuthConfigJwt` | `type: 'jwt'`, `issuer` | Any OIDC provider |
| `AuthConfigCognito` | `type: 'cognito'`, `userPoolId`+`region` OR `issuer` | Cognito User Pool |
| `AuthConfigCustom` | `type: 'custom'`, `authorizerLambda` | Custom Lambda authorizer |

**JWT example:**
```typescript
auth: { type: 'jwt', issuer: 'https://auth.example.com', audience: ['api.example.com'] }
```

**Cognito example:**
```typescript
auth: { type: 'cognito', userPoolId: 'us-east-1_xxxxx', region: 'us-east-1', userPoolClientIds: ['client-id'] }
```

**Custom example:**
```typescript
auth: { type: 'custom', authorizerLambda: myAuthFn, enableSimpleResponses: true }
```

See [Integration Configs Reference](references/integration-configs.md) for complete field details.

### CDK Construct vs String References

Integration config properties that reference AWS resources accept either a CDK construct
(type-safe) or a string identifier (ARN/name). See the
[Integration Configs Reference](references/integration-configs.md) for the full mapping.

## Common Mistakes

### ❌ WRONG: Using an unsupported integration type

```typescript
const handler: LambdaDefinition<MyTies> = {
  ties: { /* ... */ },
  handler: async (event) => { /* ... */ },
  websocket: { route: '$connect' },  // ❌ 'websocket' is NOT a supported IntegrationKind
};
```

### ✅ CORRECT: Using one of the 9 supported types

```typescript
const handler: LambdaDefinition<MyTies> = {
  ties: { /* ... */ },
  handler: async (event) => { /* ... */ },
  http: { method: 'GET', path: '/connect' },  // ✅ Use a supported integration
};
```

### ❌ WRONG: Missing required fields in integration config

```typescript
// ❌ Missing 'method' (required) and 'path' (required)
http: { auth: 'jwt' }

// ❌ Missing 'queue' (required)
sqs: { batchSize: 10 }

// ❌ Missing 'eventPattern' (required)
eventbridge: { eventBus: 'my-bus' }

// ❌ Missing 'startingPosition' (required)
dynamodb: { table: usersTable, batchSize: 100 }

// ❌ Missing 'schedule' expression (required)
schedule: { description: 'My task' }
```

### ✅ CORRECT: Including all required fields

```typescript
// ✅ All required fields present
http: { method: 'GET', path: '/users' }

sqs: { queue: 'arn:aws:sqs:us-east-1:123456789012:my-queue' }

eventbridge: { eventPattern: { source: ['my-app'] } }

dynamodb: { table: usersTable, startingPosition: 'LATEST' }

schedule: { schedule: 'rate(5 minutes)' }
```

### ❌ WRONG: Using wrong integration type names

```typescript
// ❌ Wrong names — these do NOT exist
const handler: LambdaDefinition<MyTies> = {
  // ...
  queue: { /* ... */ },          // ❌ Use 'sqs', not 'queue'
  events: { /* ... */ },         // ❌ Use 'eventbridge', not 'events'
  stream: { /* ... */ },         // ❌ Use 'kinesis', not 'stream'
  cron: { /* ... */ },           // ❌ Use 'schedule', not 'cron'
  trigger: { /* ... */ },        // ❌ Use 's3', not 'trigger'
  dynamodbStream: { /* ... */ }, // ❌ Use 'dynamodb', not 'dynamodbStream'
};
```

### ✅ CORRECT: Using exact property names

```typescript
const handler: LambdaDefinition<MyTies> = {
  // ...
  sqs: { /* ... */ },          // ✅ Correct property name
  eventbridge: { /* ... */ },  // ✅ Correct property name
  kinesis: { /* ... */ },      // ✅ Correct property name
  schedule: { /* ... */ },     // ✅ Correct property name
  s3: { /* ... */ },           // ✅ Correct property name
  dynamodb: { /* ... */ },     // ✅ Correct property name
};
```

### ❌ WRONG: Setting multiple integration configs on one Lambda

```typescript
// ❌ A Lambda has exactly ONE integration kind
const handler: LambdaDefinition<MyTies> = {
  ties: { /* ... */ },
  handler: async (event) => { /* ... */ },
  http: { method: 'POST', path: '/orders' },
  sqs: { queue: ordersQueue },  // ❌ Cannot have both http AND sqs
};
```

### ✅ CORRECT: One integration config per Lambda

```typescript
// ✅ HTTP endpoint
const httpHandler: LambdaDefinition<MyTies> = {
  ties: { /* ... */ },
  handler: async (event) => { /* ... */ },
  http: { method: 'POST', path: '/orders' },
};

// ✅ SQS worker (separate Lambda)
const sqsHandler: LambdaDefinition<MyTies, {}, 'sqs'> = {
  ties: { /* ... */ },
  handler: async (event) => { /* ... */ },
  sqs: { queue: ordersQueue, reportBatchItemFailures: true },
};
```

### ❌ WRONG: Using AuthType string for complex auth

```typescript
// ❌ String 'jwt' provides no issuer — incomplete configuration
http: {
  method: 'GET',
  path: '/users',
  auth: 'jwt',  // ❌ Where is the issuer? Audience?
}
```

### ✅ CORRECT: Using AuthConfig object for JWT/Cognito

```typescript
// ✅ Full JWT configuration with issuer and audience
http: {
  method: 'GET',
  path: '/users',
  auth: {
    type: 'jwt',
    issuer: 'https://auth.example.com',
    audience: ['api.example.com'],
  },
}
```

## References

- [Integration Configs Reference](references/integration-configs.md) — Per-integration field reference with valid value ranges and defaults
- [runtime-api-core](../runtime-api-core/SKILL.md) (Layer 2: API) — Core type signatures for LambdaDefinition
- [runtime-concepts](../runtime-concepts/SKILL.md) (Layer 1: Concepts) — Domain model and framework scope
- [runtime-patterns-http](../runtime-patterns-http/SKILL.md) (Layer 3: Patterns) — Canonical HTTP endpoint templates
- [runtime-patterns-async](../runtime-patterns-async/SKILL.md) (Layer 3: Patterns) — Canonical async processing templates
- [runtime-constraints-and-guardrails](../runtime-constraints-and-guardrails/SKILL.md) (Layer 4: Guardrails) — Hard constraints and decision rules
