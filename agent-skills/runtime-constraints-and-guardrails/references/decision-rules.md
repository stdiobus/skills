# Hard Decision Rules Reference

This document contains all hard decision rules for `@worktif/runtime`. Each rule
defines the ONLY correct response in a specific situation. AI agents MUST follow
these rules exactly — do NOT improvise alternatives.

## Rule Format

Each rule follows this structure:
- **Trigger**: The situation or consumer request that activates the rule
- **Response**: The ONLY correct action to take
- **Rationale**: Why this rule exists
- **Do NOT**: Explicitly forbidden alternatives

---

## Rule 1: Unsupported Feature Request

**Trigger:** A consumer asks for a feature, technology, or integration that is not
in the supported list (see NOT SUPPORTED list in SKILL.md).

**Response:**
1. State clearly that the requested feature is not supported by `@worktif/runtime`
2. Explain briefly why (outside framework scope, different compute model, etc.)
3. Suggest the closest supported alternative if one exists
4. If no alternative exists, state that the consumer would need a different framework

**Rationale:** Fabricating framework features leads to code that compiles but fails
at deployment or runtime. The consumer wastes time debugging non-existent APIs.

**Do NOT:**
- Invent framework APIs that do not exist
- Suggest "workarounds" that bypass the framework
- Say "it might work" for unsupported features
- Generate code using unsupported technologies

**Examples:**

| Consumer Request | Correct Response |
|-----------------|-----------------|
| "Add WebSocket support" | "WebSocket is not supported. For real-time, consider polling via HTTP endpoints or use EventBridge for async notifications." |
| "Deploy to GCP" | "Only AWS is supported. The framework requires Lambda, API Gateway, and CDK." |
| "Use GraphQL" | "Native GraphQL is not supported. Use HTTP endpoints with POST method to implement a GraphQL-like interface, or use AWS AppSync separately outside the framework." |
| "Use Vue.js for SSR" | "Only React is supported for SSR. The framework uses React Router and renderToPipeableStream." |

---

## Rule 2: Lambda Definition is the Only Option

**Trigger:** A consumer wants to define a Lambda function handler.

**Response:**
ALWAYS use `LambdaDefinition<TTies, TSnapshot, TIntegration>` from `@worktif/runtime`.
This is the ONLY supported way to define Lambda handlers in the framework.

**Rationale:** `LambdaDefinition` provides typed dependency injection via ties,
integration configuration, and framework lifecycle management. Raw handlers bypass
all framework features and break deployment.

**Do NOT:**
- Create custom handler wrapper functions
- Use raw AWS Lambda handler signatures (`exports.handler = async (event) => {}`)
- Bypass the framework with direct Lambda code
- Suggest "lightweight alternatives" to LambdaDefinition

**Correct pattern:**
```typescript
import { LambdaDefinition } from '@worktif/runtime';

type MyTies = { myService: MyService };

export const handler: LambdaDefinition<MyTies> = {
  id: 'my-handler',
  ties: { myService: MyService },
  handler: async (event, context) => {
    const result = await event.ties.myService.doSomething();
    return { statusCode: 200, body: JSON.stringify(result) };
  },
  http: { method: 'GET', path: '/endpoint' },
};
```

---

## Rule 3: Object-Based Ties Over Array-Based

**Trigger:** A consumer asks about ties (dependency injection) or you are generating
code that uses the ties pattern.

**Response:**
ALWAYS recommend and generate object-based ties. The array-based pattern is
deprecated and provides inferior type safety.

**Rationale:** Object-based ties provide full TypeScript type inference. The handler
receives `event.ties.serviceName` with the correct type. Array-based ties require
manual casting and provide no compile-time safety.

**Do NOT:**
- Generate array-based ties for new code
- Suggest array-based ties as "simpler"
- Mix array-based and object-based patterns in the same project
- Say "both work fine" — object-based is strictly superior

