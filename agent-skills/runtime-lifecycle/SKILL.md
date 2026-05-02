---
name: runtime-lifecycle
description: >
  Complete consumer lifecycle for @worktif/runtime from project initialization through
  deployment and upgrades. Covers project setup, microservice definition, build commands,
  CDK deployment, local development, testing, and the upgrade path. Use this skill when
  guiding a consumer through building an application or when orchestrating the correct
  sequence of development actions.
license: Elastic-2.0
compatibility: Requires @worktif/runtime >=0.5.0 <1.0.0
metadata:
  author: worktif
  version: "1.0.0"
  framework: "@worktif/runtime"
  frameworkVersionRange: ">=0.5.0 <1.0.0"
  layer: "1"
  layerName: "Concepts"
---

## Overview

This skill documents the complete consumer lifecycle when building applications with
`@worktif/runtime`. It covers every phase from initial project setup through deployment,
testing, and version upgrades, providing the correct sequence of actions at each stage.

## When to Use

- When a consumer asks "how do I start a new project with this framework"
- When determining the correct build command for a specific target
- When guiding deployment of a new or existing application
- When setting up local development or testing workflows
- When a consumer needs to upgrade their framework version
- When troubleshooting build or deployment order issues

## Core Concepts

### Consumer Lifecycle Phases

The complete lifecycle follows this sequence:

1. **Initialize** — Install the framework and scaffold the project
2. **Define** — Create MicroserviceDefinition with Ties and Lambda definitions
3. **Configure** — Set up integrations (HTTP, SQS, EventBridge, etc.)
4. **Implement** — Write handler logic using typed `event.ties` and `event.snapshot`
5. **Build** — Compile TypeScript and bundle for Lambda, browser, and CDK targets
6. **Deploy** — Synthesize and deploy CDK stacks to AWS
7. **Test** — Run unit tests, infrastructure tests, and coverage
8. **Upgrade** — Update framework version and migrate patterns

## Instructions

### Phase 1: Initialize Project

Install the framework package:

```bash
npm install @worktif/runtime
```

The resulting project structure:

```
my-app/
├── src/
│   ├── core/          # Lambda-only code (handlers, AWS SDK)
│   ├── lib/           # Isomorphic code (React, shared types)
│   ├── infra/         # CDK infrastructure constructs
│   ├── utils/         # Pure utility functions
│   └── bin/           # CLI and build scripts
├── tsconfig.json      # TypeScript config with path aliases
├── package.json
└── cdk.json           # CDK app configuration
```

Path aliases configured in `tsconfig.json`:

- `@core/*` → `src/core/*` (Lambda-only, server-side)
- `@lib/*` → `src/lib/*` (isomorphic, Lambda + browser)
- `@infra/*` → `src/infra/*` (CDK infrastructure)
- `@utils/*` → `src/utils/*` (pure utilities)
- `@bin/*` → `src/bin/*` (CLI and build tools)

### Phase 2: Define Microservices

Create a MicroserviceDefinition with Ties classes and Lambda definitions:

```typescript
import { MicroserviceDefinition, LambdaDefinition } from '@worktif/runtime';

// Define service classes
class UsersService {
  async getUser(id: string): Promise<User> { /* ... */ }
  async createUser(data: UserData): Promise<User> { /* ... */ }
}

// Define Ties class for service registration
class UsersTies {
  static register(container: PureContainer<string>) {
    container.tie('userService', UsersService, []);
  }
}

// Define ties type for handler access
type GetUserTies = { userService: UsersService };

// Define Lambda handlers
const getUserHandler: LambdaDefinition<GetUserTies> = {
  id: 'get-user',
  ties: { userService: UsersService },
  handler: async (event, context) => {
    const userId = event.pathParameters?.id;
    const user = await event.ties.userService.getUser(userId);
    return { statusCode: 200, body: JSON.stringify(user) };
  },
  http: { method: 'GET', path: '/users/{id}' },
};

// Group into a microservice
const usersService: MicroserviceDefinition = {
  ties: [UsersTies],
  lambdas: [getUserHandler],
};
```

