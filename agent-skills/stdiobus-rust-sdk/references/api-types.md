# API Types Reference

Complete type definitions for the stdio Bus Rust SDK.

## Core Types

### BusConfig

```rust
/// stdio_bus JSON configuration.
/// Primary way to configure the bus programmatically.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BusConfig {
    /// Worker pool definitions (at least one required)
    pub pools: Vec<PoolConfig>,
    /// Operational limits (optional, C bus applies defaults)
    pub limits: Option<LimitsConfig>,
}

impl BusConfig {
    /// Validate the configuration. Returns Ok(()) if valid.
    pub fn validate(&self) -> Result<(), String>;
    /// Serialize to JSON string.
    pub fn to_json(&self) -> serde_json::Result<String>;
}
```

### PoolConfig

```rust
/// Worker pool configuration.
/// Matches the C bus JSON schema: pools[].{id, command, args, instances}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolConfig {
    /// Unique pool identifier
    pub id: String,
    /// Executable path
    pub command: String,
    /// Command-line arguments (default: empty)
    pub args: Vec<String>,
    /// Number of worker instances (must be >= 1)
    pub instances: u32,
}
```

### LimitsConfig

```rust
/// Operational limits. All fields optional — C bus applies defaults for omitted values.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LimitsConfig {
    /// Per-connection input buffer limit in bytes
    pub max_input_buffer: Option<usize>,
    /// Per-connection output queue limit in bytes
    pub max_output_queue: Option<usize>,
    /// Max restarts within time window
    pub max_restarts: Option<u32>,
    /// Restart counting window in seconds
    pub restart_window_sec: Option<u32>,
    /// Graceful shutdown timeout in seconds
    pub drain_timeout_sec: Option<u32>,
    /// Backpressure timeout in seconds
    pub backpressure_timeout_sec: Option<u32>,
}
```

### ConfigSource

```rust
/// Configuration source for the bus. Exactly one variant is used.
#[derive(Debug, Clone)]
pub enum ConfigSource {
    /// Path to a JSON config file on disk
    Path(String),
    /// Typed configuration object (primary, recommended)
    Config(BusConfig),
}
```

### BackendMode

```rust
/// Backend mode selection
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BackendMode {
    /// Auto-select: native on Unix (if available), docker otherwise
    #[default]
    Auto,
    /// Force native backend (requires libstdio_bus)
    Native,
    /// Force Docker backend
    Docker,
}
```

### BusState

```rust
/// State of the stdio_bus instance
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum BusState {
    Created = 0,   // Created but not started
    Starting = 1,  // Workers being spawned
    Running = 2,   // Running and accepting messages
    Stopping = 3,  // Graceful shutdown in progress
    Stopped = 4,   // Fully stopped
}

impl BusState {
    pub fn accepts_messages(&self) -> bool;  // true only for Running
    pub fn can_start(&self) -> bool;         // true for Created | Stopped
    pub fn can_stop(&self) -> bool;          // true for Running | Starting
}
```

### BusStats

```rust
/// Runtime statistics
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BusStats {
    pub messages_in: u64,        // Messages sent to workers
    pub messages_out: u64,       // Messages received from workers
    pub bytes_in: u64,           // Total bytes sent
    pub bytes_out: u64,          // Total bytes received
    pub worker_restarts: u64,    // Number of worker restarts
    pub routing_errors: u64,     // Messages that couldn't be routed
    pub client_connects: u64,    // Client connections (TCP/Unix modes)
    pub client_disconnects: u64, // Client disconnections
}
```

### RequestOptions

```rust
/// Options for individual requests
#[derive(Debug, Clone, Default)]
pub struct RequestOptions {
    pub timeout: Option<Duration>,
    pub session_id: Option<String>,
    pub agent_id: Option<String>,
    pub idempotency_key: Option<String>,
    pub required_extensions: Vec<String>,
}

impl RequestOptions {
    pub fn with_timeout(timeout: Duration) -> Self;
    pub fn session_id(mut self, session_id: impl Into<String>) -> Self;
    pub fn agent_id(mut self, agent_id: impl Into<String>) -> Self;
    pub fn idempotency_key(mut self, key: impl Into<String>) -> Self;
    pub fn require_extension(mut self, extension: impl Into<String>) -> Self;
}
```

### DockerOptions

```rust
/// Docker backend options
#[derive(Debug, Clone)]
pub struct DockerOptions {
    pub image: String,                    // Default: "stdiobus/stdiobus:node20"
    pub pull_policy: String,              // "never" | "if-missing" | "always"
    pub engine_path: String,              // Default: "docker"
    pub startup_timeout: Duration,        // Default: 15s
    pub container_name_prefix: String,    // Default: "stdiobus"
    pub extra_args: Vec<String>,          // Extra docker run arguments
    pub env: HashMap<String, String>,     // Environment variables
}
```

## JSON-RPC Types

### JsonRpcRequest

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,                    // Always "2.0"
    pub id: Option<Value>,                  // None for notifications
    pub method: String,
    pub params: Option<Value>,
    pub session_id: Option<String>,         // Serialized as "sessionId"
    pub agent_id: Option<String>,           // Serialized as "agentId"
    pub extensions: Option<Value>,          // Serialized as "_ext"
}

