# Anti-Patterns Reference

This document contains all ❌/✅ pairs organized by category. Each pair shows
a common mistake (anti-pattern) and the correct alternative. AI agents MUST
generate code matching the ✅ CORRECT patterns and MUST NEVER generate code
matching the ❌ WRONG patterns.

---

## Category 1: Ties Pattern Violations

### 1.1 Instantiating ties directly

```typescript
// ❌ WRONG — ties accepts class constructors, NOT instances
const handler: LambdaDefinition<MyTies> = {
  ties: {
    userService: new UsersService(),       // ❌ Do not instantiate
    orderService: new OrdersService(),     // ❌ Framework handles this
  },
  handler: async (event) => { /* ... */ },
  http: { method: 'GET', path: '/users' },
};
```

```typescript
// ✅ CORRECT — pass the class constructor itself
const handler: LambdaDefinition<MyTies> = {
  ties: {
    userService: UsersService,       // ✅ Class constructor
    orderService: OrdersService,     // ✅ Framework instantiates
  },
  handler: async (event) => { /* ... */ },
  http: { method: 'GET', path: '/users' },
};
```

### 1.2 Using deprecated array-based ties

```typescript
// ❌ WRONG — array-based ties are deprecated, less type-safe
const handler: LambdaDefinition = {
  ties: [UsersService, OrdersService],
  handler: (ties) => async (event, context) => {
    const userService = ties.userService as UsersService;  // Manual casting required
    const orderService = ties.orderService as OrdersService;
    return { statusCode: 200, body: '{}' };
  },
  http: { method: 'GET', path: '/users' },
};
```

```typescript
// ✅ CORRECT — object-based ties with full type inference
type MyTies = { userService: UsersService; orderService: OrdersService };

const handler: LambdaDefinition<MyTies> = {
  ties: { userService: UsersService, orderService: OrdersService },
  handler: async (event) => {
    // event.ties.userService is typed as UsersService — no casting
    // event.ties.orderService is typed as OrdersService — no casting
    const users = await event.ties.userService.listUsers();
    return { statusCode: 200, body: JSON.stringify(users) };
  },
  http: { method: 'GET', path: '/users' },
};
```

### 1.3 Accessing undeclared ties

```typescript
// ❌ WRONG — accessing a service not declared in the ties property
type MyTies = { userService: UsersService };

const handler: LambdaDefinition<MyTies> = {
  ties: { userService: UsersService },
  handler: async (event) => {
    // ❌ configService is not in MyTies — TypeScript error + runtime undefined
    const config = event.ties.configService.get('key');
    return { statusCode: 200, body: '{}' };
  },
  http: { method: 'GET', path: '/config' },
};
```

```typescript
// ✅ CORRECT — declare all services you need in the ties type and property
type MyTies = { userService: UsersService; configService: ConfigService };

const handler: LambdaDefinition<MyTies> = {
  ties: { userService: UsersService, configService: ConfigService },
  handler: async (event) => {
    // ✅ Both services are declared, typed, and available
    const config = event.ties.configService.get('key');
    return { statusCode: 200, body: JSON.stringify({ config }) };
  },
  http: { method: 'GET', path: '/config' },
};
```

### 1.4 Using factory functions instead of class constructors

```typescript
// ❌ WRONG — ties accepts class constructors, not factory functions
const createUserService = () => new UsersService();

const handler: LambdaDefinition<MyTies> = {
  ties: {
    userService: createUserService,  // ❌ Not a class constructor
  },
  handler: async (event) => { /* ... */ },
  http: { method: 'GET', path: '/users' },
};
```

```typescript
// ✅ CORRECT — pass the class itself
const handler: LambdaDefinition<MyTies> = {
  ties: {
    userService: UsersService,  // ✅ Class constructor
  },
  handler: async (event) => { /* ... */ },
  http: { method: 'GET', path: '/users' },
};
```

### 1.5 Using plain objects instead of class constructors

```typescript
// ❌ WRONG — ties does not accept plain objects
const handler: LambdaDefinition<MyTies> = {
  ties: {
    userService: { listUsers: async () => [] },  // ❌ Plain object, not a class
  },
  handler: async (event) => { /* ... */ },
  http: { method: 'GET', path: '/users' },
};
```

```typescript
// ✅ CORRECT — define a class and pass the constructor
class UsersService {
  async listUsers() { return []; }
}

type MyTies = { userService: UsersService };

const handler: LambdaDefinition<MyTies> = {
  ties: { userService: UsersService },  // ✅ Class constructor
  handler: async (event) => { /* ... */ },
  http: { method: 'GET', path: '/users' },
};
```