**Object-based (✅ ALWAYS use):**
```typescript
type MyTies = { userService: UsersService; orderService: OrdersService };

const handler: LambdaDefinition<MyTies> = {
  ties: { userService: UsersService, orderService: OrdersService },
  handler: async (event) => {
    // event.ties.userService is typed as UsersService
    // event.ties.orderService is typed as OrdersService
  },
};
```

**Array-based (❌ DEPRECATED):**
```typescript
const handler: LambdaDefinition = {
  ties: [UsersService, OrdersService],
  handler: (ties) => async (event) => {
    const userService = ties.userService as UsersService;  // Manual casting
  },
};
```

---

## Rule 4: AWS SDK v3 Only

**Trigger:** Code contains `import AWS from 'aws-sdk'`, `require('aws-sdk')`, or
any AWS SDK v2 import pattern.

**Response:**
Replace ALL v2 imports with the equivalent AWS SDK v3 modular imports. This is
non-negotiable.

**Rationale:** AWS SDK v2 is deprecated and creates 50MB+ bundles that exceed the
10MB Lambda limit. SDK v3 uses modular imports that include only the services used.

**Do NOT:**
- Keep v2 imports "temporarily"
- Suggest v2 "for compatibility"
- Mix v2 and v3 in the same project
- Say "v2 still works" — it breaks bundle size constraints

**Migration mapping:**

| SDK v2 | SDK v3 |
|--------|--------|
| `import AWS from 'aws-sdk'` | `import { S3Client } from '@aws-sdk/client-s3'` |
| `new AWS.S3()` | `new S3Client({})` |
| `new AWS.DynamoDB.DocumentClient()` | `DynamoDBDocumentClient.from(new DynamoDBClient({}))` |
| `new AWS.SQS()` | `new SQSClient({})` |
| `new AWS.EventBridge()` | `new EventBridgeClient({})` |
| `.promise()` | `client.send(new XxxCommand({}))` |

---

## Rule 5: Integration Type Limit (9 Types Only)

**Trigger:** A consumer asks for an integration type not in the 9 supported types,
or code references a non-existent integration property.

**Response:**
1. State that the requested integration type is not supported
2. List the 9 supported types: `http`, `sqs`, `eventbridge`, `s3`, `dynamodb`,
   `sns`, `kinesis`, `schedule`, `direct`
3. Suggest the closest supported alternative

**Rationale:** The framework's CDK infrastructure only creates event source mappings
for these 9 types. Any other type would have no deployment support.

**Do NOT:**
- Invent new integration properties on LambdaDefinition
- Suggest using `direct` as a workaround for unsupported integrations
- Generate code with non-existent config properties

**Closest alternatives:**

| Unsupported Request | Closest Alternative |
|--------------------|-------------------|
| WebSocket | HTTP endpoints with polling |
| Kafka/MSK | SQS (similar queue semantics) |
| IoT Core | EventBridge (event routing) |
| AppSync | HTTP with POST method |
| Cognito triggers | Direct invocation |
| CloudWatch Logs | EventBridge with CloudWatch as source |
| API Gateway WebSocket | Not possible — use a separate service |

---

## Rule 6: CDK L2/L3 Constructs Only

**Trigger:** Code uses L1 CloudFormation constructs (prefixed with `Cfn`, e.g.,
`CfnBucket`, `CfnFunction`, `CfnTable`).

**Response:**
Replace ALL L1 constructs with their L2/L3 equivalents. L1 constructs are raw
CloudFormation and bypass CDK's safety features.

**Rationale:** L2/L3 constructs provide sensible defaults, type-safe props,
grant methods for IAM, and integration with other constructs. L1 constructs
require manual configuration of every property and produce fragile infrastructure.

**Do NOT:**
- Use L1 constructs "for advanced configuration"
- Mix L1 and L2 constructs for the same resource
- Suggest L1 as "more flexible"

**Migration mapping:**

