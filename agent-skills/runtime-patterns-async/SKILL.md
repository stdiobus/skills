---
name: runtime-patterns-async
description: >
  Canonical copy-pastable templates for asynchronous event-driven patterns with
  @worktif/runtime. Covers SQS queue workers with batch processing and partial
  failure reporting, EventBridge fanout with event pattern matching, SNS pub/sub
  with filter policies, Kinesis stream processing, and scheduled tasks with cron
  and rate expressions. Use this skill when implementing any non-HTTP Lambda
  trigger that processes events from AWS messaging services.
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

This skill provides canonical templates for implementing asynchronous event-driven
Lambda functions with `@worktif/runtime`. Each template demonstrates the correct
integration configuration, batch event processing, and error handling patterns
for AWS messaging services.

## When to Use

- When implementing an SQS queue consumer (worker pattern)
- When implementing EventBridge event consumers or producers (fanout pattern)
- When implementing SNS topic subscribers (pub/sub pattern)
- When implementing Kinesis stream processors (real-time analytics)
- When implementing scheduled tasks (cron jobs, periodic cleanup)
- When configuring batch processing with partial failure reporting
- When setting up event pattern matching or filter policies

## Instructions

### Mapping Consumer Requests to Templates

| Consumer Request | Template |
|-----------------|----------|
| "Process messages from a queue" | `references/templates/sqs-worker.ts` |
| "React to events" / "Event-driven" | `references/templates/eventbridge-fanout.ts` |
| "Publish/subscribe" / "Notifications" | `references/templates/sns-pubsub.ts` |
| "Process a stream" / "Real-time data" | `references/templates/kinesis-processor.ts` |
| "Run on a schedule" / "Cron job" | `references/templates/scheduled-task.ts` |

### Key Differences from HTTP Handlers

1. **No `http` property** — async handlers use `sqs`, `eventbridge`, `sns`, `kinesis`, or `schedule` instead
2. **Batch events** — most async integrations deliver multiple records per invocation
3. **No HTTP response** — return value semantics differ per integration type
4. **Partial failure reporting** — SQS and DynamoDB support reporting which records failed

### Batch Processing Pattern

Most async integrations deliver events in batches. Always iterate over records:

```typescript
handler: async (event, context) => {
  for (const record of event.Records) {
    // Process each record individually
  }
}
```

### Partial Failure Reporting (SQS)

When `reportBatchItemFailures: true` is set, return failed message IDs:

```typescript
return {
  batchItemFailures: failedIds.map(id => ({ itemIdentifier: id })),
};
```

This tells Lambda to retry only the failed messages instead of the entire batch.

### Schedule Expressions

Two formats are supported:

- **Rate**: `rate(5 minutes)`, `rate(1 hour)`, `rate(7 days)`
- **Cron**: `cron(0 12 * * ? *)` (noon UTC daily), `cron(0/15 * * * ? *)` (every 15 min)

Cron format: `cron(minutes hours day-of-month month day-of-week year)`

## Common Mistakes

### ❌ WRONG: Assuming exactly-once delivery for SQS

```typescript
// ❌ SQS standard queues provide at-least-once delivery
// The same message may be delivered more than once
handler: async (event, context) => {
  for (const record of event.Records) {
    // No idempotency check — duplicate processing possible
    await processOrder(JSON.parse(record.body));
  }
}
```

### ✅ CORRECT: Implementing idempotent processing

```typescript
handler: async (event, context) => {
  for (const record of event.Records) {
    const order = JSON.parse(record.body);
    // ✅ Check if already processed (idempotency key)
    if (await isAlreadyProcessed(order.orderId)) {
      continue;
    }
    await processOrder(order);
    await markAsProcessed(order.orderId);
  }
}
```

### ❌ WRONG: Processing only the first record

```typescript
// ❌ SQS delivers batches — ignoring other records loses messages
handler: async (event, context) => {
  const record = event.Records[0];  // ❌ Only first record
  await processMessage(JSON.parse(record.body));
}
```

### ✅ CORRECT: Processing all records in the batch

