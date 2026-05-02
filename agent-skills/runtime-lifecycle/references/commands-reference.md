# Commands Reference

Complete catalog of build, development, test, and deployment commands for `@worktif/runtime`.

## Build Commands

### `yarn build`

Full build pipeline. Executes all build steps in the correct order.

**What it does:**
1. Cleans `.docs/` and regenerates documentation
2. Cleans `dist/` and `out/` directories
3. Builds Lambda handlers (`cli:build`)
4. Builds CDK infrastructure (`cli:build:infra`)
5. Builds CLI (`cli:build:cli`)
6. Builds worker process (`cli:build:worker`)
7. Builds bin entry point (`cli:build:bin`)
8. Builds pipelines Lambda (`cli:build:pipelines:lambda`)
9. Copies templates
10. Generates TypeScript declarations (`types`)
11. Generates lib types

**When to use:** Before deployment, before publishing, or when you need all artifacts fresh.

**Expected output:** Populated `out/dist/` directory with all compiled artifacts.

---

### `yarn cli:build:lambda`

Builds Lambda handler bundles only.

**What it does:**
1. Compiles esbuild config
2. Bundles Lambda handlers with esbuild (Node18, CommonJS)
3. Externalizes AWS SDK v3, Node.js builtins, and large dependencies

**When to use:** When iterating on Lambda handler code without rebuilding everything.

**Expected output:** `.serverless/*.zip` files. Each MUST be <10MB compressed.

**Verification:** Check `.serverless/*.zip` file sizes after running.

---

### `yarn cli:build:react`

Builds browser bundle only.

**What it does:**
1. Compiles esbuild config
2. Bundles browser code with esbuild (ES2020, ESM)
3. Bundles all dependencies except React (peer dependency)

**When to use:** When iterating on SSR React components or browser-side code.

**Expected output:** Browser assets. Target: <500KB gzipped.

---

### `yarn cli:build:cdk`

Builds CDK infrastructure code only.

**What it does:**
1. Compiles esbuild config
2. Bundles CDK code
3. Externalizes `aws-cdk-lib` and `constructs`

**When to use:** When modifying CDK stacks or constructs.

**Expected output:** Compiled CDK code ready for `cdk synth` or `cdk deploy`.

---

### `yarn types`

Generates TypeScript declaration files (.d.ts).

**What it does:**
1. Runs `tsc --emitDeclarationOnly` to generate declarations
2. Runs `tsc-alias` to resolve path aliases in compiled output

**When to use:** After modifying any public API exports (from `src/index.tsx` or `src/infra/index.ts`).

**Expected output:** `.d.ts` files in `out/dist/`.

**IMPORTANT:** Always run this after changing exported types, interfaces, or functions.

---

### `yarn cli:build`

Builds Lambda + React + CDK bundles (without types or docs).

**What it does:** Runs the esbuild-based bundler for all runtime targets.

**When to use:** Quick rebuild of all bundles without regenerating types or docs.

---

### `yarn cli:build:infra`

Builds CDK infrastructure target specifically.

**What it does:** Compiles and bundles the CDK infrastructure code.

---

## Development Commands

### `yarn purenow:start`

Starts the local development server.

**Port:** 3000
**Features:** Hot Module Replacement (HMR) enabled

**When to use:** During local development and testing of SSR React pages.

---

## Test Commands

### `yarn test`

Runs all tests.

**What it does:** Executes Jest with `--runInBand --colors --verbose --testTimeout=20000`.

**Test locations:** `src/**/__tests__/*.test.ts`

---

### `yarn test:infra`

Runs infrastructure tests only.

**What it does:** Executes Jest targeting `src/infra/__tests__/` directory.

**When to use:** When modifying CDK stacks or constructs.

---

### `yarn test:coverage`

Runs all tests with coverage report.

**What it does:** Executes Jest with `--coverage` flag.

**When to use:** Before submitting changes to verify test coverage.

---

### `yarn test:watch`

Runs tests in watch mode.

**What it does:** Executes Jest with `--watch` flag for continuous testing during development.

---

## Deployment Commands

### `yarn deploy:dev`

Builds and deploys to the dev stage.

**What it does:**
1. Runs full `yarn build`
2. Runs `cdk deploy --context stage=dev --context serviceName=runtime`

---

### `yarn deploy:staging`

Builds and deploys to the staging stage.

**What it does:**
1. Runs full `yarn build`
2. Runs `cdk deploy --context stage=staging --context serviceName=runtime`

---

### `yarn deploy:prod`

Builds and deploys to the production stage.

**What it does:**
1. Runs full `yarn build`
2. Runs `cdk deploy --context stage=prod --context serviceName=runtime`

**CAUTION:** Production deployment. Verify all tests pass and bundle sizes are within limits before running.

---

### `yarn deploy`

Generic deploy (all stacks).

**What it does:**
1. Runs full `yarn build`
2. Runs `cdk deploy --all`

---

## Lint Commands

### `yarn lint`

Checks for linting issues.

**Scope:** `src/**/*.{ts,tsx,js,jsx}`

---

### `yarn lint:fix`

Auto-fixes linting issues.

**Scope:** `src/**/*.{ts,tsx,js,jsx}`

---

## Documentation Commands

### `yarn docs`

Generates both Markdown and HTML documentation.

**What it does:** Runs `docs:md` then `docs:html` using TypeDoc.

---

### `yarn docs:md`

Generates Markdown documentation.

**Config:** `docs/docs.config/typedoc.md.json`

---

### `yarn docs:html`

Generates HTML documentation.

**Config:** `docs/docs.config/typedoc.html.json`

---

## CLI Commands (Runtime CLI)

The framework provides a CLI accessible via `npx runtime` or the `runtime` bin:

| Command | Description |
|---------|-------------|
| `npx runtime dev` | Start development server |
| `npx runtime build` | Build all targets |
| `npx runtime deploy --stage <stage>` | Deploy to AWS |
| `npx runtime seo sync` | Sync SEO metadata to DynamoDB |
| `npx runtime stacks list` | List CloudFormation stacks |
| `npx runtime cache-clear` | Invalidate CloudFront cache |
| `npx runtime doctor` | Environment diagnostics |

---

## Build Order for Deployment

The correct sequence for a full deployment:

```bash
# Option A: Use the all-in-one command
yarn build
cdk deploy --all

# Option B: Step by step
yarn types              # 1. Generate type declarations
yarn cli:build:lambda   # 2. Bundle Lambda handlers (verify <10MB)
yarn cli:build:react    # 3. Bundle browser assets (if using SSR)
yarn cli:build:cdk      # 4. Compile CDK infrastructure
cdk deploy --all        # 5. Deploy all stacks
```

## Post-Build Verification

After any build, verify these constraints:

| Check | Command | Constraint |
|-------|---------|-----------|
| Lambda bundle size | Check `.serverless/*.zip` | <10MB compressed |
| Browser bundle size | Check build output | <500KB gzipped |
| Type declarations | Check `out/dist/*.d.ts` | Files exist and are current |
| No SDK v2 | Search for `aws-sdk` imports | Must not exist |
