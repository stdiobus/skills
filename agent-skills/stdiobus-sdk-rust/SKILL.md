---
name: stdiobus-sdk-rust
description: Build Rust applications using the stdio Bus SDK — an async AI agent transport layer for MCP/ACP protocols. Use when working with stdiobus crates, spawning worker processes, sending JSON-RPC requests to agents, configuring bus pools, choosing native or Docker backends, or integrating MCP/ACP agent communication in Rust. Triggers on mentions of stdiobus, stdio_bus, BusConfig, StdioBus, PoolConfig, backend_native, backend_docker, agent transport, worker pools, or JSON-RPC messaging in Rust.
license: Apache-2.0
compatibility: Requires Rust 1.70+, Tokio async runtime. Native backend requires libstdio_bus.a (prebuilt for Linux/macOS x86_64/aarch64). Docker backend requires Docker CLI.
metadata:
  author: stdiobus
  version: "1.1.1"
  repository: https://github.com/stdiobus/stdiobus-rust
  tags: "rust async mcp acp agent transport json-rpc tokio"
---

# stdio Bus Rust SDK

Async-first Rust SDK for stdio_bus — the AI agent transport layer supporting MCP and ACP protocols.

## When to use this skill

- Building a Rust application that communicates with AI agent workers (MCP or ACP)
- Spawning and managing worker process pools from Rust
- Sending JSON-RPC 2.0 requests to agent workers and receiving responses
- Choosing between native (FFI) and Docker backends
- Configuring bus pools, limits, timeouts, and routing
- Implementing ACP flows: initialize → session/new → session/prompt

## Architecture overview

The SDK is a Cargo workspace with 6 crates:

| Crate | Purpose |
|-------|---------|
| `stdiobus` | Umbrella re-export (convenience) |
| `stdiobus-client` | **Main client API** — use this |
| `stdiobus-core` | Core types, errors, traits |
| `stdiobus-ffi` | Raw FFI bindings to libstdio_bus.a |
| `stdiobus-backend-native` | Native backend (FFI, highest performance) |
| `stdiobus-backend-docker` | Docker backend (container-based) |

## Quick start

```rust
use stdiobus_client::{StdioBus, BusConfig, PoolConfig, Result};
use serde_json::json;
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<()> {
    let bus = StdioBus::builder()
        .config(BusConfig {
            pools: vec![PoolConfig {
                id: "echo".into(),
                command: "node".into(),
                args: vec!["./worker.js".into()],
                instances: 1,
            }],
            limits: None,
        })
        .backend_native()
        .timeout(Duration::from_secs(30))
        .build()?;

    bus.start().await?;

    let result = bus.request("echo", json!({"message": "hello"})).await?;
    println!("Response: {}", result);

    bus.stop().await?;
    Ok(())
}
```

## Configuration

Always use programmatic `BusConfig` (preferred over file-based config):

```rust
use stdiobus_client::{BusConfig, PoolConfig, LimitsConfig};

let config = BusConfig {
    pools: vec![PoolConfig {
        id: "worker".into(),       // unique pool identifier
        command: "node".into(),    // executable path
        args: vec!["./worker.js".into()],
        instances: 4,              // must be >= 1
    }],
    limits: Some(LimitsConfig {
        max_input_buffer: Some(2097152),
        max_restarts: Some(10),
        drain_timeout_sec: Some(30),
        ..Default::default()
    }),
};
```

File-based config (legacy, still supported):
```rust
let bus = StdioBus::builder()
    .config_path("./config.json")
    .build()?;
```

`.config()` and `.config_path()` are mutually exclusive.

## Backend selection

```rust
// Auto (default): native on Unix if available, Docker otherwise
.backend_auto()

// Force native (requires libstdio_bus.a linked)
.backend_native()

// Force Docker (requires Docker CLI)
.backend_docker()
.docker_image("stdiobus/stdiobus:node20")
```

Feature flags in Cargo.toml:
- `docker` (default) — Docker backend
- `native` — Native FFI backend
- `full` — Both backends

## API reference

### Lifecycle
```rust
bus.start().await?;           // Spawn workers
bus.stop().await?;            // Graceful shutdown (30s default)
bus.stop_with_timeout(10).await?;  // Custom timeout
```

### Messaging
```rust
// Simple request/response
let result = bus.request("method", json!(params)).await?;

// With options (timeout, routing, idempotency)
let opts = RequestOptions::with_timeout(Duration::from_secs(60))
    .session_id("my-session")
    .agent_id("my-agent")
    .idempotency_key("unique-key");
let result = bus.request_with_options("method", json!(params), opts).await?;

// Fire-and-forget notification
bus.notify("method", json!(params)).await?;

// Raw JSON
bus.send(r#"{"jsonrpc":"2.0","method":"ping"}"#).await?;
```

