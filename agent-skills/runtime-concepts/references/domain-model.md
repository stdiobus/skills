# Domain Model: Entity Relationships and Type Mappings

## Entity Hierarchy

```
MicroserviceDefinition<TSnapshot>
├── ties: TiesInstance[]                    (array of class constructors for service registration)
├── init?: InitFunction<Record<string, unknown>, TSnapshot>   (cold-start initialization)
└── lambdas: AnyLambdaDefinition[]          (array of Lambda function definitions)
        │
        └── LambdaDefinition<TTies, TSnapshot, TIntegration>
            ├── id?: string                 (unique within microservice)
            ├── ties: TiesConstructors<TTies>  (object of class constructors)
            ├── init?: InitFunction<TTies, TSnapshot>  (lambda-level cold-start)
            ├── handler: LambdaHandler<TTies, TSnapshot, IntegrationEventMap[TIntegration]>
            ├── http?: HttpIntegration
            ├── sqs?: SqsIntegration
            ├── eventbridge?: EventBridgeIntegration
            ├── schedule?: ScheduleIntegration
            ├── s3?: S3Integration
            ├── dynamodb?: DynamoDbStreamIntegration
            ├── sns?: SnsIntegration
            ├── kinesis?: KinesisIntegration
            └── config?: LambdaConfig
```

## Core Type Definitions

### MicroserviceDefinition

```typescript
interface MicroserviceDefinition<TSnapshot = {}> {
  ties: TiesInstance[];
  init?: InitFunction<Record<string, unknown>, TSnapshot>;
  lambdas: Array<AnyLambdaDefinition>;
}
```

- `TiesInstance<T>` = `new (...args: unknown[]) => T` — a class constructor
- `ties` is an array of Ties classes that implement the `register(container)` pattern
- `init` receives a generic ties object and returns a snapshot cached for warm invocations
- `lambdas` accepts any LambdaDefinition regardless of integration kind

### LambdaDefinition

```typescript
interface LambdaDefinition<TTies = any, TSnapshot = {}, TIntegration extends IntegrationKind = 'http'> {
  id?: string;
  service?: string;  // Auto-set by framework
  ties: TTies extends Record<string, any> ? TiesConstructors<TTies> : Array<new (...args: unknown[]) => unknown>;
  init?: InitFunction<TTies, TSnapshot>;
  handler: TTies extends Record<string, any>
    ? LambdaHandler<TTies, TSnapshot, IntegrationEventMap[TIntegration]>
    : LambdaHandlerFactory;
  http?: HttpIntegration;
  sqs?: SqsIntegration;
  eventbridge?: EventBridgeIntegration;
  schedule?: ScheduleIntegration;
  s3?: S3Integration;
  dynamodb?: DynamoDbStreamIntegration;
  sns?: SnsIntegration;
  kinesis?: KinesisIntegration;
  config?: LambdaConfig;
}
```

### Type Transformation: TiesConstructors

```typescript
type Constructor<T> = new (...args: any[]) => T;
type TiesConstructors<T> = { [K in keyof T]: Constructor<T[K]> };
```

This transformation enables the pattern where:
- Generic parameter `TTies` defines **instance types** (what the handler receives)
- The `ties` property accepts **constructor types** (the classes themselves)
- `event.ties` provides the original **instance types** with full IntelliSense

### LambdaEvent

```typescript
type LambdaEvent<TTies, TSnapshot = {}, TBaseEvent = APIGatewayProxyEvent> = TBaseEvent & {
  ties: TTies;
  snapshot: TSnapshot;
};
```

The handler event is the base AWS event (determined by IntegrationKind) augmented with:
- `ties` — typed service instances from the ties container
- `snapshot` — cached result from init functions

### InitFunction

```typescript
type InitFunction<TTies, TSnapshot> = (ties: TTies) => Promise<TSnapshot>;
```

- Receives typed ties instances
- Returns a snapshot object cached for warm invocations
- Executes exactly once per Lambda execution environment (cold start only)

## Integration Kind → Event Type Mapping

Each IntegrationKind maps to a specific AWS Lambda event type:

| IntegrationKind | AWS Event Type | Config Interface |
|-----------------|---------------|------------------|
| `'http'` | `APIGatewayProxyEvent` | `HttpIntegration` |
| `'sqs'` | `SQSEvent` | `SqsIntegration` |
| `'eventbridge'` | `EventBridgeEvent<string, unknown>` | `EventBridgeIntegration` |
| `'s3'` | `S3Event` | `S3Integration` |
| `'dynamodb'` | `DynamoDBStreamEvent` | `DynamoDbStreamIntegration` |
| `'sns'` | `SNSEvent` | `SnsIntegration` |
| `'kinesis'` | `KinesisStreamEvent` | `KinesisIntegration` |
| `'schedule'` | `ScheduledEvent` | `ScheduleIntegration` |
| `'direct'` | `any` | (none) |

