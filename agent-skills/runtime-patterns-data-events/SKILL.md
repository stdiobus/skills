---
name: runtime-patterns-data-events
description: >
  Canonical copy-pastable templates for data-driven event patterns with
  @worktif/runtime. Covers S3 object triggers with prefix/suffix filters and
  batch event processing, and DynamoDB Streams processors with NewImage/OldImage
  access and partial failure reporting. Use this skill when implementing Lambda
  functions that react to file uploads in S3 or changes in DynamoDB tables.
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

This skill provides canonical templates for implementing Lambda functions that
react to data changes in AWS storage services. S3 triggers fire when objects are
created, modified, or deleted. DynamoDB Streams triggers fire when items in a
table are inserted, updated, or removed.

## When to Use

- When a consumer asks to "process files uploaded to S3"
- When a consumer asks to "react to database changes"
- When implementing image processing, file validation, or ETL on S3 uploads
- When implementing change data capture (CDC) from DynamoDB
- When synchronizing data between DynamoDB and another store
- When building audit logs from DynamoDB table changes

## Instructions

### Mapping Consumer Requests to Templates

| Consumer Request | Template |
|-----------------|----------|
| "Process uploaded files" / "S3 trigger" | `references/templates/s3-trigger.ts` |
| "React to database changes" / "DynamoDB stream" | `references/templates/dynamodb-stream.ts` |
| "Image processing on upload" | Adapt from `s3-trigger.ts` |
| "Sync data between tables" | Adapt from `dynamodb-stream.ts` |

### S3 Event Processing

S3 notifications deliver events in batches. Each record contains:
- `s3.bucket.name` — The bucket name
- `s3.object.key` — The object key (URL-encoded)
- `s3.object.size` — Object size in bytes
- `eventName` — The event type (e.g., `ObjectCreated:Put`)

Always iterate over `event.Records` — never assume a single record.

### DynamoDB Stream Event Processing

DynamoDB Streams deliver change records with:
- `eventName` — `INSERT`, `MODIFY`, or `REMOVE`
- `dynamodb.NewImage` — The item after the change (present for INSERT and MODIFY)
- `dynamodb.OldImage` — The item before the change (present for MODIFY and REMOVE)
- `dynamodb.Keys` — The primary key of the changed item

`NewImage` and `OldImage` use DynamoDB's AttributeValue format (marshalled).

### Partial Failure Reporting (DynamoDB Streams)

When `reportBatchItemFailures: true` is set, return failed record sequence numbers:

```typescript
return {
  batchItemFailures: failedIds.map(id => ({ itemIdentifier: id })),
};
```

## Common Mistakes

### ❌ WRONG: Assuming S3 event always contains a single record

```typescript
// ❌ S3 can deliver multiple records in one invocation
handler: async (event, context) => {
  const record = event.Records[0];  // ❌ Only first record
  const key = record.s3.object.key;
  await processFile(key);
}
```

### ✅ CORRECT: Processing all records in the batch

```typescript
handler: async (event, context) => {
  for (const record of event.Records) {  // ✅ All records
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    await processFile(record.s3.bucket.name, key);
  }
}
```

### ❌ WRONG: Assuming DynamoDB NewImage is always present

```typescript
// ❌ NewImage is NOT present for REMOVE events
handler: async (event, context) => {
  for (const record of event.Records) {
    const item = record.dynamodb.NewImage;  // ❌ Undefined for REMOVE
    await syncItem(item);
  }
}
```

### ✅ CORRECT: Checking eventName before accessing NewImage/OldImage

```typescript
handler: async (event, context) => {
  for (const record of event.Records) {
    switch (record.eventName) {
      case 'INSERT':
      case 'MODIFY':
        // NewImage is present for INSERT and MODIFY
        if (record.dynamodb?.NewImage) {
          await syncItem(record.dynamodb.NewImage);
        }
        break;
      case 'REMOVE':
        // Only OldImage is present for REMOVE
        if (record.dynamodb?.OldImage) {
          await removeItem(record.dynamodb.OldImage);
        }
        break;
    }
  }
}
```

### ❌ WRONG: Not URL-decoding S3 object keys

```typescript
// ❌ S3 object keys are URL-encoded (spaces become '+', special chars encoded)
handler: async (event, context) => {
  for (const record of event.Records) {
    const key = record.s3.object.key;  // ❌ May contain '+' instead of spaces
    await processFile(key);
  }
}
```

### ✅ CORRECT: Decoding the object key

```typescript
handler: async (event, context) => {
  for (const record of event.Records) {
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));  // ✅
    await processFile(record.s3.bucket.name, key);
  }
}
```

### ❌ WRONG: Missing startingPosition for DynamoDB Streams

```typescript
// ❌ startingPosition is required
dynamodb: {
  table: 'users-table',
  batchSize: 100,
  // Missing: startingPosition
}
```

### ✅ CORRECT: Specifying startingPosition

```typescript
dynamodb: {
  table: 'users-table',
  batchSize: 100,
  startingPosition: 'LATEST',  // ✅ 'TRIM_HORIZON' or 'LATEST'
  reportBatchItemFailures: true,
}
```

## References

- [S3 Trigger Template](references/templates/s3-trigger.ts) — S3 object notification with prefix/suffix filters
- [DynamoDB Stream Template](references/templates/dynamodb-stream.ts) — DynamoDB Streams with NewImage/OldImage
- [Common Mistakes](references/common-mistakes.md) — Comprehensive ❌/✅ pairs for data event patterns
- [runtime-api-integrations](../runtime-api-integrations/SKILL.md) (Layer 2: API) — S3Integration and DynamoDbStreamIntegration configs
- [runtime-api-core](../runtime-api-core/SKILL.md) (Layer 2: API) — LambdaDefinition type signatures
- [runtime-concepts](../runtime-concepts/SKILL.md) (Layer 1: Concepts) — Domain model and integration kinds
- [runtime-constraints-and-guardrails](../runtime-constraints-and-guardrails/SKILL.md) (Layer 4: Guardrails) — Hard constraints
