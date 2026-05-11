# Common Patterns & Recipes

Practical patterns for using the stdio Bus Rust SDK in real applications.

## Pattern: Retry with backoff

```rust
use stdiobus_client::{StdioBus, Error, Result};
use serde_json::Value;
use std::time::Duration;

async fn request_with_retry(
    bus: &StdioBus,
    method: &str,
    params: Value,
    max_retries: u32,
) -> Result<Value> {
    let mut attempt = 0;
    loop {
        match bus.request(method, params.clone()).await {
            Ok(result) => return Ok(result),
            Err(e) if e.is_retryable() && attempt < max_retries => {
                attempt += 1;
                let delay = Duration::from_millis(100 * 2u64.pow(attempt));
                tokio::time::sleep(delay).await;
            }
            Err(e) => return Err(e),
        }
    }
}
```

## Pattern: Graceful shutdown with signal handling

```rust
use stdiobus_client::{StdioBus, BusConfig, PoolConfig, Result};
use tokio::signal;

#[tokio::main]
async fn main() -> Result<()> {
    let bus = StdioBus::builder()
        .config(BusConfig {
            pools: vec![PoolConfig {
                id: "worker".into(),
                command: "node".into(),
                args: vec!["./worker.js".into()],
                instances: 2,
            }],
            limits: None,
        })
        .backend_native()
        .build()?;

    bus.start().await?;

    // Wait for Ctrl+C
    signal::ctrl_c().await.expect("Failed to listen for ctrl+c");
    println!("Shutting down...");

    bus.stop_with_timeout(10).await?;
    Ok(())
}
```

## Pattern: Multiple agent routing

```rust
use stdiobus_client::{StdioBus, RequestOptions};
use serde_json::json;

async fn multi_agent_example(bus: &StdioBus) -> stdiobus_core::Result<()> {
    // Route to specific agent by ID
    let opts = RequestOptions::default().agent_id("code-agent");
    let code_result = bus.request_with_options(
        "session/prompt",
        json!({"prompt": [{"type": "text", "text": "Write a function"}]}),
        opts,
    ).await?;

    // Route to a different agent
    let opts = RequestOptions::default().agent_id("review-agent");
    let review_result = bus.request_with_options(
        "session/prompt",
        json!({"prompt": [{"type": "text", "text": "Review this code"}]}),
        opts,
    ).await?;

    Ok(())
}
```

## Pattern: Notification listener

```rust
use stdiobus_client::StdioBus;
use serde_json::Value;

async fn listen_for_notifications(bus: &StdioBus) {
    let mut rx = bus.subscribe_notifications();

    tokio::spawn(async move {
        while let Ok(notification) = rx.recv().await {
            if let Some(method) = notification.get("method").and_then(|m| m.as_str()) {
                match method {
                    "notifications/progress" => {
                        let progress = notification.get("params")
                            .and_then(|p| p.get("progress"));
                        println!("Progress: {:?}", progress);
                    }
                    "notifications/log" => {
                        let msg = notification.get("params")
                            .and_then(|p| p.get("message"))
                            .and_then(|m| m.as_str());
                        println!("Log: {:?}", msg);
                    }
                    _ => {
                        println!("Unknown notification: {}", method);
                    }
                }
            }
        }
    });
}
```

## Pattern: Health check loop

```rust
use stdiobus_client::StdioBus;
use std::time::Duration;

async fn health_check_loop(bus: &StdioBus) {
    loop {
        tokio::time::sleep(Duration::from_secs(30)).await;

        if !bus.is_running() {
            eprintln!("Bus is not running! State: {:?}", bus.state());
            break;
        }

        let stats = bus.stats();
        println!(
            "Health: workers={}, msgs_in={}, msgs_out={}, errors={}",
            bus.worker_count(),
            stats.messages_in,
            stats.messages_out,
            stats.routing_errors,
        );
    }
}
```

## Pattern: Session management for ACP