| L1 (❌ WRONG) | L2/L3 (✅ CORRECT) |
|--------------|-------------------|
| `CfnBucket` | `Bucket` |
| `CfnFunction` | `Function` / `NodejsFunction` |
| `CfnTable` | `Table` |
| `CfnQueue` | `Queue` |
| `CfnTopic` | `Topic` |
| `CfnRestApi` | `RestApi` / `HttpApi` |
| `CfnRole` | `Role` |
| `CfnPolicy` | `Policy` / `PolicyStatement` |

---

## Rule 7: Bundle Size Enforcement

**Trigger:** A new dependency is being added, or the Lambda bundle exceeds 10MB
after a build.

**Response:**
1. Check the package size: `npm info <package> dist.unpackedSize`
2. If >1MB: Add to `excludeDependencies` in `src/bin/deploy/cloud.build/esbuild.config.ts`
3. If AWS SDK: ALWAYS externalize (available in Lambda runtime)
4. Rebuild and verify: `.serverless/*.zip` MUST be <10MB
5. If still exceeded: Externalize more packages or use Lambda layers

**Rationale:** AWS rejects Lambda deployment packages exceeding 50MB uncompressed
(~10MB compressed). Exceeding this limit causes deployment failure with no workaround
other than reducing bundle size.

**Do NOT:**
- Ignore bundle size warnings
- Suggest increasing Lambda memory as a "fix" for bundle size
- Bundle AWS SDK v3 clients (they are pre-installed in Lambda runtime)
- Bundle packages >1MB without externalization

---

## Rule 8: Architecture Boundary Enforcement

**Trigger:** Code imports from a forbidden layer (e.g., `@core/*` in `src/lib/`,
`@lib/*` in `src/infra/`).

**Response:**
1. Identify the boundary violation
2. Move the shared code to the correct layer:
   - Shared types/utilities → `@utils/*`
   - Lambda-only logic → `@core/*`
   - Isomorphic logic → `@lib/*`
3. Update imports to use the correct path alias

**Rationale:** Architecture boundaries exist because code runs in different
environments. `src/lib/` runs in both Lambda AND browser — importing Node.js-only
code from `@core/*` crashes the browser build. `src/infra/` runs only during CDK
synthesis — importing runtime code creates circular dependencies.

**Do NOT:**
- Add `// @ts-ignore` to suppress boundary violations
- Create "bridge" modules that re-export across boundaries
- Suggest "it works in development" as justification
- Move CDK constructs into runtime code

---

## Rule 9: Path Alias Requirement

**Trigger:** Code uses relative imports (`../../`) to reference files in a different
directory.

**Response:**
Replace with the appropriate path alias:
- `@core/*` for `src/core/*`
- `@lib/*` for `src/lib/*`
- `@utils/*` for `src/utils/*`
- `@infra/*` for `src/infra/*`
- `@bin/*` for `src/bin/*`

**Rationale:** Relative imports break when files are moved or restructured. Path
aliases are resolved by the build system and provide stable, refactoring-safe imports.

**Do NOT:**
- Use relative imports for cross-directory references
- Create new path aliases without updating `tsconfig.json`
- Mix relative and alias imports for the same target

**Exception:** Relative imports within the same directory (`./helper.ts`, `./types.ts`)
are acceptable and preferred for co-located files.

---

## Rule 10: Isomorphic Code Safety

**Trigger:** Code in `src/lib/` uses `window`, `document`, `localStorage`,
`navigator`, `location`, or any other browser-only API without a guard.

**Response:**
1. Wrap browser-only code in a guard: `if (typeof window !== 'undefined') { ... }`
2. Or move browser-only logic into a `useEffect()` hook (for React components)
3. Or move the code to a browser-only module outside `src/lib/`

**Rationale:** All code in `src/lib/` executes during Lambda SSR (server-side
rendering). Browser APIs do not exist in Node.js. Unguarded access causes
`ReferenceError: window is not defined` crashes during SSR.

**Do NOT:**
- Use `window` or `document` in the module body of `src/lib/` files
- Conditionally render based on `typeof window` in the initial React render (causes hydration mismatch)
- Assume `src/lib/` code only runs in the browser
