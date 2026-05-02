# Common Mistakes: HTTP Patterns

Comprehensive ❌/✅ pairs for HTTP endpoint implementation with `@worktif/runtime`.

## Ties Instantiation

### ❌ WRONG: Passing instances instead of class constructors

```typescript
const handler: LambdaDefinition<MyTies> = {
  ties: {
    userService: new UsersService(),  // ❌ Instance — framework instantiates
    dbService: new DatabaseService(), // ❌ Instance
  },
  handler: async (event) => { /* ... */ },
  http: { method: 'GET', path: '/users' },
};
```

### ✅ CORRECT: Passing class constructors

```typescript
const handler: LambdaDefinition<MyTies> = {
  ties: {
    userService: UsersService,   // ✅ Class constructor
    dbService: DatabaseService,  // ✅ Class constructor
  },
  handler: async (event) => { /* ... */ },
  http: { method: 'GET', path: '/users' },
};
```

## Missing HTTP Integration

### ❌ WRONG: Omitting the http property for an API endpoint

```typescript
// ❌ This Lambda has no API Gateway route — it cannot be called via HTTP
const handler: LambdaDefinition<MyTies> = {
  id: 'get-users',
  ties: { userService: UsersService },
  handler: async (event) => {
    const users = await event.ties.userService.listUsers();
    return { statusCode: 200, body: JSON.stringify(users) };
  },
  // Missing: http: { method: 'GET', path: '/users' }
};
```

### ✅ CORRECT: Including the http property

```typescript
const handler: LambdaDefinition<MyTies> = {
  id: 'get-users',
  ties: { userService: UsersService },
  handler: async (event) => {
    const users = await event.ties.userService.listUsers();
    return { statusCode: 200, body: JSON.stringify(users) };
  },
  http: { method: 'GET', path: '/users' },  // ✅ Route configured
};
```

## AWS SDK Version

### ❌ WRONG: Using AWS SDK v2

```typescript
import AWS from 'aws-sdk';  // ❌ Deprecated, massive bundle
const s3 = new AWS.S3();
const dynamodb = new AWS.DynamoDB.DocumentClient();
```

### ✅ CORRECT: Using AWS SDK v3 modular imports

```typescript
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';  // ✅
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const s3Client = new S3Client({});
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
```

## Undeclared Ties Access

### ❌ WRONG: Accessing a service not declared in ties

```typescript
type MyTies = { userService: UsersService };

const handler: LambdaDefinition<MyTies> = {
  ties: { userService: UsersService },
  handler: async (event) => {
    // ❌ emailService is not in MyTies — TypeScript error + runtime undefined
    await event.ties.emailService.send('hello@example.com', 'Welcome');
    return { statusCode: 200, body: '{}' };
  },
  http: { method: 'POST', path: '/users' },
};
```

### ✅ CORRECT: Declaring all services used in the handler

```typescript
type MyTies = { userService: UsersService; emailService: EmailService };

const handler: LambdaDefinition<MyTies> = {
  ties: { userService: UsersService, emailService: EmailService },
  handler: async (event) => {
    // ✅ emailService is declared and typed
    await event.ties.emailService.send('hello@example.com', 'Welcome');
    return { statusCode: 200, body: '{}' };
  },
  http: { method: 'POST', path: '/users' },
};
```

## Response Format

### ❌ WRONG: Returning a plain value

```typescript
handler: async (event) => {
  return { users: [] };  // ❌ API Gateway expects statusCode + body
}
```

### ✅ CORRECT: Returning statusCode and body

```typescript
handler: async (event) => {
  return {
    statusCode: 200,
    body: JSON.stringify({ users: [] }),  // ✅ Proper response format
  };
}
```

### ❌ WRONG: Not stringifying the body

```typescript
handler: async (event) => {
  return {
    statusCode: 200,
    body: { users: [] },  // ❌ body must be a string
  };
}
```

### ✅ CORRECT: Stringifying the body

```typescript
handler: async (event) => {
  return {
    statusCode: 200,
    body: JSON.stringify({ users: [] }),  // ✅ String body
  };
}
```

