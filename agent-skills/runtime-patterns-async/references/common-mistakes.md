# Common Mistakes: Async Patterns

Comprehensive ❌/✅ pairs for asynchronous event-driven Lambda implementation with `@worktif/runtime`.

## SQS: Delivery Semantics

### ❌ WRONG: Assuming exactly-once delivery

```typescript
// ❌ SQS standard queues provide at-least-once delivery
// The same message may be delivered more than once
handler: async (event, context) => {
  for (const record of event.Records) {
    const order = JSON.parse(record.body);
    await chargeCustomer(order);  // ❌ May charge twice on redelivery
  }
}
```

### ✅ CORRECT: Implementing idempotent processing

```typescript
handler: async (event, context) => {
  for (const record of event.Records) {
    const order = JSON.parse(record.body);
    // ✅ Idempotency check prevents duplicate processing
    if (await isAlreadyProcessed(order.orderId)) {
      continue;
    }
    await chargeCustomer(order);
    await markAsProcessed(order.orderId);
  }
}
```

## SQS: Batch Processing

### ❌ WRONG: Processing only the first record

```typescript
// ❌ SQS delivers batches — ignoring other records loses messages
handler: async (event, context) => {
  const record = event.Records[0];
  await processMessage(JSON.parse(record.body));
}
```

### ✅ CORRECT: Processing all records in the batch

```typescript
handler: async (event, context) => {
  for (const record of event.Records) {
    await processMessage(JSON.parse(record.body));
  }
}
```

## SQS: Partial Failure Reporting

### ❌ WRONG: Throwing on first failure (retries entire batch)

```typescript
// ❌ One failure causes ALL messages to be retried
handler: async (event, context) => {
  for (const record of event.Records) {
    await processMessage(record);  // Throws on failure → entire batch retries
  }
}
```

### ✅ CORRECT: Collecting failures and returning batchItemFailures

```typescript
handler: async (event, context) => {
  const failures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      await processMessage(record);
    } catch (error) {
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };  // ✅ Only failed messages retry
}
```

### ❌ WRONG: Returning failures without enabling reportBatchItemFailures

```typescript
// ❌ Without reportBatchItemFailures: true, the return value is ignored
const handler: LambdaDefinition<MyTies, {}, 'sqs'> = {
  ties: { service: MyService },
  handler: async (event, context) => {
    return { batchItemFailures: [{ itemIdentifier: 'msg-1' }] };
  },
  sqs: {
    queue: 'my-queue',
    batchSize: 10,
    // Missing: reportBatchItemFailures: true
  },
};
```

### ✅ CORRECT: Enabling reportBatchItemFailures in the integration config

```typescript
const handler: LambdaDefinition<MyTies, {}, 'sqs'> = {
  ties: { service: MyService },
  handler: async (event, context) => {
    return { batchItemFailures: [{ itemIdentifier: 'msg-1' }] };
  },
  sqs: {
    queue: 'my-queue',
    batchSize: 10,
    reportBatchItemFailures: true,  // ✅ Required for partial failures
  },
};
```

## EventBridge: Event Pattern

### ❌ WRONG: Using string instead of array for source/detailType

```typescript
// ❌ source and detailType must be arrays
eventbridge: {
  eventPattern: {
    source: 'myapp.orders',           // ❌ Must be string[]
    detailType: 'OrderCreated',       // ❌ Must be string[]
  },
}
```

### ✅ CORRECT: Using arrays for pattern matching fields

```typescript
eventbridge: {
  eventPattern: {
    source: ['myapp.orders'],          // ✅ Array of strings
    detailType: ['OrderCreated'],      // ✅ Array of strings
  },
}
```

## EventBridge: Accessing Event Detail

### ❌ WRONG: Accessing event.body (HTTP pattern in EventBridge handler)

```typescript
// ❌ EventBridge events do not have a body property
handler: async (event, context) => {
  const data = JSON.parse(event.body);  // ❌ body does not exist on EventBridgeEvent
}
```

### ✅ CORRECT: Accessing event.detail

