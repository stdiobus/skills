# Integration Configs Reference

Per-integration field reference with valid value ranges, defaults, and CDK construct
vs string options. All field names and types match the actual `@worktif/runtime` API.

---

## HttpIntegration

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `method` | `HttpMethod` | Yes | — | HTTP method: `'GET'`, `'POST'`, `'PUT'`, `'PATCH'`, `'DELETE'`, `'OPTIONS'` |
| `path` | `string` | Yes | — | URL path. Use `{param}` for dynamic segments. |
| `auth` | `AuthType \| AuthConfig` | No | `'none'` | Authentication configuration |
| `cors` | `boolean` | No | `true` | Enable CORS |
| `corsConfig` | `CorsConfig` | No | — | Detailed CORS settings (requires `cors: true`) |

**Path parameter syntax:**
- Static: `/api/users`
- Single param: `/api/users/{id}`
- Multiple params: `/api/users/{userId}/orders/{orderId}`
- Greedy: `/api/proxy/{proxy+}` (captures all remaining path segments)

**Auth convenience strings** (`AuthType`):
- `'none'` — No authentication (public endpoint)
- `'jwt'` — JWT validation (requires full `AuthConfig` for issuer)
- `'iam'` — AWS IAM signature validation
- `'cognito'` — Cognito User Pool authorizer
- `'custom'` — Custom Lambda authorizer

---

## SqsIntegration

| Field | Type | Required | Default | Valid Range | Description |
|-------|------|----------|---------|-------------|-------------|
| `queue` | `IQueue \| string` | Yes | — | — | SQS queue reference |
| `batchSize` | `number` | No | `10` | 1–10000 | Records per batch |
| `maxBatchingWindowSeconds` | `number` | No | `0` | 0–300 | Max wait time for batch |
| `reportBatchItemFailures` | `boolean` | No | `false` | — | Enable partial failure reporting |
| `enabled` | `boolean` | No | `true` | — | Enable/disable event source mapping |

**CDK construct:** `IQueue` from `aws-cdk-lib/aws-sqs`
**String format:** Queue ARN (`arn:aws:sqs:{region}:{account}:{queue-name}`)

**Partial failure reporting:**
When `reportBatchItemFailures: true`, the handler must return `{ batchItemFailures: [{ itemIdentifier: messageId }] }`
for failed records. Successfully processed records are removed from the queue; failed records are retried.

---

## EventBridgeIntegration

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `eventBus` | `IEventBus \| string` | No | Default event bus | Event bus reference |
| `eventPattern` | `object` | Yes | — | Event pattern to match |
| `eventPattern.source` | `string[]` | No | — | Event source filter |
| `eventPattern.detailType` | `string[]` | No | — | Detail type filter |
| `eventPattern.detail` | `Record<string, unknown>` | No | — | Detail content filter |
| `description` | `string` | No | — | Rule description |

**CDK construct:** `IEventBus` from `aws-cdk-lib/aws-events`
**String format:** Event bus ARN or name

**Event pattern matching:**
- At least one field in `eventPattern` should be specified
- Multiple values in an array use OR logic
- Multiple fields use AND logic

---

## S3Integration

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `bucket` | `IBucket \| string` | Yes | — | S3 bucket reference |
| `events` | `string[]` | Yes | — | S3 event types to listen for |
| `prefix` | `string` | No | — | Key prefix filter |
| `suffix` | `string` | No | — | Key suffix filter |

**CDK construct:** `IBucket` from `aws-cdk-lib/aws-s3`
**String format:** Bucket name (not ARN)

**Common S3 event types:**
- `'s3:ObjectCreated:*'` — Any object creation (Put, Post, Copy, CompleteMultipartUpload)
- `'s3:ObjectCreated:Put'` — Object created via PUT
- `'s3:ObjectRemoved:*'` — Any object deletion
- `'s3:ObjectRemoved:Delete'` — Object deleted
- `'s3:ObjectRestore:*'` — Object restore from Glacier

**Filter examples:**
- `prefix: 'uploads/'` — Only objects in the uploads/ folder
- `suffix: '.jpg'` — Only JPEG files
- Both can be combined: `prefix: 'images/', suffix: '.png'`

---

## DynamoDbStreamIntegration