```typescript
handler: async (event, context) => {
  for (const record of event.Records) {  // ✅ All records
    await processMessage(JSON.parse(record.body));
  }
}
```

### ❌ WRONG: Missing reportBatchItemFailures for partial failure handling

```typescript
// ❌ Without reportBatchItemFailures, one failure retries the ENTIRE batch
const handler: LambdaDefinition<MyTies, {}, 'sqs'> = {
  ties: { orderService: OrderService },
  handler: async (event, context) => {
    for (const record of event.Records) {
      await processRecord(record);  // If one fails, all retry
    }
  },
  sqs: {
    queue: 'orders-queue',
    batchSize: 10,
    // Missing: reportBatchItemFailures: true
  },
};
```

### ✅ CORRECT: Enabling partial failure reporting

```typescript
const handler: LambdaDefinition<MyTies, {}, 'sqs'> = {
  ties: { orderService: OrderService },
  handler: async (event, context) => {
    const failures: { itemIdentifier: string }[] = [];

    for (const record of event.Records) {
      try {
        await processRecord(record);
      } catch (error) {
        failures.push({ itemIdentifier: record.messageId });
      }
    }

    return { batchItemFailures: failures };  // ✅ Only failed records retry
  },
  sqs: {
    queue: 'orders-queue',
    batchSize: 10,
    reportBatchItemFailures: true,  // ✅ Enable partial failures
  },
};
```

### ❌ WRONG: Using http property for async handlers

```typescript
// ❌ SQS handlers do NOT have http routes
const handler: LambdaDefinition<MyTies, {}, 'sqs'> = {
  ties: { orderService: OrderService },
  handler: async (event, context) => { /* ... */ },
  http: { method: 'POST', path: '/process' },  // ❌ Wrong integration
  sqs: { queue: 'orders-queue' },
};
```

### ✅ CORRECT: Using only the appropriate integration property

```typescript
const handler: LambdaDefinition<MyTies, {}, 'sqs'> = {
  ties: { orderService: OrderService },
  handler: async (event, context) => { /* ... */ },
  sqs: { queue: 'orders-queue', batchSize: 10 },  // ✅ Only sqs property
};
```

### ❌ WRONG: Forgetting to set startingPosition for stream-based integrations

```typescript
// ❌ Kinesis requires startingPosition
const handler: LambdaDefinition<MyTies, {}, 'kinesis'> = {
  ties: { analyticsService: AnalyticsService },
  handler: async (event, context) => { /* ... */ },
  kinesis: {
    stream: 'click-stream',
    batchSize: 100,
    // Missing: startingPosition
  },
};
```

### ✅ CORRECT: Setting startingPosition

```typescript
const handler: LambdaDefinition<MyTies, {}, 'kinesis'> = {
  ties: { analyticsService: AnalyticsService },
  handler: async (event, context) => { /* ... */ },
  kinesis: {
    stream: 'click-stream',
    batchSize: 100,
    startingPosition: 'LATEST',  // ✅ Required field
  },
};
```

## References

- [SQS Worker Template](references/templates/sqs-worker.ts) — Batch processing with partial failure reporting
- [EventBridge Fanout Template](references/templates/eventbridge-fanout.ts) — Event pattern matching
- [SNS Pub/Sub Template](references/templates/sns-pubsub.ts) — Topic subscription with filter policy
- [Kinesis Processor Template](references/templates/kinesis-processor.ts) — Stream processing
- [Scheduled Task Template](references/templates/scheduled-task.ts) — Cron and rate expressions
- [Common Mistakes](references/common-mistakes.md) — Comprehensive ❌/✅ pairs for async patterns
- [runtime-api-integrations](../runtime-api-integrations/SKILL.md) (Layer 2: API) — Integration configuration interfaces
- [runtime-api-core](../runtime-api-core/SKILL.md) (Layer 2: API) — LambdaDefinition type signatures
- [runtime-concepts](../runtime-concepts/SKILL.md) (Layer 1: Concepts) — Domain model and integration kinds
- [runtime-constraints-and-guardrails](../runtime-constraints-and-guardrails/SKILL.md) (Layer 4: Guardrails) — Hard constraints