```typescript
handler: async (event, context) => {
  const data = event.detail;  // ✅ EventBridge event payload is in detail
}
```

## Kinesis: Data Decoding

### ❌ WRONG: Reading Kinesis data directly as string

```typescript
// ❌ Kinesis data is base64-encoded
handler: async (event, context) => {
  for (const record of event.Records) {
    const data = record.kinesis.data;  // ❌ This is base64, not readable JSON
    const payload = JSON.parse(data);  // ❌ Will fail or produce garbage
  }
}
```

### ✅ CORRECT: Decoding base64 before parsing

```typescript
handler: async (event, context) => {
  for (const record of event.Records) {
    const data = Buffer.from(record.kinesis.data, 'base64').toString('utf-8');  // ✅
    const payload = JSON.parse(data);
  }
}
```

## Kinesis: Missing startingPosition

### ❌ WRONG: Omitting required startingPosition

```typescript
kinesis: {
  stream: 'my-stream',
  batchSize: 100,
  // ❌ Missing startingPosition — required field
}
```

### ✅ CORRECT: Specifying startingPosition

```typescript
kinesis: {
  stream: 'my-stream',
  batchSize: 100,
  startingPosition: 'LATEST',  // ✅ 'TRIM_HORIZON' or 'LATEST'
}
```

## Schedule: Expression Format

### ❌ WRONG: Using invalid schedule expression syntax

```typescript
// ❌ Missing parentheses and unit
schedule: { schedule: '5 minutes' }

// ❌ Wrong cron format (missing year field)
schedule: { schedule: 'cron(0 12 * * *)' }
```

### ✅ CORRECT: Using valid rate or cron expressions

```typescript
// ✅ Rate expression
schedule: { schedule: 'rate(5 minutes)' }

// ✅ Cron expression (6 fields: min hour dom month dow year)
schedule: { schedule: 'cron(0 12 * * ? *)' }
```

## Integration Property Mismatch

### ❌ WRONG: Using http property for async handlers

```typescript
// ❌ SQS handlers do NOT have HTTP routes
const handler: LambdaDefinition<MyTies, {}, 'sqs'> = {
  ties: { service: MyService },
  handler: async (event, context) => { /* ... */ },
  http: { method: 'POST', path: '/process' },  // ❌ Wrong property
  sqs: { queue: 'my-queue' },
};
```

### ✅ CORRECT: Using only the matching integration property

```typescript
const handler: LambdaDefinition<MyTies, {}, 'sqs'> = {
  ties: { service: MyService },
  handler: async (event, context) => { /* ... */ },
  sqs: { queue: 'my-queue', batchSize: 10 },  // ✅ Only sqs property
};
```

## Generic Type Parameter

### ❌ WRONG: Omitting the TIntegration generic for async handlers

```typescript
// ❌ Without the third generic, event is typed as APIGatewayProxyEvent
const handler: LambdaDefinition<MyTies> = {
  ties: { service: MyService },
  handler: async (event, context) => {
    event.Records;  // ❌ TypeScript error — APIGatewayProxyEvent has no Records
  },
  sqs: { queue: 'my-queue' },
};
```

### ✅ CORRECT: Specifying the integration kind generic

```typescript
// ✅ Third generic 'sqs' types event as SQSEvent
const handler: LambdaDefinition<MyTies, {}, 'sqs'> = {
  ties: { service: MyService },
  handler: async (event, context) => {
    event.Records;  // ✅ Typed as SQSRecord[]
  },
  sqs: { queue: 'my-queue' },
};
```

## SNS: Filter Policy

### ❌ WRONG: Using string values in filter policy

```typescript
// ❌ Filter policy values must be arrays
sns: {
  topic: 'my-topic',
  filterPolicy: {
    severity: 'critical',  // ❌ Must be an array
  },
}
```

### ✅ CORRECT: Using arrays in filter policy

```typescript
sns: {
  topic: 'my-topic',
  filterPolicy: {
    severity: ['critical', 'high'],  // ✅ Array of allowed values
  },
}
```
