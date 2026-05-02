---
name: runtime-patterns-http
description: >
  Canonical copy-pastable templates for HTTP endpoint patterns with @worktif/runtime.
  Covers single GET endpoints, CRUD microservices, JWT-authenticated endpoints,
  and Cognito-authenticated endpoints. Use this skill when implementing any HTTP
  API endpoint, configuring authentication, or setting up API Gateway routes.
  Includes negative examples for common mistakes with ties instantiation,
  missing http property, AWS SDK v2 usage, and accessing undeclared ties.
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

This skill provides canonical templates for implementing HTTP endpoints with
`@worktif/runtime`. Each template is a complete, compilable code example that
is the ONLY correct way to accomplish the specific task. Use these templates
as the starting point for any HTTP endpoint implementation.

## When to Use

- When a consumer asks to create an API endpoint (GET, POST, PUT, PATCH, DELETE)
- When implementing a CRUD microservice with multiple endpoints
- When adding JWT or Cognito authentication to an endpoint
- When configuring CORS for HTTP endpoints
- When setting up path parameters or query string access
- When determining the correct response format for API Gateway

## Instructions

### Mapping Consumer Requests to Templates

| Consumer Request | Template |
|-----------------|----------|
| "Create a GET endpoint" | `references/templates/single-get.ts` |
| "Create an API" / "CRUD endpoints" | `references/templates/crud-microservice.ts` |
| "Add JWT authentication" | `references/templates/jwt-auth.ts` |
| "Add Cognito authentication" | `references/templates/cognito-auth.ts` |
| "Create a POST/PUT/DELETE endpoint" | Adapt from `crud-microservice.ts` |

### HTTP Response Format

All HTTP handlers MUST return an object with `statusCode` and `body`:

```typescript
return {
  statusCode: 200,
  body: JSON.stringify({ data: result }),
};
```

Optional response properties:
- `headers`: Record of response headers
- `isBase64Encoded`: Boolean for binary responses

### Path Parameters

Access path parameters via `event.pathParameters`:

```typescript
handler: async (event, context) => {
  const id = event.pathParameters?.id ?? '';
  // Use id...
}
```

Path parameter syntax in the `path` field uses `{param}`:

```typescript
http: { method: 'GET', path: '/users/{id}' }
```

### Query String Parameters

Access query parameters via `event.queryStringParameters`:

```typescript
handler: async (event, context) => {
  const page = event.queryStringParameters?.page ?? '1';
  const limit = event.queryStringParameters?.limit ?? '20';
}
```

### Request Body

Access the request body via `event.body` (always a string, parse with `JSON.parse`):

```typescript
handler: async (event, context) => {
  const data = JSON.parse(event.body ?? '{}');
}
```

### Authentication Options

The `auth` property in `http` configuration supports two modes:

**String mode (convenience):**
```typescript
http: { method: 'GET', path: '/users', auth: 'none' }
```

**Object mode (full configuration):**
```typescript
http: {
  method: 'GET',
  path: '/users',
  auth: { type: 'jwt', issuer: 'https://auth.example.com', audience: ['api.example.com'] }
}
```

EXACTLY 5 auth config types exist: `none`, `iam`, `jwt`, `cognito`, `custom`.

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

### ✅ CORRECT: Passing class constructors

```typescript
const handler: LambdaDefinition<MyTies> = {
  ties: {
    userService: UsersService,  // ✅ Class constructor
  },
  handler: async (event) => { /* ... */ },
  http: { method: 'GET', path: '/users' },
};
```

### ❌ WRONG: Missing the http property for an HTTP endpoint

```typescript
// ❌ No http property — Lambda cannot be reached via API Gateway
const handler: LambdaDefinition<MyTies> = {
  ties: { userService: UsersService },
  handler: async (event) => {
    return { statusCode: 200, body: '{}' };
  },
  // Missing http: { method: 'GET', path: '/users' }
};
```

### ✅ CORRECT: Including the http property

```typescript
const handler: LambdaDefinition<MyTies> = {
  ties: { userService: UsersService },
  handler: async (event) => {
    return { statusCode: 200, body: '{}' };
  },
  http: { method: 'GET', path: '/users' },  // ✅ Route is configured
};
```

### ❌ WRONG: Using AWS SDK v2

```typescript
import AWS from 'aws-sdk';  // ❌ Deprecated, creates massive bundles
const dynamodb = new AWS.DynamoDB.DocumentClient();
```

### ✅ CORRECT: Using AWS SDK v3 modular imports

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';  // ✅ Modular v3
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
```

### ❌ WRONG: Accessing ties not declared in the ties property

```typescript
type MyTies = { userService: UsersService };

const handler: LambdaDefinition<MyTies> = {
  ties: { userService: UsersService },
  handler: async (event) => {
    // ❌ configService was never declared in ties
    const config = event.ties.configService.getValue('key');
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
    // ✅ configService is declared and typed
    const config = event.ties.configService.getValue('key');
    return { statusCode: 200, body: JSON.stringify({ config }) };
  },
  http: { method: 'GET', path: '/config' },
};
```

### ❌ WRONG: Returning a plain string instead of the response object

```typescript
handler: async (event) => {
  return "Hello World";  // ❌ API Gateway expects { statusCode, body }
}
```

### ✅ CORRECT: Returning the proper response format

```typescript
handler: async (event) => {
  return { statusCode: 200, body: JSON.stringify({ message: "Hello World" }) };  // ✅
}
```

### ❌ WRONG: Using array-based ties for new HTTP endpoints

```typescript
// ❌ Legacy pattern — less type-safe, requires casting
const handler: LambdaDefinition = {
  ties: [UsersService],
  handler: (ties) => async (event, context) => {
    const userService = ties.userService as UsersService;  // Manual casting
    return { statusCode: 200, body: '{}' };
  },
  http: { method: 'GET', path: '/users' },
};
```

### ✅ CORRECT: Using object-based ties

```typescript
type MyTies = { userService: UsersService };

// ✅ Object-based ties — full type safety
const handler: LambdaDefinition<MyTies> = {
  ties: { userService: UsersService },
  handler: async (event) => {
    const users = await event.ties.userService.listUsers();
    return { statusCode: 200, body: JSON.stringify(users) };
  },
  http: { method: 'GET', path: '/users' },
};
```

## References

- [Single GET Template](references/templates/single-get.ts) — Complete GET endpoint with path parameters
- [CRUD Microservice Template](references/templates/crud-microservice.ts) — Full CRUD with multiple endpoints
- [JWT Auth Template](references/templates/jwt-auth.ts) — JWT-authenticated endpoint
- [Cognito Auth Template](references/templates/cognito-auth.ts) — Cognito-authenticated endpoint
- [Common Mistakes](references/common-mistakes.md) — Comprehensive ❌/✅ pairs for HTTP patterns
- [runtime-api-core](../runtime-api-core/SKILL.md) (Layer 2: API) — Exact type signatures for LambdaDefinition
- [runtime-concepts](../runtime-concepts/SKILL.md) (Layer 1: Concepts) — Domain model and ties pattern explanation
- [runtime-api-integrations](../runtime-api-integrations/SKILL.md) (Layer 2: API) — HttpIntegration configuration details
- [runtime-constraints-and-guardrails](../runtime-constraints-and-guardrails/SKILL.md) (Layer 4: Guardrails) — Hard constraints and anti-patterns
