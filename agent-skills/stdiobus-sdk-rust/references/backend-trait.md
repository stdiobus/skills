# Backend Trait Reference

The `Backend` trait is the abstraction layer that all transport implementations must satisfy. The SDK ships with two implementations (native and Docker), but you can implement custom backends.

## Trait Definition

```rust
use async_trait::async_trait;
use tokio::sync::mpsc;

/// Message received from the bus
#[derive(Debug, Clone)]
pub struct BusMessage {
    pub json: String,
}

/// Backend trait that all implementations must satisfy
#[async_trait]
pub trait Backend: Send + Sync {
    /// Start the backend (spawn workers, connect to transport)
    async fn start(&self) -> Result<()>;

    /// Stop the backend gracefully within timeout_secs
    async fn stop(&self, timeout_secs: u32) -> Result<()>;

    /// Send a JSON message to workers
    async fn send(&self, message: &str) -> Result<()>;

    /// Get current state
    fn state(&self) -> BusState;

    /// Get statistics
    fn stats(&self) -> BusStats;

    /// Get number of running workers (-1 if unknown)
    fn worker_count(&self) -> i32;

    /// Get number of connected clients (-1 if unknown)
    fn client_count(&self) -> i32;

    /// Subscribe to incoming messages.
    /// Returns Some(Receiver) on the first call only.
    /// Subsequent calls return None (single-owner receiver).
    fn subscribe(&self) -> Option<mpsc::Receiver<BusMessage>>;

    /// Get backend type name (e.g., "native", "docker")
    fn backend_type(&self) -> &'static str;
}
```

## State Machine Contract

Backends must follow this state machine:

```
Created → Starting → Running → Stopping → Stopped
                                              ↓
                                          can restart
                                              ↓
                                          Starting → ...
```

- `start()` is only valid from `Created` or `Stopped` states
- `stop()` transitions through `Stopping` to `Stopped`
- `send()` should only succeed in `Running` state

## Existing Implementations

### NativeBackend

- Links to `libstdio_bus.a` via FFI
- Wraps all C calls in `tokio::task::spawn_blocking`
- Polls the C event loop via `stdio_bus_step()` every 1ms
- Receives messages through C callback → mpsc channel
- Highest performance option for Unix systems
- Supports `ConfigSource::Config` (serializes to JSON buffer) and `ConfigSource::Path`

```rust
use stdiobus_backend_native::NativeBackend;

// From file path
let backend = NativeBackend::new("./config.json")?;

// From ConfigSource (preferred)
let backend = NativeBackend::from_config_source(&config_source)?;
```

### DockerBackend

- Runs stdio_bus in a Docker container
- Communicates via TCP (NDJSON over socket)
- Auto-assigns random port on 127.0.0.1
- Supports image pulling with configurable policy
- Mounts config file as read-only volume

```rust
use stdiobus_backend_docker::DockerBackend;

let backend = DockerBackend::new("./config.json", DockerOptions::default())?;
```

## Implementing a Custom Backend

```rust
use async_trait::async_trait;
use stdiobus_core::{Backend, BusMessage, BusState, BusStats, Result};
use tokio::sync::mpsc;

pub struct MyBackend {
    state: tokio::sync::RwLock<BusState>,
    message_tx: mpsc::Sender<BusMessage>,
    message_rx: tokio::sync::Mutex<Option<mpsc::Receiver<BusMessage>>>,
}

#[async_trait]
impl Backend for MyBackend {
    async fn start(&self) -> Result<()> {
        // 1. Validate state (must be Created or Stopped)
        // 2. Set state to Starting
        // 3. Initialize transport (connect, spawn workers, etc.)
        // 4. Set state to Running
        Ok(())
    }

    async fn stop(&self, timeout_secs: u32) -> Result<()> {
        // 1. Set state to Stopping
        // 2. Gracefully shut down within timeout
        // 3. Set state to Stopped
        Ok(())
    }

    async fn send(&self, message: &str) -> Result<()> {
        // Send message to workers via your transport
        Ok(())
    }

    fn state(&self) -> BusState {
        self.state.try_read().map(|s| *s).unwrap_or(BusState::Created)
    }

    fn stats(&self) -> BusStats {
        BusStats::default()
    }

    fn worker_count(&self) -> i32 { -1 }
    fn client_count(&self) -> i32 { -1 }

    fn subscribe(&self) -> Option<mpsc::Receiver<BusMessage>> {
        self.message_rx.try_lock().ok().and_then(|mut rx| rx.take())
    }

    fn backend_type(&self) -> &'static str { "custom" }
}
```

## Backend Resolution Logic

The `resolve_backend` function in `stdiobus-client` selects the backend:

1. **Auto mode**: On Windows → Docker. On Unix → try native first, fall back to Docker.
2. **Native mode**: Requires `native` feature flag. Fails if not compiled with it.
3. **Docker mode**: Requires `docker` feature flag. Materializes `BusConfig` to temp file if needed.

When using `ConfigSource::Config` with Docker backend, the SDK automatically writes a temporary JSON file (in system temp dir) because Docker needs a file to mount.
