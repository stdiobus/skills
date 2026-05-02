# SSR Constraints Reference

Detailed constraints, hydration rules, and bundle size requirements for server-side
rendering with `@worktif/runtime`.

## Isomorphic Code Constraints

### Directory Rules

| Directory | Environment | Browser APIs | Node.js APIs | AWS SDK |
|-----------|-------------|--------------|--------------|---------|
| `src/lib/` | Isomorphic | ❌ (without guard) | ❌ (without guard) | ❌ Never |
| `src/core/` | Lambda only | ❌ Never | ✅ Yes | ✅ Yes |
| `src/utils/` | Universal | ❌ Never | ❌ Never | ❌ Never |

### Forbidden in src/lib/ (Without Guards)

These APIs are NOT available in Lambda and will crash SSR:

- `window` — global browser object
- `document` — DOM access
- `localStorage` / `sessionStorage` — browser storage
- `navigator` — browser info
- `location` — URL info (use React Router instead)
- `history` — browser history (use React Router instead)
- `fetch` (in older Node.js) — use conditional import or polyfill
- `IntersectionObserver`, `ResizeObserver` — browser observers
- `requestAnimationFrame` — browser rendering
- `matchMedia` — CSS media queries
- `crypto.subtle` — Web Crypto API (different from Node.js crypto)

### Safe Guard Patterns

**Pattern 1: useEffect (recommended for React components)**

```typescript
import { useState, useEffect } from 'react';

export function MyComponent() {
  const [value, setValue] = useState<string>('');

  useEffect(() => {
    // This code runs ONLY in the browser, AFTER hydration
    setValue(localStorage.getItem('key') ?? 'default');
  }, []);

  return <div>{value}</div>;
}
```

**Pattern 2: typeof window check (for non-React utility code)**

```typescript
export function getViewportWidth(): number {
  if (typeof window === 'undefined') {
    return 1024;  // Default for SSR
  }
  return window.innerWidth;
}
```

**Pattern 3: Dynamic import (for large browser-only libraries)**

```typescript
export function MyComponent() {
  const [Chart, setChart] = useState<React.ComponentType | null>(null);

  useEffect(() => {
    import('chart-library').then(mod => setChart(() => mod.Chart));
  }, []);

  if (!Chart) return <div>Loading chart...</div>;
  return <Chart data={data} />;
}
```

## Hydration Rules

### The Fundamental Rule

> Server-rendered HTML MUST match client-rendered HTML exactly on the initial render.

React hydration attaches event listeners to existing server HTML. If the HTML
differs, React must discard the server HTML and re-render from scratch, causing:
- Visual flash (content disappears and reappears)
- Console warnings in development
- Performance degradation (defeats the purpose of SSR)
- Potential state loss

### What Causes Hydration Mismatches

| Cause | Example | Fix |
|-------|---------|-----|
| Date/time rendering | `new Date().toLocaleString()` | Use `useEffect` to set after mount |
| Random values | `Math.random()` | Generate on server, serialize to client |
| Browser detection | `navigator.userAgent` | Use `useEffect` |
| Window dimensions | `window.innerWidth` | Use `useEffect` with default |
| localStorage reads | `localStorage.getItem('x')` | Use `useEffect` |
| Conditional on `typeof window` | `typeof window !== 'undefined' ? A : B` | Use state + `useEffect` |

### Hydration-Safe Patterns

**Pattern: Deferred client-only content**

```typescript
function ClientOnly({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Server and client both render null initially
  // After hydration, mounted becomes true
  return mounted ? <>{children}</> : null;
}

// Usage:
<ClientOnly>
  <BrowserOnlyWidget />
</ClientOnly>
```

**Pattern: Serialized server data**

```typescript
// Server provides data that client reuses (no mismatch)
function DataComponent({ serverData }: { serverData: Data }) {
  // Use server-provided data for initial render (matches server HTML)
  const [data, setData] = useState(serverData);

  useEffect(() => {
    // Optionally refresh data after hydration
    fetchFreshData().then(setData);
  }, []);

  return <div>{data.value}</div>;
}
```