---

## Category 2: AWS SDK Violations

### 2.1 Using AWS SDK v2

```typescript
// ❌ WRONG — AWS SDK v2 is deprecated and creates 50MB+ bundles
import AWS from 'aws-sdk';
const s3 = new AWS.S3();
const result = await s3.getObject({ Bucket: 'my-bucket', Key: 'file.txt' }).promise();
```

```typescript
// ✅ CORRECT — AWS SDK v3 modular imports
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
const client = new S3Client({});
const result = await client.send(new GetObjectCommand({ Bucket: 'my-bucket', Key: 'file.txt' }));
```

### 2.2 Using SDK v2 DynamoDB DocumentClient

```typescript
// ❌ WRONG — v2 DocumentClient
import AWS from 'aws-sdk';
const docClient = new AWS.DynamoDB.DocumentClient();
const result = await docClient.get({ TableName: 'users', Key: { id: '123' } }).promise();
```

```typescript
// ✅ CORRECT — v3 DynamoDBDocumentClient
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const result = await client.send(new GetCommand({ TableName: 'users', Key: { id: '123' } }));
```

### 2.3 Bundling AWS SDK v3 clients

```typescript
// ❌ WRONG — bundling SDK clients inflates Lambda package
// In esbuild.config.ts:
// external: []  ← Missing SDK externalization
```

```typescript
// ✅ CORRECT — externalize all AWS SDK v3 clients
// In esbuild.config.ts:
// external: ['@aws-sdk/*']  ← SDK is pre-installed in Lambda runtime
```

---

## Category 3: Import and Architecture Boundary Violations

### 3.1 Relative imports across directories

```typescript
// ❌ WRONG — relative imports break when files move
import { UsersService } from '../../core/services/users';
import { BrowserProviderStack } from '../../../infra/browser-provider-stack';
import { formatDate } from '../../utils/common';
```

```typescript
// ✅ CORRECT — path aliases are stable and enforce boundaries
import { UsersService } from '@core/services/users';
import { BrowserProviderStack } from '@infra/browser-provider-stack';
import { formatDate } from '@utils/common';
```

### 3.2 Importing @core/* in isomorphic code (src/lib/)

```typescript
// ❌ WRONG — @core/* is Lambda-only, breaks browser builds
// File: src/lib/shared-utils.ts
import { S3StaticService } from '@core/services/aws/s3';
import { LambdaApi } from '@core/functions';
```

```typescript
// ✅ CORRECT — use @utils/* for shared code, keep @core/* in src/core/ only
// File: src/lib/shared-utils.ts
import { formatDate } from '@utils/common';
import type { UserData } from '@utils/types';  // Type-only imports are safe
```

### 3.3 Importing @infra/* in runtime code

```typescript
// ❌ WRONG — CDK constructs are deploy-time only
// File: src/core/functions/my-handler/lambda.my-handler.ts
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { BrowserProviderStack } from '@infra/browser-provider-stack';
```

```typescript
// ✅ CORRECT — use environment variables for resource references at runtime
// File: src/core/functions/my-handler/lambda.my-handler.ts
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
const bucketName = process.env.BUCKET_NAME;  // Set by CDK during deployment
```

### 3.4 Importing @lib/* in infrastructure code

```typescript
// ❌ WRONG — infra code must not depend on runtime/isomorphic code
// File: src/infra/my-stack.ts
import { runtime } from '@lib/runtime-core';
import { MyComponent } from '@lib/react';
```

```typescript
// ✅ CORRECT — infra only imports from @utils/* if needed
// File: src/infra/my-stack.ts
import { STAGE_DEFAULTS } from '@utils/constants';
```

---

## Category 4: CDK and Infrastructure Violations

### 4.1 Using L1 CloudFormation constructs

```typescript
// ❌ WRONG — L1 constructs are raw CloudFormation, no safety features
import { CfnBucket } from 'aws-cdk-lib/aws-s3';
const bucket = new CfnBucket(this, 'Bucket', {
  bucketName: 'my-hardcoded-bucket-name',
});
```

```typescript
// ✅ CORRECT — L2/L3 constructs with sensible defaults
import { Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
const bucket = new Bucket(this, 'Bucket', {
  versioned: true,
  encryption: BucketEncryption.S3_MANAGED,
  // CDK generates a unique name — no hardcoding
});
```

### 4.2 Hardcoding resource names in CDK