### State and stats
```rust
bus.state()          // BusState: Created|Starting|Running|Stopping|Stopped
bus.is_running()     // bool
bus.stats()          // BusStats { messages_in, messages_out, bytes_in, bytes_out, ... }
bus.worker_count()   // i32 (-1 if unknown)
bus.client_count()   // i32
bus.backend_type()   // "native" or "docker"
```

### Notifications subscription
```rust
let mut rx = bus.subscribe_notifications();
tokio::spawn(async move {
    while let Ok(notification) = rx.recv().await {
        println!("Notification: {}", notification);
    }
});
```

## Error handling

```rust
use stdiobus_client::{Error, ErrorCode};

match bus.request("method", params).await {
    Ok(result) => { /* success */ }
    Err(Error::Timeout { timeout_ms }) => { /* retryable */ }
    Err(Error::TransportError { message }) => { /* retryable */ }
    Err(Error::PolicyDenied { message }) => { /* not retryable */ }
    Err(e) => {
        println!("Code: {}, Retryable: {}", e.code(), e.is_retryable());
    }
}
```

Error codes: InvalidArgument, InvalidState, Timeout, Cancelled, TransportError, NegotiationFailed, ExtensionUnavailable, PolicyDenied, InternalError, ResourceExhausted.

## ACP protocol flow

Full Agent Communication Protocol pattern:

```rust
use stdiobus_client::{StdioBus, BusConfig, PoolConfig, RequestOptions};
use serde_json::json;

// 1. Initialize agent
let opts = RequestOptions::default().agent_id("my-agent");
let init = bus.request_with_options("initialize", json!({
    "protocolVersion": 1,
    "clientInfo": {"name": "my-app", "version": "1.0.0"},
    "clientCapabilities": {}
}), opts).await?;

// 2. Create session
let opts = RequestOptions::default().agent_id("my-agent");
let session = bus.request_with_options("session/new", json!({
    "cwd": "/path/to/workspace",
    "mcpServers": []
}), opts).await?;
let session_id = session["sessionId"].as_str().unwrap();

// 3. Send prompt (streaming chunks aggregated automatically)
let opts = RequestOptions::default().agent_id("my-agent");
let result = bus.request_with_options("session/prompt", json!({
    "sessionId": session_id,
    "prompt": [{"type": "text", "text": "What is 2+2?"}]
}), opts).await?;
// result["text"] contains aggregated streaming response
```

## Gotchas

- `BusConfig.pools` must have at least one pool with `instances >= 1` or `build()` fails with `InvalidArgument`.
- After `bus.start()`, wait briefly (e.g., 500ms) for workers to initialize before sending requests.
- `subscribe()` on the backend returns `Some` only on the first call — the receiver is single-owner. Use `subscribe_notifications()` on `StdioBus` for broadcast.
- Native backend wraps all FFI calls in `spawn_blocking` — safe for async but adds minimal latency.
- Docker backend binds to a random port on 127.0.0.1 — no port conflicts.
- The `client_session_id` is auto-generated per `StdioBus` instance for routing. Override with `RequestOptions::session_id()`.
- ACP streaming: `agent_message_chunk` notifications are automatically aggregated into the final response `text` field.

## Cargo.toml dependency

```toml
[dependencies]
stdiobus-client = "1.1"
tokio = { version = "1", features = ["full"] }
serde_json = "1.0"
```

For native backend:
```toml
[dependencies]
stdiobus-client = { version = "1.1", features = ["native"] }
```

## Platform support

| Platform | Docker | Native | Target |
|----------|--------|--------|--------|
| Linux x64 | ✓ | ✓ | x86_64-unknown-linux-gnu |
| Linux arm64 | ✓ | ✓ | aarch64-unknown-linux-gnu |
| macOS x64 | ✓ | ✓ | x86_64-apple-darwin |
| macOS arm64 | ✓ | ✓ | aarch64-apple-darwin |
| Windows x64 | ✓ | ✘ | — |

Native backend requires glibc 2.31+ on Linux.

## Further reference

- See [references/api-types.md](references/api-types.md) for complete type definitions
- See [references/backend-trait.md](references/backend-trait.md) for implementing custom backends
- See [references/config-schema.md](references/config-schema.md) for full config JSON schema
