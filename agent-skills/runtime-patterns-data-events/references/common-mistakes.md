# Common Mistakes: Data Event Patterns

Comprehensive ❌/✅ pairs for S3 trigger and DynamoDB Stream implementation with `@worktif/runtime`.

## S3: Single Record Assumption

### ❌ WRONG: Assuming S3 event always contains a single record

```typescript
// ❌ S3 can deliver multiple records in one invocation
handler: async (event, context) => {
  const record = event.Records[0];
  const key = record.s3.object.key;
  await processFile(key);
}
```

### ✅ CORRECT: Iterating over all records

```typescript
handler: async (event, context) => {
  for (const record of event.Records) {
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    await processFile(record.s3.bucket.name, key);
  }
}
```

## S3: Object Key Encoding

### ❌ WRONG: Using the raw object key without decoding

```typescript
// ❌ S3 object keys are URL-encoded (spaces → '+', special chars → %XX)
handler: async (event, context) => {
  for (const record of event.Records) {
    const key = record.s3.object.key;  // ❌ 'my+file+name.jpg' instead of 'my file name.jpg'
    await processFile(key);
  }
}
```

### ✅ CORRECT: Decoding the object key

```typescript
handler: async (event, context) => {
  for (const record of event.Records) {
    // ✅ Replace '+' with spaces, then decode percent-encoded characters
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    await processFile(record.s3.bucket.name, key);
  }
}
```

## S3: Event Type Filtering

### ❌ WRONG: Not checking the event type when listening to multiple events

```typescript
// ❌ If listening to both Created and Removed, must differentiate
s3: {
  bucket: 'my-bucket',
  events: ['s3:ObjectCreated:*', 's3:ObjectRemoved:*'],
}

handler: async (event, context) => {
  for (const record of event.Records) {
    await processUpload(record);  // ❌ Also called for deletions
  }
}
```

### ✅ CORRECT: Checking eventName to differentiate

```typescript
handler: async (event, context) => {
  for (const record of event.Records) {
    if (record.eventName.startsWith('ObjectCreated')) {
      await processUpload(record);  // ✅ Only for uploads
    } else if (record.eventName.startsWith('ObjectRemoved')) {
      await handleDeletion(record);  // ✅ Only for deletions
    }
  }
}
```

## DynamoDB: NewImage Availability

### ❌ WRONG: Assuming NewImage is always present

```typescript
// ❌ NewImage is NOT present for REMOVE events
handler: async (event, context) => {
  for (const record of event.Records) {
    const item = record.dynamodb.NewImage;  // ❌ Undefined for REMOVE
    await syncItem(item.userId.S);          // ❌ Runtime error
  }
}
```

### ✅ CORRECT: Checking eventName and guarding access

```typescript
handler: async (event, context) => {
  for (const record of event.Records) {
    const eventName = record.eventName;

    if (eventName === 'INSERT' || eventName === 'MODIFY') {
      // ✅ NewImage is present for INSERT and MODIFY
      const newImage = record.dynamodb?.NewImage;
      if (newImage) {
        await syncItem(newImage);
      }
    } else if (eventName === 'REMOVE') {
      // ✅ Only OldImage is present for REMOVE
      const oldImage = record.dynamodb?.OldImage;
      if (oldImage) {
        await removeItem(oldImage);
      }
    }
  }
}
```

## DynamoDB: OldImage Availability

### ❌ WRONG: Assuming OldImage is always present

```typescript
// ❌ OldImage is NOT present for INSERT events
handler: async (event, context) => {
  for (const record of event.Records) {
    const oldItem = record.dynamodb.OldImage;  // ❌ Undefined for INSERT
    const newItem = record.dynamodb.NewImage;
    await computeDiff(oldItem, newItem);       // ❌ Runtime error
  }
}
```

### ✅ CORRECT: Handling each event type appropriately

```typescript
handler: async (event, context) => {
  for (const record of event.Records) {
    const newImage = record.dynamodb?.NewImage;
    const oldImage = record.dynamodb?.OldImage;

    switch (record.eventName) {
      case 'INSERT':
        // Only NewImage available
        if (newImage) await handleInsert(newImage);
        break;
      case 'MODIFY':
        // Both available — can compute diff
        if (newImage && oldImage) await handleModify(oldImage, newImage);
        break;
      case 'REMOVE':
        // Only OldImage available
        if (oldImage) await handleRemove(oldImage);
        break;
    }
  }
}
```