impl JsonRpcRequest {
    pub fn new(method: impl Into<String>, params: Option<Value>) -> Self;
    pub fn notification(method: impl Into<String>, params: Option<Value>) -> Self;
    pub fn with_session_id(mut self, session_id: impl Into<String>) -> Self;
    pub fn with_agent_id(mut self, agent_id: impl Into<String>) -> Self;
    pub fn with_extensions(mut self, extensions: Value) -> Self;
    pub fn is_notification(&self) -> bool;
}
```

### JsonRpcResponse

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: Value,
    pub result: Option<Value>,
    pub error: Option<JsonRpcError>,
    pub session_id: Option<String>,
    pub extensions: Option<Value>,
}

impl JsonRpcResponse {
    pub fn success(id: Value, result: Value) -> Self;
    pub fn error(id: Value, error: JsonRpcError) -> Self;
    pub fn is_error(&self) -> bool;
}
```

### JsonRpcError

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    pub data: Option<Value>,
}

impl JsonRpcError {
    pub fn parse_error() -> Self;       // -32700
    pub fn invalid_request() -> Self;   // -32600
    pub fn method_not_found() -> Self;  // -32601
    pub fn internal_error() -> Self;    // -32603
}
```

## Error Types

### Error

```rust
#[derive(Error, Debug)]
pub enum Error {
    InvalidArgument { message: String },
    InvalidState { expected: String, actual: String },
    Timeout { timeout_ms: u64 },
    Cancelled,
    TransportError { message: String },
    NegotiationFailed { message: String },
    ExtensionUnavailable { extension: String },
    PolicyDenied { message: String },
    InternalError { message: String },
    ResourceExhausted { resource: String },
    Json(serde_json::Error),
    Io(std::io::Error),
}

impl Error {
    pub fn code(&self) -> ErrorCode;
    pub fn is_retryable(&self) -> bool;  // true for Timeout, TransportError, ResourceExhausted
}
```

### ErrorCode

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(i32)]
pub enum ErrorCode {
    InvalidArgument = -1,
    InvalidState = -2,
    Timeout = -3,
    Cancelled = -4,
    TransportError = -5,
    NegotiationFailed = -6,
    ExtensionUnavailable = -7,
    PolicyDenied = -8,
    InternalError = -9,
    ResourceExhausted = -10,
}
```

## Identity & Extensions

### Identity

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Identity {
    pub subject_id: String,     // Serialized as "subjectId"
    pub role: String,
    pub asserted_by: String,    // Serialized as "assertedBy"
}

impl Identity {
    pub fn self_asserted(subject_id: impl Into<String>, role: impl Into<String>) -> Self;
}
```

### Extensions

```rust
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Extensions {
    pub extensions: HashMap<String, ExtensionInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionInfo {
    pub version: String,
    pub required: bool,
    pub active: bool,
}

impl ExtensionInfo {
    pub fn new(version: impl Into<String>) -> Self;
    pub fn required(mut self) -> Self;
}
```

## StdioBus Client

### StdioBusBuilder

```rust
#[derive(Debug, Clone)]
pub struct StdioBusBuilder { /* ... */ }

impl StdioBusBuilder {
    pub fn new() -> Self;
    pub fn config(mut self, config: BusConfig) -> Self;
    pub fn config_path(mut self, path: impl Into<String>) -> Self;
    pub fn backend(mut self, mode: BackendMode) -> Self;
    pub fn backend_auto(mut self) -> Self;
    pub fn backend_native(mut self) -> Self;
    pub fn backend_docker(mut self) -> Self;
    pub fn timeout(mut self, timeout: Duration) -> Self;
    pub fn docker_options(mut self, options: DockerOptions) -> Self;
    pub fn docker_image(mut self, image: impl Into<String>) -> Self;
    pub fn docker_pull_policy(mut self, policy: impl Into<String>) -> Self;
    pub fn build(self) -> Result<StdioBus>;
}
```

### StdioBus

```rust
pub struct StdioBus { /* ... */ }

impl StdioBus {
    pub fn builder() -> StdioBusBuilder;
    pub fn client_session_id(&self) -> &str;

    // Lifecycle
    pub async fn start(&self) -> Result<()>;
    pub async fn stop(&self) -> Result<()>;
    pub async fn stop_with_timeout(&self, timeout_secs: u32) -> Result<()>;

    // Messaging
    pub async fn request(&self, method: &str, params: Value) -> Result<Value>;
    pub async fn request_with_options(&self, method: &str, params: Value, options: RequestOptions) -> Result<Value>;
    pub async fn notify(&self, method: &str, params: Value) -> Result<()>;
    pub async fn send(&self, message: &str) -> Result<()>;

    // Subscriptions
    pub fn subscribe_notifications(&self) -> broadcast::Receiver<Value>;

    // State
    pub fn state(&self) -> BusState;
    pub fn is_running(&self) -> bool;
    pub fn stats(&self) -> BusStats;
    pub fn worker_count(&self) -> i32;
    pub fn client_count(&self) -> i32;
    pub fn backend_type(&self) -> &'static str;
}
```