| Field | Type | Required | Default | Valid Range | Description |
|-------|------|----------|---------|-------------|-------------|
| `table` | `ITable \| string` | Yes | — | — | DynamoDB table reference |
| `startingPosition` | `'TRIM_HORIZON' \| 'LATEST'` | Yes | — | — | Stream starting position |
| `batchSize` | `number` | No | `100` | 1–10000 | Records per batch |
| `maxBatchingWindowSeconds` | `number` | No | `0` | 0–300 | Max wait time for batch |
| `reportBatchItemFailures` | `boolean` | No | `false` | — | Partial failure reporting |

**CDK construct:** `ITable` from `aws-cdk-lib/aws-dynamodb`
**String format:** Table name or table ARN

**Starting position:**
- `'TRIM_HORIZON'` — Process all existing records in the stream, then new records
- `'LATEST'` — Process only new records added after the event source mapping is created

**Prerequisite:** The DynamoDB table must have streams enabled (`StreamViewType` set to
`NEW_IMAGE`, `OLD_IMAGE`, `NEW_AND_OLD_IMAGES`, or `KEYS_ONLY`).

---

## SnsIntegration

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `topic` | `ITopic \| string` | Yes | — | SNS topic reference |
| `filterPolicy` | `Record<string, unknown>` | No | — | Subscription filter policy |
| `rawMessageDelivery` | `boolean` | No | `false` | Raw message delivery |

**CDK construct:** `ITopic` from `aws-cdk-lib/aws-sns`
**String format:** Topic ARN (`arn:aws:sns:{region}:{account}:{topic-name}`)

**Filter policy:**
Filters messages based on message attributes. Only messages matching the filter
are delivered to the Lambda function.

```typescript
filterPolicy: {
  severity: ['critical', 'high'],  // Match messages with severity = critical OR high
  environment: ['production'],     // AND environment = production
}
```

**Raw message delivery:**
When `true`, the SNS message body is delivered directly without the SNS envelope.
When `false` (default), the full SNS message envelope is delivered.

---

## KinesisIntegration

| Field | Type | Required | Default | Valid Range | Description |
|-------|------|----------|---------|-------------|-------------|
| `stream` | `IStream \| string` | Yes | — | — | Kinesis stream reference |
| `startingPosition` | `'TRIM_HORIZON' \| 'LATEST'` | Yes | — | — | Stream starting position |
| `batchSize` | `number` | No | `100` | 1–10000 | Records per batch |
| `maxBatchingWindowSeconds` | `number` | No | `0` | 0–300 | Max wait time for batch |

**CDK construct:** `IStream` from `aws-cdk-lib/aws-kinesis`
**String format:** Stream ARN (`arn:aws:kinesis:{region}:{account}:stream/{stream-name}`)

**Starting position:**
- `'TRIM_HORIZON'` — Process all records from the beginning of the shard
- `'LATEST'` — Process only new records written after the mapping is created

---

## ScheduleIntegration

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `schedule` | `string` | Yes | — | Cron or rate expression |
| `description` | `string` | No | — | Rule description |
| `enabled` | `boolean` | No | `true` | Enable/disable schedule |

**Rate expressions:**
- `'rate(1 minute)'` — Every minute (singular for 1)
- `'rate(5 minutes)'` — Every 5 minutes
- `'rate(1 hour)'` — Every hour
- `'rate(12 hours)'` — Every 12 hours
- `'rate(1 day)'` — Every day
- `'rate(7 days)'` — Every 7 days

**Cron expressions** (6 fields: minute hour day-of-month month day-of-week year):
- `'cron(0 12 * * ? *)'` — Noon UTC every day
- `'cron(0 0 1 * ? *)'` — Midnight UTC on the 1st of every month
- `'cron(0/15 * * * ? *)'` — Every 15 minutes
- `'cron(0 8 ? * MON-FRI *)'` — 8 AM UTC weekdays

**Cron field values:**
| Field | Values | Wildcards |
|-------|--------|-----------|
| Minute | 0–59 | `,` `-` `*` `/` |
| Hour | 0–23 | `,` `-` `*` `/` |
| Day-of-month | 1–31 | `,` `-` `*` `/` `?` `L` `W` |
| Month | 1–12 or JAN–DEC | `,` `-` `*` `/` |
| Day-of-week | 1–7 or SUN–SAT | `,` `-` `*` `/` `?` `L` `#` |
| Year | 1970–2199 | `,` `-` `*` `/` |