This mapping is defined in `IntegrationEventMap` and used by the type system to
automatically type the handler's event parameter based on which integration config
property is set.

## CDK Stack Relationships

The framework uses a multi-stack CDK architecture with 3 core stacks and 1 optional stack.
All stacks support the `platformName` prop for multi-platform resource isolation.

```
RuntimeInfraStack (base infrastructure)
├── staticBucket: s3.Bucket              (static assets + cache)
├── lambdaRole: iam.Role                 (Lambda execution role)
├── seoTable?: dynamodb.Table            (optional SEO metadata)
└── s3Origin: S3StaticWebsiteOrigin      (CloudFront origin)
        │
        ├─── (cross-stack reference via infraStack prop)
        │    ▼
        │  BrowserProviderStack (SSR deployment, optional)
        │  ├── runtimeLambda: lambda.Function       (SSR rendering handler)
        │  ├── distribution: cloudfront.Distribution (global content delivery)
        │  ├── apiGateway?: apigatewayv2.HttpApi     (HTTP routing to Lambda)
        │  └── warmupRule?: events.Rule              (Lambda warmup schedule)
        │
        └─── (cross-stack reference via infraStack prop)
             ▼
           RuntimeWebStack (microservices deployment)
           ├── register: Record<string, MicroserviceDefinition>  (service definitions)
           ├── Lambda functions (created from LambdaDefinitions)
           ├── API Gateway routes (HTTP API or REST API)
           └── Event source mappings (SQS, EventBridge, S3, DynamoDB, SNS, Kinesis, Schedule)

RuntimeAwakeStack (optional, local debugging)
├── sessionTable: dynamodb.Table         (developer session registry with TTL)
├── payloadBucket: s3.Bucket             (large payload storage, lifecycle rules)
└── developerPolicies: IoT policies      (per-developer isolation)
    │
    └─── (referenced by RuntimeWebStack via runtimeAwake prop)
```

**RuntimeInfraStack** is the base layer containing slow-changing infrastructure resources
(S3 bucket, IAM role, optional SEO DynamoDB table, S3 origin for CloudFront). Both
BrowserProviderStack and RuntimeWebStack depend on it via the `infraStack` prop for
cross-stack references.

**BrowserProviderStack** handles SSR deployment. It creates Lambda functions for
server-side rendering, a CloudFront distribution for content delivery, an optional
API Gateway for HTTP routing, and an optional Lambda warmup rule. This stack is
optional — only needed when the application uses SSR React.

**RuntimeWebStack** handles microservices deployment. It creates Lambda functions from
`MicroserviceDefinition` registrations, API Gateway routes (HTTP API or REST API),
and event source mappings for async integrations (SQS, EventBridge, S3, DynamoDB
Streams, SNS, Kinesis, Schedule).

**RuntimeAwakeStack** is an independent optional stack for local debugging via AWS IoT
Core MQTT. It creates a DynamoDB session table, an S3 payload bucket, and IoT policies
for developer isolation. RuntimeWebStack can reference it via the `runtimeAwake.runtimeAwakeStack`
prop to enable proxy Lambda functions for local debugging.

## Ties Registration Pattern

Ties classes implement the service registration pattern:

```typescript
class PaymentsTies {
  static register(container: PureContainer<string>) {
    container.tie('paymentService', PaymentService, []);
    container.tie('billingService', BillingService, ['paymentService']);
  }
}
```

The framework:
1. Creates a `PureContainer` instance per microservice
2. Calls `register()` on each Ties class in the `ties` array
3. Resolves dependencies when a Lambda is invoked
4. Provides typed instances to the handler via `event.ties`

## Init Function Execution Order

When both microservice-level and lambda-level init exist:

1. Microservice `init` executes first (shared across all lambdas)
2. Lambda-level `init` executes second (specific to one lambda)
3. Snapshots are merged with lambda-level taking precedence

## Cross-References

- See [runtime-api-core](../runtime-api-core/SKILL.md) (Layer 2: API) for complete type signatures with field-by-field semantics
- See [runtime-api-integrations](../runtime-api-integrations/SKILL.md) (Layer 2: API) for per-integration configuration interfaces with valid value ranges
- See [runtime-lifecycle](../runtime-lifecycle/SKILL.md) (Layer 1: Concepts) for the consumer lifecycle from init through deployment