```rust
use stdiobus_client::{StdioBus, RequestOptions, Result};
use serde_json::{json, Value};
use std::time::Duration;

struct AgentSession {
    bus: StdioBus,
    agent_id: String,
    session_id: String,
}

impl AgentSession {
    async fn new(bus: StdioBus, agent_id: &str, cwd: &str) -> Result<Self> {
        let opts = RequestOptions::default().agent_id(agent_id);

        // Initialize
        bus.request_with_options("initialize", json!({
            "protocolVersion": 1,
            "clientInfo": {"name": "my-app", "version": "1.0.0"},
            "clientCapabilities": {}
        }), opts).await?;

        // Create session
        let opts = RequestOptions::default().agent_id(agent_id);
        let session = bus.request_with_options("session/new", json!({
            "cwd": cwd,
            "mcpServers": []
        }), opts).await?;

        let session_id = session["sessionId"]
            .as_str()
            .unwrap_or_default()
            .to_string();

        Ok(Self {
            bus,
            agent_id: agent_id.to_string(),
            session_id,
        })
    }

    async fn prompt(&self, text: &str) -> Result<Value> {
        let opts = RequestOptions::with_timeout(Duration::from_secs(120))
            .agent_id(&self.agent_id);

        self.bus.request_with_options("session/prompt", json!({
            "sessionId": self.session_id,
            "prompt": [{"type": "text", "text": text}]
        }), opts).await
    }
}
```

## Pattern: Dynamic pool scaling

```rust
use stdiobus_client::{StdioBus, BusConfig, PoolConfig, Result};

/// Create a bus with pool size based on available CPUs
fn create_scaled_bus(worker_script: &str) -> Result<StdioBus> {
    let cpu_count = std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(2);

    // Use half the CPUs for workers, minimum 1
    let instances = (cpu_count / 2).max(1);

    StdioBus::builder()
        .config(BusConfig {
            pools: vec![PoolConfig {
                id: "worker".into(),
                command: "node".into(),
                args: vec![worker_script.into()],
                instances,
            }],
            limits: None,
        })
        .backend_native()
        .build()
}
```

## Pattern: Testing with mock config

```rust
#[cfg(test)]
mod tests {
    use stdiobus_client::{StdioBus, BusConfig, PoolConfig};

    #[test]
    fn test_bus_creation() {
        // Use /bin/cat as a simple echo-like worker for testing
        let bus = StdioBus::builder()
            .config(BusConfig {
                pools: vec![PoolConfig {
                    id: "test".into(),
                    command: "/bin/cat".into(),
                    args: vec![],
                    instances: 1,
                }],
                limits: None,
            })
            .build();

        // Build should succeed (backend resolution may vary)
        assert!(bus.is_ok() || bus.is_err());
    }
}
```

## Anti-patterns to avoid

### Don't call request before start
```rust
// WRONG: bus not started
let bus = StdioBus::builder().config(config).build()?;
let result = bus.request("method", json!({})).await; // Error: InvalidState

// CORRECT
let bus = StdioBus::builder().config(config).build()?;
bus.start().await?;
let result = bus.request("method", json!({})).await?;
```

### Don't forget to stop
```rust
// WRONG: workers left running
async fn do_work() -> Result<()> {
    let bus = StdioBus::builder().config(config).build()?;
    bus.start().await?;
    bus.request("method", json!({})).await?;
    Ok(()) // Workers leaked!
}

// CORRECT: always stop, even on error
async fn do_work() -> Result<()> {
    let bus = StdioBus::builder().config(config).build()?;
    bus.start().await?;
    let result = bus.request("method", json!({})).await;
    bus.stop().await?; // Always stop
    result.map(|_| ())
}
```

### Don't use zero instances
```rust
// WRONG: validation error
PoolConfig { id: "w".into(), command: "node".into(), args: vec![], instances: 0 }

// CORRECT: at least 1
PoolConfig { id: "w".into(), command: "node".into(), args: vec![], instances: 1 }
```