```typescript
// ❌ WRONG — hardcoded names cause conflicts across stages/accounts
const bucket = new Bucket(this, 'Bucket', {
  bucketName: 'my-app-uploads',  // ❌ Conflicts in multi-stage deployments
});

const table = new Table(this, 'Table', {
  tableName: 'users',  // ❌ Cannot deploy dev + staging in same account
});
```

```typescript
// ✅ CORRECT — let CDK generate unique names
const bucket = new Bucket(this, 'Bucket', {
  versioned: true,
  // No bucketName — CDK generates a unique name per stack
});

const table = new Table(this, 'Table', {
  partitionKey: { name: 'id', type: AttributeType.STRING },
  // No tableName — CDK generates a unique name per stack
});
```

### 4.3 Bundling CDK libraries in Lambda

```typescript
// ❌ WRONG — aws-cdk-lib is 200MB+, must never be in Lambda bundle
// In esbuild.config.ts:
// external: ['@aws-sdk/*']  ← Missing CDK externalization
```

```typescript
// ✅ CORRECT — externalize CDK libraries in all builds
// In esbuild.config.ts:
// external: ['@aws-sdk/*', 'aws-cdk-lib', 'constructs']
```

---

## Category 5: Isomorphic Code Violations

### 5.1 Using browser APIs without guards in src/lib/

```typescript
// ❌ WRONG — crashes during Lambda SSR (window is undefined in Node.js)
// File: src/lib/analytics.ts
const userId = window.localStorage.getItem('userId');
document.title = 'My App';
navigator.sendBeacon('/analytics', JSON.stringify(data));
```

```typescript
// ✅ CORRECT — guard browser-only APIs
// File: src/lib/analytics.ts
export function getStoredUserId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem('userId');
}

export function setPageTitle(title: string): void {
  if (typeof document !== 'undefined') {
    document.title = title;
  }
}
```

### 5.2 Conditional rendering causing hydration mismatch

```typescript
// ❌ WRONG — different output on server vs client causes hydration mismatch
export function MyComponent() {
  // Server renders "Loading...", client renders content — MISMATCH
  if (typeof window === 'undefined') {
    return <div>Loading...</div>;
  }
  return <div>Client Content</div>;
}
```

```typescript
// ✅ CORRECT — same initial render, update after hydration via useEffect
export function MyComponent() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);  // Runs only after hydration completes
  }, []);

  return (
    <div>
      {mounted ? 'Client Content' : 'Loading...'}
    </div>
  );
}
```

### 5.3 Using Node.js APIs in isomorphic code

```typescript
// ❌ WRONG — Node.js APIs do not exist in the browser
// File: src/lib/file-utils.ts
import fs from 'fs';
import path from 'path';

export function readConfig() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
}
```

```typescript
// ✅ CORRECT — move Node.js-only code to src/core/
// File: src/core/config/config-reader.ts
import fs from 'fs';
import path from 'path';

export function readConfig() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
}
```

---

## Category 6: Integration Configuration Violations

### 6.1 Using non-existent integration types

```typescript
// ❌ WRONG — these integration types do NOT exist
const handler: LambdaDefinition<MyTies> = {
  ties: { /* ... */ },
  handler: async (event) => { /* ... */ },
  websocket: { route: '$connect' },     // ❌ Does not exist
  graphql: { schema: '...' },           // ❌ Does not exist
  kafka: { topic: 'events' },           // ❌ Does not exist
  iot: { rule: 'my-rule' },             // ❌ Does not exist
};
```

```typescript
// ✅ CORRECT — use one of the 9 supported integration types
const handler: LambdaDefinition<MyTies> = {
  ties: { /* ... */ },
  handler: async (event) => { /* ... */ },
  http: { method: 'GET', path: '/connect' },  // ✅ Supported
};
```

### 6.2 Setting multiple integration configs on one Lambda

```typescript
// ❌ WRONG — each Lambda has exactly ONE integration kind
const handler: LambdaDefinition<MyTies> = {
  ties: { /* ... */ },
  handler: async (event) => { /* ... */ },
  http: { method: 'POST', path: '/orders' },
  sqs: { queue: ordersQueue },  // ❌ Cannot have both
};
```

```typescript
// ✅ CORRECT — separate Lambdas for different integrations
const httpHandler: LambdaDefinition<MyTies> = {
  id: 'create-order-http',
  ties: { /* ... */ },
  handler: async (event) => { /* ... */ },
  http: { method: 'POST', path: '/orders' },
};

const sqsHandler: LambdaDefinition<MyTies, {}, 'sqs'> = {
  id: 'process-order-sqs',
  ties: { /* ... */ },
  handler: async (event) => { /* ... */ },
  sqs: { queue: ordersQueue, reportBatchItemFailures: true },
};
```