### Phase 3: Configure Integrations

Set the integration config property on each LambdaDefinition. Each Lambda has exactly
one integration kind. See [runtime-api-integrations](../runtime-api-integrations/SKILL.md) (Layer 2: API) for all 9 integration configurations.

### Phase 4: Implement Handlers

Write handler logic using the typed `event.ties` object:

```typescript
handler: async (event, context) => {
  // event.ties provides fully typed service instances
  const result = await event.ties.userService.getUser(event.pathParameters.id);
  return { statusCode: 200, body: JSON.stringify(result) };
}
```

### Phase 5: Build

Build commands for each target:

| Command | Target | Output |
|---------|--------|--------|
| `yarn build` | Full build (all targets + types + docs) | `out/dist/` |
| `yarn cli:build:lambda` | Lambda handlers only | `.serverless/*.zip` |
| `yarn cli:build:react` | Browser bundle only | Browser assets |
| `yarn cli:build:cdk` | CDK infrastructure only | CDK output |
| `yarn types` | TypeScript declarations (.d.ts) | `out/dist/` |

The correct build order for a full deployment:

1. `yarn types` — Generate type declarations
2. `yarn cli:build:lambda` — Bundle Lambda handlers
3. `yarn cli:build:react` — Bundle browser assets (if using SSR)
4. `yarn cli:build:cdk` — Compile CDK infrastructure

Or use `yarn build` which executes all steps in the correct order.

After building Lambda, verify bundle size:
- Check `.serverless/*.zip` — MUST be <10MB (AWS hard limit)

### Phase 6: Deploy

The CDK app entry point instantiates the required stacks:

```typescript
import * as cdk from 'aws-cdk-lib';
import { RuntimeInfraStack, BrowserProviderStack, RuntimeWebStack } from '@worktif/runtime/infra';

const app = new cdk.App();
const stage = 'dev';
const serviceName = 'my-app';

// Stack 1: Base infrastructure (slow-changing)
const infraStack = new RuntimeInfraStack(app, `${serviceName}-Infra-${stage}`, {
  stage,
  serviceName,
  enableSeo: true,
});

// Stack 2: SSR deployment (optional, for server-rendered React)
new BrowserProviderStack(app, `${serviceName}-Browser-${stage}`, {
  stage,
  serviceName,
  appEntryPoint: './src/index.tsx',
  infraStack,
});

// Stack 3: Microservices (fast-changing)
new RuntimeWebStack(app, `${serviceName}-API-${stage}`, {
  stage,
  serviceName,
  infraStack,
  register: {
    users: usersService,
    payments: paymentsService,
  },
});
```

Deploy commands:

```bash
yarn deploy:dev       # Build + deploy to dev stage
yarn deploy:staging   # Build + deploy to staging
yarn deploy:prod      # Build + deploy to production
```

### Phase 7: Local Development

Start the local development server:

```bash
yarn purenow:start    # Starts on port 3000 with HMR
```

### Phase 8: Test

Run tests:

| Command | Scope |
|---------|-------|
| `yarn test` | All tests |
| `yarn test:infra` | Infrastructure tests only |
| `yarn test:coverage` | All tests with coverage report |

Test file locations: `src/**/__tests__/*.test.ts`

### Phase 9: Upgrade

When upgrading the framework version:

1. Update `package.json` dependency version
2. Run `yarn install`
3. Check [runtime-versioning-and-migration](../runtime-versioning-and-migration/SKILL.md) (Layer 5: Diagnostics) for breaking changes
4. Migrate deprecated patterns (e.g., array-based ties → object-based ties)
5. Run `yarn types` to regenerate declarations
6. Run `yarn test` to verify compatibility
7. Run `yarn build` to verify all targets compile

### Minimal Working Example

Complete example from initialization through first deployment:

```typescript
// src/services/hello.service.ts
export class HelloService {
  greet(name: string): string {
    return `Hello, ${name}!`;
  }
}

// src/ties/hello.ties.ts
import { HelloService } from '../services/hello.service';

export class HelloTies {
  static register(container: PureContainer<string>) {
    container.tie('helloService', HelloService, []);
  }
}

// src/microservices/hello.microservice.ts
import { MicroserviceDefinition, LambdaDefinition } from '@worktif/runtime';
import { HelloService } from '../services/hello.service';
import { HelloTies } from '../ties/hello.ties';

type GreetTies = { helloService: HelloService };

const greetHandler: LambdaDefinition<GreetTies> = {
  id: 'greet',
  ties: { helloService: HelloService },
  handler: async (event, context) => {
    const name = event.pathParameters?.name ?? 'World';
    const message = event.ties.helloService.greet(name);
    return { statusCode: 200, body: JSON.stringify({ message }) };
  },
  http: { method: 'GET', path: '/greet/{name}' },
};

export const helloService: MicroserviceDefinition = {
  ties: [HelloTies],
  lambdas: [greetHandler],
};

// src/infra/app.ts (CDK entry point)
import * as cdk from 'aws-cdk-lib';
import { RuntimeInfraStack, RuntimeWebStack } from '@worktif/runtime/infra';
import { helloService } from '../microservices/hello.microservice';

const app = new cdk.App();

const infraStack = new RuntimeInfraStack(app, 'Hello-Infra-dev', {
  stage: 'dev',
  serviceName: 'hello',
});

new RuntimeWebStack(app, 'Hello-API-dev', {
  stage: 'dev',
  serviceName: 'hello',
  infraStack,
  register: { hello: helloService },
});

// Optional: Add BrowserProviderStack for SSR React
// new BrowserProviderStack(app, 'Hello-Browser-dev', {
//   stage: 'dev',
//   serviceName: 'hello',
//   appEntryPoint: './src/index.tsx',
//   infraStack,
// });
```

Deploy:

```bash
yarn build
cdk deploy --all
```

## Common Mistakes

### ❌ WRONG: Deploying without building first

```bash
cdk deploy --all  # ❌ No build step — Lambda bundles are stale or missing
```

### ✅ CORRECT: Build before deploy

```bash
yarn build        # ✅ Full build (types + all bundles)
cdk deploy --all
```

### ❌ WRONG: Forgetting to run `yarn types` after modifying public APIs

```bash
# Modified src/index.tsx exports...
yarn cli:build:lambda  # ❌ Type declarations are stale
```

### ✅ CORRECT: Regenerate types after API changes

```bash
yarn types             # ✅ Regenerate .d.ts files
yarn cli:build:lambda  # Now build with fresh types
```

### ❌ WRONG: Building in wrong order

```bash
yarn cli:build:cdk     # ❌ CDK may reference types not yet generated
yarn cli:build:lambda
yarn types
```

### ✅ CORRECT: Types first, then bundles

```bash
yarn types             # ✅ 1. Generate declarations
yarn cli:build:lambda  # ✅ 2. Bundle Lambda handlers
yarn cli:build:cdk     # ✅ 3. Compile CDK (references generated types)
```

### ❌ WRONG: Not checking Lambda bundle size after adding dependencies

```bash
yarn add some-large-package
yarn cli:build:lambda
# ❌ Never checked .serverless/*.zip size — may exceed 10MB
```

### ✅ CORRECT: Verify bundle size after dependency changes

```bash
yarn add some-large-package
yarn cli:build:lambda
# ✅ Check .serverless/*.zip — must be <10MB
# If exceeded: externalize the dependency in esbuild config
```

## References

- [Commands Reference](references/commands-reference.md) — Full command catalog with descriptions and flags
- [runtime-concepts](../runtime-concepts/SKILL.md) (Layer 1: Concepts) — Product definition and domain model
- [runtime-api-core](../runtime-api-core/SKILL.md) (Layer 2: API) — Exact type signatures for core types
- [runtime-versioning-and-migration](../runtime-versioning-and-migration/SKILL.md) (Layer 5: Diagnostics) — Version upgrade paths