### What is Safe During Initial Render

- Static JSX content
- Props passed from parent components
- Data from React Router loaders (serialized from server)
- Constants and computed values from props
- CSS classes and inline styles (if deterministic)

### What is NOT Safe During Initial Render

- Any value derived from browser APIs
- Any value that differs between server and client environments
- Timestamps (server time ≠ client time)
- Random numbers (different seeds)
- User agent detection
- Screen/viewport dimensions

## Browser Bundle Size Constraints

### Hard Limit

**Browser bundle MUST be <500KB gzipped** (performance target).

### What is Included in the Browser Bundle

- React components from `src/lib/`
- React Router configuration
- Utility functions from `src/utils/`
- CSS and static assets
- Third-party UI libraries

### What is Excluded from the Browser Bundle

- `register` property contents (stripped by `browserRegisterStripPlugin`)
- AWS SDK clients (never imported in `src/lib/`)
- Inversify DI container (Lambda-only)
- `src/core/` code (Lambda-only)
- `aws-cdk-lib` (CDK-only)

### Bundle Size Optimization Strategies

1. **Dynamic imports** for large components:
   ```typescript
   const HeavyComponent = React.lazy(() => import('./HeavyComponent'));
   ```

2. **Tree-shaking** — use named imports, avoid barrel re-exports of large modules

3. **Externalize React** — React is a peer dependency, not bundled

4. **Avoid large utility libraries** — prefer focused packages over lodash-style bundles

5. **Check bundle size after changes**:
   ```bash
   yarn cli:build:react
   # Check output size in build report
   ```

### Bundle Analysis

If the bundle exceeds 500KB gzipped:

1. Check for accidental `@core/*` imports in `src/lib/`
2. Check for AWS SDK imports in isomorphic code
3. Look for large dependencies that should be dynamically imported
4. Verify the `browserRegisterStripPlugin` is removing server code

## SSR Rendering Pipeline

SSR is deployed via **BrowserProviderStack** (not RuntimeWebStack). BrowserProviderStack
creates the Lambda functions, CloudFront distribution, and optional API Gateway needed
for server-side rendering.

### Server-Side (Lambda)

1. Lambda receives HTTP request from API Gateway
2. Check S3 cache for pre-rendered HTML (cache hit → return immediately)
3. If cache miss: render React app using `renderToPipeableStream()`
4. React Router resolves the route and loads data
5. HTML is streamed, stored in S3 cache, and returned to client
6. Response includes serialized data for client hydration

### Client-Side (Browser)

1. Browser receives server-rendered HTML (visible immediately)
2. Browser downloads and executes the JavaScript bundle
3. `runtime()` detects browser context and calls `hydrateRoot()`
4. React attaches event listeners to existing DOM (no re-render if HTML matches)
5. Application becomes interactive

### Performance Targets

| Metric | Target | Measured By |
|--------|--------|-------------|
| TTFB (cache hit) | <200ms | CloudFront → S3 → client |
| TTFB (cache miss) | <2s | CloudFront → Lambda SSR → client |
| SSR render time | <500ms | Lambda execution duration |
| Time to Interactive | <3s | Bundle download + hydration |
| Browser bundle | <500KB gzipped | Build output size |

## Error Handling in SSR

### Server-Side Errors

- Use React Error Boundaries to catch rendering errors
- Return 500 status with fallback HTML on unrecoverable errors
- Log errors to CloudWatch for debugging

### Client-Side Errors

- Error Boundaries prevent full app crashes
- Fallback UI shown for failed components
- Errors logged to monitoring service

### Hydration Errors

- React logs warnings in development mode
- In production, React silently recovers by re-rendering
- Monitor for hydration warnings during development
- Fix all hydration warnings before deploying to production