---

## Direct Integration

The `'direct'` integration kind has NO configuration property. It represents Lambda
functions invoked programmatically via the AWS SDK `Invoke` API.

**Characteristics:**
- No event source mapping is created
- No API Gateway route is created
- The handler receives an arbitrary payload (typed as `any`)
- Useful for internal service-to-service calls

**Usage:**
```typescript
const internalHandler: LambdaDefinition<MyTies, {}, 'direct'> = {
  id: 'process-internal',
  ties: { processingService: ProcessingService },
  handler: async (event, context) => {
    // event is typed as 'any' — parse the payload yourself
    const payload = event as { action: string; data: unknown };
    await event.ties.processingService.process(payload);
    return { success: true };
  },
  // No integration config property needed
};
```

---

## AuthConfig Detailed Reference

### AuthConfigNone

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'none'` | Yes | Discriminant — public endpoint |

### AuthConfigIam

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'iam'` | Yes | Discriminant — IAM signature validation |
| `name` | `string` | No | Authorizer name |

### AuthConfigJwt

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | `'jwt'` | Yes | — | Discriminant |
| `name` | `string` | No | — | Authorizer name |
| `issuer` | `string` | Yes | — | JWT issuer URL (HTTPS) |
| `audience` | `string[]` | No | — | Allowed audience values |
| `identitySource` | `string[]` | No | `['$request.header.Authorization']` | Token location |

### AuthConfigCognito

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | `'cognito'` | Yes | — | Discriminant |
| `name` | `string` | No | — | Authorizer name |
| `userPoolId` | `string` | No* | — | Cognito User Pool ID |
| `region` | `string` | No* | — | AWS region for User Pool |
| `issuer` | `string` | No* | — | Explicit issuer URL |
| `userPoolClientIds` | `string[]` | No | — | App Client IDs |
| `audience` | `string[]` | No | — | Explicit audience values |

*Provide either `userPoolId` + `region` OR `issuer`. The framework derives the issuer
from `https://cognito-idp.{region}.amazonaws.com/{userPoolId}`.

### AuthConfigCustom

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | `'custom'` | Yes | — | Discriminant |
| `name` | `string` | No | — | Authorizer name |
| `authorizerLambda` | `lambda.IFunction` | Yes | — | Lambda function for auth |
| `identitySource` | `string[]` | No | `['$request.header.Authorization']` | Request elements |
| `enableSimpleResponses` | `boolean` | No | `false` | Allow boolean responses |
| `resultsCacheTtl` | `Duration` | No | — | Cache TTL for decisions |
| `payloadVersion` | `'2.0'` | No | `'2.0'` | Payload format version |

---

## CorsConfig Detailed Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `allowOrigins` | `string[]` | No | `['*']` in dev | Allowed origins |
| `allowMethods` | `HttpMethod[] \| ['*']` | No | All registered methods | Allowed methods |
| `allowHeaders` | `string[]` | No | `['Content-Type', 'Authorization', 'X-Requested-With']` | Allowed headers |
| `allowCredentials` | `boolean` | No | `false` | Allow credentials |
| `maxAge` | `number` | No | `86400` (24h) | Preflight cache seconds |
| `exposeHeaders` | `string[]` | No | `[]` | Headers exposed to client |

**Constraint:** `allowCredentials: true` cannot be used with `allowOrigins: ['*']`.
Use specific origin domains when credentials are required.

---

## LambdaConfig Reference

Per-Lambda configuration overrides (applies to any integration kind):

| Field | Type | Required | Default | Valid Range | Description |
|-------|------|----------|---------|-------------|-------------|
| `memorySize` | `number` | No | Global default | 128–10240 MB | Memory allocation |
| `timeout` | `number` | No | Global default | 1–900 seconds | Function timeout |
| `environment` | `Record<string, string>` | No | `{}` | — | Additional env vars |

**Memory/timeout interaction:** Higher memory also increases CPU allocation proportionally.
For CPU-intensive tasks, increase memory even if the function does not need the RAM.

**Environment variables:** Merged with global environment variables from InfraOptions.
Lambda-specific variables take precedence over global ones with the same key.