## DynamoDB: AttributeValue Format

### ❌ WRONG: Treating DynamoDB items as plain objects

```typescript
// ❌ DynamoDB stream records use AttributeValue format (marshalled)
handler: async (event, context) => {
  for (const record of event.Records) {
    const item = record.dynamodb?.NewImage;
    const name = item.name;  // ❌ This is { S: 'John' }, not 'John'
  }
}
```

### ✅ CORRECT: Accessing values through AttributeValue type descriptors

```typescript
import { unmarshall } from '@aws-sdk/util-dynamodb';

handler: async (event, context) => {
  for (const record of event.Records) {
    const item = record.dynamodb?.NewImage;
    if (item) {
      // Option 1: Access directly via type descriptors
      const name = item.name?.S;  // ✅ String value
      const age = item.age?.N;    // ✅ Number (as string)

      // Option 2: Unmarshall to plain object
      const plainItem = unmarshall(item as Record<string, any>);
      const userName = plainItem.name;  // ✅ Plain string
    }
  }
}
```

## DynamoDB: Missing startingPosition

### ❌ WRONG: Omitting required startingPosition

```typescript
dynamodb: {
  table: 'users-table',
  batchSize: 100,
  // ❌ Missing startingPosition — required field
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

## DynamoDB: Partial Failure Reporting

### ❌ WRONG: Using messageId for DynamoDB failure reporting

```typescript
// ❌ DynamoDB uses SequenceNumber, not messageId
handler: async (event, context) => {
  const failures = [];
  for (const record of event.Records) {
    try { await process(record); }
    catch { failures.push({ itemIdentifier: record.messageId }); }  // ❌ Wrong field
  }
  return { batchItemFailures: failures };
}
```

### ✅ CORRECT: Using SequenceNumber for DynamoDB failure reporting

```typescript
handler: async (event, context) => {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try { await process(record); }
    catch {
      if (record.dynamodb?.SequenceNumber) {
        failures.push({ itemIdentifier: record.dynamodb.SequenceNumber });  // ✅
      }
    }
  }
  return { batchItemFailures: failures };
}
```

## Integration Property

### ❌ WRONG: Using http property for data event handlers

```typescript
// ❌ S3 handlers do NOT have HTTP routes
const handler: LambdaDefinition<MyTies, {}, 's3'> = {
  ties: { processor: ImageProcessor },
  handler: async (event, context) => { /* ... */ },
  http: { method: 'POST', path: '/upload' },  // ❌ Wrong property
  s3: { bucket: 'uploads', events: ['s3:ObjectCreated:*'] },
};
```

### ✅ CORRECT: Using only the matching integration property

```typescript
const handler: LambdaDefinition<MyTies, {}, 's3'> = {
  ties: { processor: ImageProcessor },
  handler: async (event, context) => { /* ... */ },
  s3: { bucket: 'uploads', events: ['s3:ObjectCreated:*'] },  // ✅ Only s3
};
```

## Generic Type Parameter

### ❌ WRONG: Omitting the TIntegration generic

```typescript
// ❌ Without 's3' generic, event is typed as APIGatewayProxyEvent
const handler: LambdaDefinition<MyTies> = {
  ties: { processor: ImageProcessor },
  handler: async (event, context) => {
    event.Records;  // ❌ TypeScript error
  },
  s3: { bucket: 'uploads', events: ['s3:ObjectCreated:*'] },
};
```

### ✅ CORRECT: Specifying the integration kind generic

```typescript
// ✅ Third generic 's3' types event as S3Event
const handler: LambdaDefinition<MyTies, {}, 's3'> = {
  ties: { processor: ImageProcessor },
  handler: async (event, context) => {
    event.Records;  // ✅ Typed as S3EventRecord[]
  },
  s3: { bucket: 'uploads', events: ['s3:ObjectCreated:*'] },
};
```