## Path Parameters

### ❌ WRONG: Assuming pathParameters is always defined

```typescript
handler: async (event) => {
  const id = event.pathParameters.id;  // ❌ pathParameters can be null
  return { statusCode: 200, body: JSON.stringify({ id }) };
}
```

### ✅ CORRECT: Using optional chaining with fallback

```typescript
handler: async (event) => {
  const id = event.pathParameters?.id ?? '';  // ✅ Safe access
  if (!id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing id' }) };
  }
  return { statusCode: 200, body: JSON.stringify({ id }) };
}
```

## Request Body Parsing

### ❌ WRONG: Assuming body is always present and valid JSON

```typescript
handler: async (event) => {
  const data = JSON.parse(event.body);  // ❌ body can be null, parse can throw
  return { statusCode: 200, body: JSON.stringify(data) };
}
```

### ✅ CORRECT: Handling null body and parse errors

```typescript
handler: async (event) => {
  const data = JSON.parse(event.body ?? '{}');  // ✅ Fallback for null body
  return { statusCode: 200, body: JSON.stringify(data) };
}
```

## Authentication Configuration

### ❌ WRONG: Mixing auth string and object syntax incorrectly

```typescript
http: {
  method: 'GET',
  path: '/users',
  auth: 'jwt',  // ❌ String 'jwt' alone does not provide issuer — use object mode
}
```

### ✅ CORRECT: Using object mode for JWT with required fields

```typescript
http: {
  method: 'GET',
  path: '/users',
  auth: {
    type: 'jwt',
    issuer: 'https://auth.example.com',  // ✅ Required for JWT
    audience: ['api.example.com'],
  },
}
```

## HTTP Method Casing

### ❌ WRONG: Using lowercase HTTP methods

```typescript
http: { method: 'get', path: '/users' }  // ❌ Must be uppercase
```

### ✅ CORRECT: Using uppercase HTTP methods

```typescript
http: { method: 'GET', path: '/users' }  // ✅ Uppercase
```

## Import Paths

### ❌ WRONG: Importing from non-existent subpaths

```typescript
import { LambdaDefinition } from '@worktif/runtime/types';  // ❌ Does not exist
import { HttpIntegration } from '@worktif/runtime/http';    // ❌ Does not exist
```

### ✅ CORRECT: Using the valid import path

```typescript
import { LambdaDefinition } from '@worktif/runtime';  // ✅ Correct path
```

## Generic Type Parameter

### ❌ WRONG: Omitting the TTies generic (losing type safety)

```typescript
const handler: LambdaDefinition = {  // ❌ No generic — event.ties is 'any'
  ties: { userService: UsersService },
  handler: async (event) => {
    event.ties.userService.getUser('123');  // No type checking
    return { statusCode: 200, body: '{}' };
  },
  http: { method: 'GET', path: '/users/{id}' },
};
```

### ✅ CORRECT: Providing the TTies generic

```typescript
type MyTies = { userService: UsersService };

const handler: LambdaDefinition<MyTies> = {  // ✅ Full type safety
  ties: { userService: UsersService },
  handler: async (event) => {
    event.ties.userService.getUser('123');  // ✅ Fully typed
    return { statusCode: 200, body: '{}' };
  },
  http: { method: 'GET', path: '/users/{id}' },
};
```

## Setting the service Field

### ❌ WRONG: Manually setting the service field

```typescript
const handler: LambdaDefinition<MyTies> = {
  id: 'get-user',
  service: 'users',  // ❌ Internal field — auto-populated by framework
  ties: { userService: UsersService },
  handler: async (event) => { /* ... */ },
  http: { method: 'GET', path: '/users/{id}' },
};
```

### ✅ CORRECT: Only setting id, letting framework handle service

```typescript
const handler: LambdaDefinition<MyTies> = {
  id: 'get-user',  // ✅ Only set id
  ties: { userService: UsersService },
  handler: async (event) => { /* ... */ },
  http: { method: 'GET', path: '/users/{id}' },
};
```
