# Configuration Schema Reference

The stdio Bus configuration matches the C bus JSON schema exactly. This document covers both programmatic and file-based configuration.

## JSON Schema

```json
{
  "pools": [
    {
      "id": "string (required, unique)",
      "command": "string (required, executable path)",
      "args": ["string array (optional, default: [])"],
      "instances": "integer (required, >= 1)"
    }
  ],
  "limits": {
    "max_input_buffer": "integer (optional, bytes)",
    "max_output_queue": "integer (optional, bytes)",
    "max_restarts": "integer (optional)",
    "restart_window_sec": "integer (optional, seconds)",
    "drain_timeout_sec": "integer (optional, seconds)",
    "backpressure_timeout_sec": "integer (optional, seconds)"
  }
}
```

## Example config.json

```json
{
  "pools": [
    {
      "id": "acp-worker",
      "command": "npx",
      "args": ["@stdiobus/workers-registry", "acp-registry"],
      "instances": 1
    }
  ]
}
```

## Multi-pool configuration

```json
{
  "pools": [
    {
      "id": "mcp-tools",
      "command": "node",
      "args": ["./mcp-server.js"],
      "instances": 2
    },
    {
      "id": "acp-agent",
      "command": "node",
      "args": ["./acp-worker.js"],
      "instances": 1
    }
  ],
  "limits": {
    "max_input_buffer": 2097152,
    "max_output_queue": 8388608,
    "max_restarts": 10,
    "restart_window_sec": 120,
    "drain_timeout_sec": 60,
    "backpressure_timeout_sec": 90
  }
}
```

## Programmatic equivalent in Rust

```rust
use stdiobus_client::{BusConfig, PoolConfig, LimitsConfig};

let config = BusConfig {
    pools: vec![
        PoolConfig {
            id: "mcp-tools".into(),
            command: "node".into(),
            args: vec!["./mcp-server.js".into()],
            instances: 2,
        },
        PoolConfig {
            id: "acp-agent".into(),
            command: "node".into(),
            args: vec!["./acp-worker.js".into()],
            instances: 1,
        },
    ],
    limits: Some(LimitsConfig {
        max_input_buffer: Some(2097152),
        max_output_queue: Some(8388608),
        max_restarts: Some(10),
        restart_window_sec: Some(120),
        drain_timeout_sec: Some(60),
        backpressure_timeout_sec: Some(90),
    }),
};
```

## Validation Rules

The SDK validates `BusConfig` before passing to the backend:

1. `pools` must not be empty (at least one pool required)
2. Each pool must have a non-empty `id`
3. Each pool must have a non-empty `command`
4. Each pool must have `instances >= 1`
5. Pool IDs should be unique (not enforced by SDK, but required by C bus)

Validation happens in `StdioBusBuilder::build()` when using `ConfigSource::Config`.

## Serialization Notes

- `LimitsConfig` fields use `skip_serializing_if = "Option::is_none"` — omitted fields don't appear in JSON
- `PoolConfig.args` uses `#[serde(default)]` — missing `args` in JSON defaults to empty vec
- Field names in JSON use snake_case (matching C bus expectations): `max_input_buffer`, `restart_window_sec`, etc.

## Docker-specific Configuration

When using Docker backend with `ConfigSource::Config`, the SDK:
1. Serializes `BusConfig` to JSON
2. Writes to a temp file at `{temp_dir}/stdiobus-{pid}.json`
3. Mounts the file as `/config.json:ro` in the container
4. Passes `--config /config.json` to the container entrypoint

Docker options are separate from bus config:

```rust
let bus = StdioBus::builder()
    .config(config)
    .backend_docker()
    .docker_image("stdiobus/stdiobus:node20")
    .docker_pull_policy("if-missing")  // "never" | "if-missing" | "always"
    .build()?;
```
