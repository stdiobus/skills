---
name: runtime-ssr-and-web
description: >
  Server-side rendering (SSR) patterns and web deployment with @worktif/runtime.
  Covers the runtime() entry point function, BrowserProviderStack CDK configuration,
  isomorphic code constraints, React hydration requirements, and browser bundle
  size limits. Use this skill when implementing SSR React pages, configuring
  web deployment, or troubleshooting hydration mismatches and environment
  boundary violations in isomorphic code.
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

This skill documents the SSR (Server-Side Rendering) capabilities of `@worktif/runtime`.
The framework provides a single `runtime()` entry point that auto-detects the execution
context (Lambda SSR or browser hydration) and handles both paths from the same code.
SSR is OPTIONAL — the framework's primary purpose is Lambda microservices.

## When to Use

- When a consumer wants to add server-side rendered React pages
- When configuring the `runtime()` entry point function
- When deploying SSR applications with `BrowserProviderStack`
- When writing isomorphic code that runs in both Lambda and browser
- When troubleshooting hydration mismatches
- When optimizing browser bundle size
- When determining what code can safely run in `src/lib/`

## Core Concepts

### The runtime() Entry Point

The `runtime()` function is the single entry point for the entire application.
It accepts a configuration object and handles both Lambda SSR and browser hydration:

```typescript
import { runtime } from '@worktif/runtime';
import { RuntimeRouter } from '@worktif/runtime';

import App from './App';

runtime({
  app: App,                    // React component (FC)
  router: myRouter,            // RuntimeRouter instance with route definitions
  config: {
    serviceName: 'my-app',
    stage: 'dev',
  },
  register: {                  // Microservice definitions (stripped from browser build)
    'users-api': usersService,
    'payments-api': paymentsService,
  },
});
```

**Key behavior:**
- In Lambda: Performs SSR using `renderToPipeableStream()`, registers microservices
- In browser: Hydrates the server-rendered HTML using `hydrateRoot()`
- The `register` property is automatically stripped from browser builds by the build plugin

### BrowserProviderStack CDK Deployment

`BrowserProviderStack` deploys SSR applications with Lambda functions for serverless
rendering, CloudFront distribution for content delivery, and optional API Gateway:

```typescript
import { RuntimeInfraStack, BrowserProviderStack } from '@worktif/runtime/infra';

const infraStack = new RuntimeInfraStack(app, 'MyApp-Infra', {
  stage: 'dev',
  serviceName: 'my-app',
});

new BrowserProviderStack(app, 'MyApp-Browser', {
  stage: 'dev',
  serviceName: 'my-app',
  appEntryPoint: './src/index.tsx',
  enableSeo: true,
  infraStack,
});
```

### Execution Context Detection

The framework auto-detects the execution context:

| Context | Detection | Behavior |
|---------|-----------|----------|
| Lambda (SSR) | `process.env.AWS_LAMBDA_FUNCTION_NAME` exists | Server-render React, register microservices |
| Browser | `typeof window !== 'undefined'` | Hydrate server HTML, attach event listeners |
| Local dev | `yarn purenow:start` on port 3000 | HMR-enabled development server |

## Instructions

### Isomorphic Code Constraint

Code in `src/lib/` MUST work in both Node.js Lambda AND browser environments.
This means:

1. **No direct browser API usage** — `window`, `document`, `localStorage`, `navigator`
   are NOT available in Lambda
2. **No direct Node.js API usage** — `fs`, `path`, `process.env` (beyond detection)
   are NOT available in browser
3. **Guard browser-only code** with `useEffect()` or `typeof window !== 'undefined'`

```typescript
// ✅ CORRECT: Isomorphic component
export function MyComponent() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Browser-only code runs AFTER hydration
    setMounted(true);
    const width = window.innerWidth;
  }, []);

  return <div>{/* Render same content on server and client */}</div>;
}
```

### Hydration Requirement

Server-rendered HTML MUST match client-rendered HTML exactly on initial render.
React compares the server HTML with what the client would render — mismatches
cause warnings and visual glitches.

**Rules:**
1. No conditional rendering based on `window` or `document` during initial render
2. No `typeof window !== 'undefined'` checks that change JSX output
3. Use `useEffect()` for any browser-dependent state changes (runs after hydration)
4. Data fetched on server must be serialized and available to client

### Browser Bundle Constraint

The browser bundle MUST be <500KB gzipped (performance target).

**Strategies to stay under budget:**
- The `register` property (microservice definitions) is stripped from browser builds
- AWS SDK, Inversify, and server-only code never reach the browser
- Use dynamic imports (`React.lazy()`) for large components
- Externalize React (provided as peer dependency by consuming apps)

### Build Commands for SSR

```bash
yarn cli:build:react    # Build browser bundle only
yarn cli:build:lambda   # Build Lambda handlers (includes SSR handler)
yarn cli:build          # Build all targets
```

### React Router Integration

The framework uses React Router 7.7+ for both SSR and client-side routing:

```typescript
import { RuntimeRouter } from '@worktif/runtime';

const router = new RuntimeRouter([
  { path: '/', element: <HomePage /> },
  { path: '/users', element: <UsersPage /> },
  { path: '/users/:id', element: <UserDetailPage /> },
]);

runtime({
  app: App,
  router,
  config: { serviceName: 'my-app', stage: 'dev' },
});
```

## Common Mistakes

### ❌ WRONG: Using window/document in component body without guards

```typescript
// ❌ window is undefined in Lambda SSR — this crashes the server
export function MyComponent() {
  const width = window.innerWidth;  // ❌ ReferenceError in Lambda
  return <div style={{ width }}>{/* ... */}</div>;
}
```

### ✅ CORRECT: Using useEffect for browser-only code

```typescript
export function MyComponent() {
  const [width, setWidth] = useState(1024);  // Default for SSR

  useEffect(() => {
    // ✅ Runs only in browser, after hydration
    setWidth(window.innerWidth);
  }, []);

  return <div style={{ width }}>{/* ... */}</div>;
}
```

### ❌ WRONG: Conditional rendering based on typeof window in initial render

```typescript
// ❌ Server renders null, client renders content → hydration mismatch
export function MyComponent() {
  if (typeof window === 'undefined') {
    return null;  // ❌ Server output differs from client
  }
  return <div>Client-only content</div>;
}
```

### ✅ CORRECT: Using state + useEffect for client-only content

```typescript
export function MyComponent() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);  // ✅ Triggers re-render after hydration
  }, []);

  // Initial render is the same on server and client (null)
  // After hydration, mounted becomes true and content appears
  if (!mounted) return null;
  return <div>Client-only content</div>;
}
```

### ❌ WRONG: Importing @core/* modules in isomorphic code (src/lib/)

```typescript
// ❌ @core/* is Lambda-only — breaks browser builds
// File: src/lib/components/UserProfile.tsx
import { S3StaticService } from '@core/services/aws/s3/s3.static';  // ❌ Build failure

export function UserProfile() {
  // ...
}
```

### ✅ CORRECT: Keeping src/lib/ free of @core/* imports

```typescript
// ✅ src/lib/ only imports from @lib/*, @utils/*, or relative paths
// File: src/lib/components/UserProfile.tsx
import { formatDate } from '@utils/common';  // ✅ Pure utility

export function UserProfile({ user }: { user: User }) {
  return <div>{formatDate(user.createdAt)}</div>;
}
```

### ❌ WRONG: Using localStorage in SSR-rendered components

```typescript
// ❌ localStorage is not available in Lambda
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = localStorage.getItem('theme') ?? 'light';  // ❌ Crashes in Lambda
  return <div className={theme}>{children}</div>;
}
```

### ✅ CORRECT: Reading localStorage after hydration

```typescript
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState('light');  // Default for SSR

  useEffect(() => {
    // ✅ Runs only in browser
    const saved = localStorage.getItem('theme');
    if (saved) setTheme(saved);
  }, []);

  return <div className={theme}>{children}</div>;
}
```

### ❌ WRONG: Different content on server vs client initial render

```typescript
// ❌ Server renders "Loading...", client renders date → mismatch
export function DateDisplay() {
  const date = typeof window !== 'undefined'
    ? new Date().toLocaleDateString()  // Client
    : 'Loading...';                     // Server ❌ Different content

  return <span>{date}</span>;
}
```

### ✅ CORRECT: Same initial render, update after hydration

```typescript
export function DateDisplay() {
  const [date, setDate] = useState<string | null>(null);

  useEffect(() => {
    setDate(new Date().toLocaleDateString());  // ✅ After hydration
  }, []);

  // Same output on server and client initial render
  return <span>{date ?? ''}</span>;
}
```

### ❌ WRONG: Bundling server-only code in the browser build

```typescript
// ❌ Importing AWS SDK in a component — bloats browser bundle
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';  // ❌ ~500KB added

export function DataComponent() {
  // This import is included in the browser bundle even if unused at runtime
}
```

### ✅ CORRECT: Keeping server-only imports in src/core/ or using register

```typescript
// ✅ Server-only code stays in src/core/ (never reaches browser)
// ✅ Or use the register property which is stripped from browser builds

// In src/lib/ components, fetch data via API calls instead:
export function DataComponent() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch('/api/data').then(r => r.json()).then(setData);  // ✅ API call
  }, []);

  return <div>{/* render data */}</div>;
}
```

## References

- [SSR Constraints](references/ssr-constraints.md) — Detailed hydration rules and bundle size requirements
- [runtime-concepts](../runtime-concepts/SKILL.md) (Layer 1: Concepts) — Multi-stack CDK architecture and framework scope
- [runtime-lifecycle](../runtime-lifecycle/SKILL.md) (Layer 1: Concepts) — Build commands and local development
- [runtime-api-core](../runtime-api-core/SKILL.md) (Layer 2: API) — MicroserviceDefinition for register property
- [runtime-constraints-and-guardrails](../runtime-constraints-and-guardrails/SKILL.md) (Layer 4: Guardrails) — Architecture boundaries
