# Migration Guides

## Migration: 0.4.x → 0.5.0

This is the primary migration path. Version 0.5.0 introduced object-based ties,
direct handler signatures, and full generic type parameters.

### Prerequisites

- Node.js >=18 installed
- TypeScript 5.8+ installed
- All tests passing on current version before starting migration

### Step 1: Update the Framework Package

```bash
yarn add @worktif/runtime@^0.5.0
```

Verify installation:

```bash
yarn info @worktif/runtime version
# Should output: 0.5.x
```

### Step 2: Migrate Ties from Array to Object

Find all Lambda definitions using array-based ties:

```bash
# Search pattern for array-based ties
grep -rn "ties: \[" src/
```

**For each occurrence, apply this transformation:**

```diff
- // Old: array-based ties (0.4.x)
- const handler: LambdaDefinition = {
-   ties: [UsersService, OrdersService],
-   handler: (ties) => async (event) => {
-     const userService = ties.userService as UsersService;
-     const orderService = ties.orderService as OrdersService;
-     const users = await userService.listUsers();
-     return { statusCode: 200, body: JSON.stringify(users) };
-   },
-   http: { method: 'GET', path: '/users' },
- };

+ // New: object-based ties (0.5.0+)
+ type GetUsersTies = {
+   userService: UsersService;
+   orderService: OrdersService;
+ };
+
+ const handler: LambdaDefinition<GetUsersTies> = {
+   ties: {
+     userService: UsersService,
+     orderService: OrdersService,
+   },
+   handler: async (event) => {
+     const users = await event.ties.userService.listUsers();
+     return { statusCode: 200, body: JSON.stringify(users) };
+   },
+   http: { method: 'GET', path: '/users' },
+ };
```

### Step 3: Migrate Handler Signatures

Find all factory-style handlers:

```bash
# Search pattern for factory handlers
grep -rn "handler: (ties)" src/
```

**For each occurrence, apply this transformation:**

```diff
- // Old: factory-style handler (0.4.x)
- handler: (ties) => async (event) => {
-   const userService = ties.userService as UsersService;
-   const result = await userService.getUser(event.pathParameters.id);
-   return { statusCode: 200, body: JSON.stringify(result) };
- }

+ // New: direct handler (0.5.0+)
+ handler: async (event) => {
+   const result = await event.ties.userService.getUser(event.pathParameters.id);
+   return { statusCode: 200, body: JSON.stringify(result) };
+ }
```

### Step 4: Add Generic Type Parameters

Find all untyped LambdaDefinition usages:

```bash
# Search for LambdaDefinition without generic parameters
grep -rn "LambdaDefinition = {" src/
grep -rn "LambdaDefinition =" src/
```

**For each occurrence, add the generic parameter:**

```diff
- const handler: LambdaDefinition = {
+ const handler: LambdaDefinition<MyTies> = {
```

If using snapshot:

```diff
- const handler: LambdaDefinition = {
+ const handler: LambdaDefinition<MyTies, MySnapshot> = {
```

If specifying integration kind explicitly:

```diff
- const handler: LambdaDefinition = {
+ const handler: LambdaDefinition<MyTies, {}, 'sqs'> = {
```

### Step 5: Migrate InitFunction Signature

Find all init functions using the old container pattern:

```bash
grep -rn "init: async (container)" src/
```

**Apply this transformation:**

```diff
- // Old: init receives raw container (0.4.x)
- init: async (container) => {
-   const db = container.get('database');
-   return { cachedData: await db.loadAll() };
- }

+ // New: init receives typed ties (0.5.0+)
+ init: async (ties) => {
+   return { cachedData: await ties.dataService.loadAll() };
+ }
```

### Step 6: Remove Manual Type Casts

Find all `as ServiceType` casts related to ties:

```bash
grep -rn "as.*Service" src/ | grep ties
```

**Remove them — they are no longer needed:**

```diff
- const userService = ties.userService as UsersService;
- const result = await userService.getUser(id);

+ const result = await event.ties.userService.getUser(id);
```

### Step 7: Verify Compilation

```bash
# Run type checking
yarn types

# Full build
yarn build

# Run tests
yarn test
```

Fix any remaining type errors. Common issues:
- Missing type alias definition (Step 2)
- Leftover `ties` parameter in handler (Step 3)
- Missing generic parameter (Step 4)

### Step 8: Verify Runtime Behavior

```bash
# Start local dev server
yarn purenow:start

# Test endpoints manually or with integration tests
yarn test --testPathPattern=integration
```

---

## Migration: 0.5.0-beta.1 → 0.5.0-beta.2

This is a minor migration within the beta phase.

### Changes

1. **New integration kind: `direct`**
   - No code changes required unless you want to use the new kind
   - `IntegrationKind` type now includes `'direct'` as the 9th value

2. **New auth config: `AuthConfigCustom`**
   - No code changes required unless you want custom authorizers
   - `AuthConfig` union now includes `AuthConfigCustom`

### Migration Steps

```bash
# Update package
yarn add @worktif/runtime@0.5.0-beta.2

# Verify types still compile
yarn types

# No code changes required for existing functionality
```

---

## Migration: MicroserviceDefinition Ties Registration

If using the `MicroserviceDefinition` level ties (shared across all Lambdas in a
microservice), the registration pattern also changed:

### Before (0.4.x)

```typescript
// Old: Ties as array at microservice level
const microservice: MicroserviceDefinition = {
  ties: [SharedService, AnotherService],
  lambdas: [handler1, handler2],
};
```

### After (0.5.0+)

```typescript
// New: Ties instances with static register method
class SharedTies {
  static register(container: PureContainer<string>) {
    container.tie('sharedService', SharedService, []);
    container.tie('anotherService', AnotherService, []);
  }
}

const microservice: MicroserviceDefinition = {
  ties: [SharedTies],  // Array of Ties classes with static register
  lambdas: [handler1, handler2],
};
```

Note: The `MicroserviceDefinition.ties` property remains an array, but it now
contains Ties registration classes (with `static register` methods), not service
classes directly. Individual `LambdaDefinition.ties` uses the object-based pattern.

---

## Compatibility Verification Checklist

Run this checklist when starting work on any consumer project:

```bash
# 1. Check Node.js version (must be >=18)
node --version

# 2. Check TypeScript version (must be 5.8+)
npx tsc --version

# 3. Check framework version (must be >=0.5.0 <1.0.0)
yarn info @worktif/runtime version

# 4. Check React version (dev: 19.x, peer: 16.14-18.x)
yarn info react version

# 5. Check React Router version (must be 7.7+)
yarn info react-router version

# 6. Check CDK version (must be 2.x)
yarn info aws-cdk-lib version

# 7. Verify no AWS SDK v2
grep -rn "from 'aws-sdk'" src/
# Should return no results

# 8. Verify object-based ties pattern
grep -rn "ties: \[" src/
# Should return no results (or only MicroserviceDefinition.ties)
```

If any check fails, consult the appropriate migration section above.

---

## Rollback Procedure

If a migration causes issues and you need to rollback:

```bash
# 1. Revert package.json changes
git checkout package.json yarn.lock

# 2. Reinstall previous version
yarn install

# 3. Verify old code still works
yarn types
yarn build
yarn test
```

**Important:** Do NOT partially migrate. Either complete the full migration or
rollback entirely. Mixing old and new patterns in the same codebase causes
type errors and runtime failures.
