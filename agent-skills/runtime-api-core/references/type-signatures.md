# Type Signatures Reference

Complete TypeScript type signatures for the core `@worktif/runtime` API surface.
All types, field names, and generic parameters match the actual public API exactly.

## MicroserviceDefinition\<TSnapshot\>

```typescript
/**
 * Microservice definition containing DI configuration and Lambda endpoints.
 *
 * A microservice is a logical grouping of related Lambda functions that share
 * a common DI container (PureContainer) for dependency injection.
 *
 * @template TSnapshot - Snapshot type from microservice init function (defaults to {})
 */
interface MicroserviceDefinition<TSnapshot = {}> {
  /**
   * Array of Ties class constructors for dependency injection.
   *
   * Each Ties class must implement a static register(container: PureContainer<string>)
   * method that registers services using container.tie(), container.tieConst(),
   * or container.tieSingleton().
   *
   * The framework creates a PureContainer instance for each microservice and
   * calls register() on each Ties class to build the DI container.
   */
  ties: TiesInstance[];

  /**
   * Optional initialization function executed during cold start.
   *
   * Executes once per Lambda execution environment (cold start only).
   * Result is cached and shared across all Lambda functions in the microservice
   * via event.snapshot.
   *
   * Execution order when both microservice and lambda init exist:
   *   1. Microservice init executes first
   *   2. Lambda init executes second
   *   3. Snapshots are merged (lambda-level takes precedence)
   */
  init?: InitFunction<Record<string, unknown>, TSnapshot>;

  /**
   * Array of Lambda endpoint definitions.
   *
   * Each definition describes one Lambda function with its dependencies,
   * handler logic, and integration configuration.
   */
  lambdas: Array<AnyLambdaDefinition>;
}
```

## LambdaDefinition\<TTies, TSnapshot, TIntegration\>

```typescript
/**
 * Lambda function definition with typed dependency injection.
 *
 * Supports two ties formats:
 * - Object-based (recommended): Full type safety via TiesConstructors<TTies>
 * - Array-based (legacy): Less type-safe, requires manual casting
 *
 * @template TTies - Instance types for handler access (default: any)
 * @template TSnapshot - Init function return type (default: {})
 * @template TIntegration - Integration kind determining event type (default: 'http')
 */
interface LambdaDefinition<
  TTies = any,
  TSnapshot = {},
  TIntegration extends IntegrationKind = 'http'
> {
  /**
   * Lambda identifier within the microservice.
   * Optional — auto-generated if omitted.
   * Final ID format: {serviceName}.{id}
   */
  id?: string;

  /**
   * Service name. Internal — auto-populated by framework during registration.
   * Do NOT set manually.
   */
  service?: string;

  /**
   * Dependencies definition using class constructors.
   *
   * Object-based (when TTies extends Record<string, any>):
   *   Type: TiesConstructors<TTies>
   *   Accepts class constructors, framework handles instantiation.
   *
   * Array-based (legacy):
   *   Type: Array<new (...args: unknown[]) => unknown>
   *   Array of class constructors, less type-safe.
   */
  ties: TTies extends Record<string, any>
    ? TiesConstructors<TTies>
    : Array<new (...args: unknown[]) => unknown>;

  /**
   * Cold-start initialization function.
   * Executes once per execution environment before first handler invocation.
   * Returns snapshot cached for warm invocations.
   */
  init?: InitFunction<TTies, TSnapshot>;

  /**
   * Handler function.
   *
   * Object-based ties: Direct async function (event, context) => Promise<unknown>
   *   event.ties provides TTies instances
   *   event.snapshot provides TSnapshot
   *   event base type determined by IntegrationEventMap[TIntegration]
   *
   * Array-based ties (legacy): Factory function (ties) => handler
   */
  handler: TTies extends Record<string, any>
    ? LambdaHandler<TTies, TSnapshot, IntegrationEventMap[TIntegration]>
    : LambdaHandlerFactory;

  /** HTTP integration configuration (API Gateway endpoint) */
  http?: HttpIntegration;

  /** SQS queue trigger configuration */
  sqs?: SqsIntegration;

  /** EventBridge rule trigger configuration */
  eventbridge?: EventBridgeIntegration;

  /** Scheduled task configuration (cron/rate) */
  schedule?: ScheduleIntegration;

  /** S3 bucket notification configuration */
  s3?: S3Integration;

  /** DynamoDB Streams trigger configuration */
  dynamodb?: DynamoDbStreamIntegration;

  /** SNS topic subscription configuration */
  sns?: SnsIntegration;

  /** Kinesis Data Streams trigger configuration */
  kinesis?: KinesisIntegration;

  /** Per-Lambda configuration overrides (memory, timeout, environment) */
  config?: LambdaConfig;
}
```

## InitFunction\<TTies, TSnapshot\>

```typescript
/**
 * Initialization function type for cold-start caching.
 *
 * Executes once per Lambda execution environment (cold start only).
 * Receives typed ties instances and returns a snapshot object that is
 * cached for all subsequent warm invocations.
 *
 * @template TTies - Type of the ties object containing DI instances
 * @template TSnapshot - Type of the snapshot object returned
 *
 * @param ties - Typed ties instances (same types as event.ties in handler)
 * @returns Promise resolving to the snapshot object
 */
type InitFunction<TTies, TSnapshot> = (ties: TTies) => Promise<TSnapshot>;
```

## LambdaEvent\<TTies, TSnapshot, TBaseEvent\>