### 6.3 Using wrong integration property names

```typescript
// ❌ WRONG — incorrect property names
const handler: LambdaDefinition<MyTies> = {
  ties: { /* ... */ },
  handler: async (event) => { /* ... */ },
  queue: { /* ... */ },          // ❌ Use 'sqs'
  events: { /* ... */ },         // ❌ Use 'eventbridge'
  stream: { /* ... */ },         // ❌ Use 'kinesis'
  cron: { /* ... */ },           // ❌ Use 'schedule'
  trigger: { /* ... */ },        // ❌ Use 's3'
  dynamodbStream: { /* ... */ }, // ❌ Use 'dynamodb'
};
```

```typescript
// ✅ CORRECT — exact property names from the framework
const handler: LambdaDefinition<MyTies> = {
  ties: { /* ... */ },
  handler: async (event) => { /* ... */ },
  sqs: { /* ... */ },          // ✅
  eventbridge: { /* ... */ },  // ✅
  kinesis: { /* ... */ },      // ✅
  schedule: { /* ... */ },     // ✅
  s3: { /* ... */ },           // ✅
  dynamodb: { /* ... */ },     // ✅
};
```

---

## Category 7: Handler and Response Violations

### 7.1 Returning wrong response format for HTTP handlers

```typescript
// ❌ WRONG — API Gateway expects { statusCode, body }
handler: async (event) => {
  return "Hello World";  // ❌ String, not response object
}

handler: async (event) => {
  return { message: "Hello" };  // ❌ Missing statusCode
}

handler: async (event) => {
  return { statusCode: 200, data: { users: [] } };  // ❌ 'data' not 'body'
}
```

```typescript
// ✅ CORRECT — proper API Gateway response format
handler: async (event) => {
  return {
    statusCode: 200,
    body: JSON.stringify({ message: "Hello World" }),  // ✅ Stringified body
  };
}

handler: async (event) => {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ users: [] }),
  };
}
```

### 7.2 Using raw Lambda handler signatures

```typescript
// ❌ WRONG — bypasses framework DI, lifecycle, and type safety
export const handler = async (event: APIGatewayProxyEvent) => {
  return { statusCode: 200, body: '{}' };
};
```

```typescript
// ✅ CORRECT — use LambdaDefinition for all handlers
import { LambdaDefinition } from '@worktif/runtime';

type MyTies = { myService: MyService };

export const handler: LambdaDefinition<MyTies> = {
  id: 'my-handler',
  ties: { myService: MyService },
  handler: async (event, context) => {
    return { statusCode: 200, body: '{}' };
  },
  http: { method: 'GET', path: '/endpoint' },
};
```

---

## Category 8: Bundle Size Violations

### 8.1 Not externalizing large dependencies

```typescript
// ❌ WRONG — bundling a 5MB package into Lambda
// package.json: "sharp": "^0.33.0"  (5MB native module)
// esbuild.config.ts: external: ['@aws-sdk/*']  ← Missing 'sharp'
```

```typescript
// ✅ CORRECT — externalize large packages, use Lambda layer
// esbuild.config.ts: external: ['@aws-sdk/*', 'sharp']
// Deploy sharp via Lambda layer
```

### 8.2 Importing entire utility libraries

```typescript
// ❌ WRONG — imports entire lodash (1.4MB)
import _ from 'lodash';
const result = _.get(obj, 'nested.path');
```

```typescript
// ✅ CORRECT — import only the function needed (4KB)
import get from 'lodash/get';
const result = get(obj, 'nested.path');

// ✅ EVEN BETTER — use native JavaScript
const result = obj?.nested?.path;
```

---

## Category 9: Type Safety Violations

### 9.1 Using `any` in public API

```typescript
// ❌ WRONG — any disables type checking
export function processData(data: any): any {
  return data.map((item: any) => item.value);
}
```

```typescript
// ✅ CORRECT — use proper generics or unknown
export function processData<T extends { value: unknown }>(data: T[]): unknown[] {
  return data.map((item) => item.value);
}
```

### 9.2 Missing return types on exported functions

```typescript
// ❌ WRONG — inferred return type may change unexpectedly
export function createHandler(config: HandlerConfig) {
  // Return type is inferred — fragile public API
  return { handler: config.handler, id: config.id };
}
```

```typescript
// ✅ CORRECT — explicit return type for public API stability
export function createHandler(config: HandlerConfig): HandlerResult {
  return { handler: config.handler, id: config.id };
}
```