```typescript
/**
 * Augmented Lambda event with typed dependencies and snapshot.
 *
 * Extends the base AWS event type with ties and snapshot properties.
 * The base event type is determined by the integration kind.
 *
 * @template TTies - Ties object type (instance types, not constructors)
 * @template TSnapshot - Snapshot type from init function
 * @template TBaseEvent - Base AWS event type (default: APIGatewayProxyEvent)
 */
type LambdaEvent<TTies, TSnapshot = {}, TBaseEvent = APIGatewayProxyEvent> =
  TBaseEvent & {
    /** Injected dependencies — fully typed instances */
    ties: TTies;
    /** Cached init function result from cold start */
    snapshot: TSnapshot;
  };
```

## LambdaHandler\<TTies, TSnapshot, TEvent\>

```typescript
/**
 * Lambda handler function type with typed dependencies and snapshot.
 *
 * @template TTies - Ties object type (instance types)
 * @template TSnapshot - Snapshot type from init function
 * @template TEvent - Base event type (default: APIGatewayProxyEvent)
 *
 * @param event - Augmented event: TEvent & { ties: TTies; snapshot: TSnapshot }
 * @param context - AWS Lambda context object
 * @returns Promise of the handler response
 */
type LambdaHandler<TTies, TSnapshot = {}, TEvent = APIGatewayProxyEvent> = (
  event: LambdaEvent<TTies, TSnapshot, TEvent>,
  context: Context,
) => Promise<unknown>;
```

## TiesConstructors\<T\>

```typescript
/**
 * Transforms an object of instance types to an object of constructor types.
 *
 * This is the key utility type enabling the ties type safety pattern.
 * It allows a single type definition (TTies) to serve two purposes:
 *   1. Define instance types for handler access (event.ties)
 *   2. Accept class constructors in the ties property
 *
 * @template T - Object type mapping property names to instance types
 * @returns Object type mapping same property names to constructor types
 *
 * Example transformation:
 *   Input:  { userService: UsersService; configService: ConfigService }
 *   Output: { userService: new (...args: any[]) => UsersService;
 *             configService: new (...args: any[]) => ConfigService }
 */
type TiesConstructors<T> = {
  [K in keyof T]: Constructor<T[K]>;
};
```

## Constructor\<T\>

```typescript
/**
 * Extracts the constructor type for a class.
 * Maps an instance type to its constructor type.
 *
 * @template T - The instance type to transform
 * @returns Constructor type that creates instances of T
 */
type Constructor<T> = new (...args: any[]) => T;
```

## LambdaHandlerFactory

```typescript
/**
 * Lambda handler factory function type (legacy array-based ties).
 *
 * Receives injected dependencies as a record and returns a Lambda handler.
 * Used with array-based ties where type safety is limited.
 *
 * @param ties - Object containing injected dependencies (camelCase keys)
 * @returns Lambda handler function
 */
type LambdaHandlerFactory = (
  ties: Record<string, unknown>,
) => (event: unknown, context: unknown) => Promise<unknown>;
```

## LambdaConfig

```typescript
/**
 * Lambda-specific configuration overrides.
 * All properties are optional and fall back to global defaults.
 */
interface LambdaConfig {
  /** Memory allocation in MB (128–10240). Default: global lambdaMemorySize. */
  memorySize?: number;

  /** Timeout in seconds (1–900). Default: global lambdaTimeout. */
  timeout?: number;

  /** Additional environment variables. Merged with global env vars. */
  environment?: Record<string, string>;
}
```

## TiesInstance\<T\>

```typescript
/**
 * Type for Ties class constructors used in MicroserviceDefinition.ties.
 *
 * Ties classes implement the register(container) pattern for DI registration.
 *
 * @template T - The type of the Ties class instance
 */
type TiesInstance<T = unknown> = new (...args: unknown[]) => T;
```

## AnyLambdaDefinition

```typescript
/**
 * Wildcard LambdaDefinition that accepts any integration kind.
 * Used in MicroserviceDefinition.lambdas where definitions with
 * different integration kinds coexist.
 */
type AnyLambdaDefinition = LambdaDefinition<any, any, any>;
```

## IntegrationEventMap

```typescript
/**
 * Maps each IntegrationKind to its corresponding AWS Lambda event type.
 * Determines the base event type for the handler function.
 */
interface IntegrationEventMap {
  http: APIGatewayProxyEvent;
  sqs: SQSEvent;
  eventbridge: EventBridgeEvent<string, unknown>;
  s3: S3Event;
  dynamodb: DynamoDBStreamEvent;
  sns: SNSEvent;
  kinesis: KinesisStreamEvent;
  schedule: ScheduledEvent;
  direct: any;
}
```

## IntegrationKind

```typescript
/**
 * Supported AWS event source integration kinds.
 * EXACTLY 9 values — no others exist.
 */
type IntegrationKind =
  | 'http'
  | 'sqs'
  | 'eventbridge'
  | 's3'
  | 'dynamodb'
  | 'sns'
  | 'kinesis'
  | 'schedule'
  | 'direct';
```

## Helper Types

```typescript
/** Extract ties type from a LambdaDefinition */
type ExtractTiesType<T> = T extends LambdaDefinition<infer TTies, any, any> ? TTies : never;

/** Extract snapshot type from a LambdaDefinition */
type ExtractSnapshotType<T> = T extends LambdaDefinition<any, infer TSnapshot, any> ? TSnapshot : never;

/** Create handler type from ties object */
type CreateHandlerType<TTies, TSnapshot = {}, TEvent = APIGatewayProxyEvent> =
  LambdaHandler<TTies, TSnapshot, TEvent>;
```

## Type Guards

```typescript
/** Check if ties is object-based format (recommended) */
function isObjectBasedTies(ties: any): ties is Record<string, new (...args: any[]) => any>;

/** Check if handler is direct function (object-based ties) */
function isDirectHandler<TTies>(handler: any): handler is LambdaHandler<TTies>;

/** Check if handler is factory function (array-based ties, legacy) */
function isFactoryHandler(handler: any): handler is LambdaHandlerFactory;
```
