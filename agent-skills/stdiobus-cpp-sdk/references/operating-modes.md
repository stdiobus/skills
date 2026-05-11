# Operating Modes

stdio Bus supports three modes. The mode is selected at construction time via BusBuilder.

## Mode comparison

| Capability | Embedded | TCP | Unix Socket |
|------------|----------|-----|-------------|
| Local process communication | ✓ | ✓ | ✓ |
| Remote network clients | ✘ | ✓ | ✘ |
| Latency | ~10μs | ~100μs | ~50μs |
| Throughput | ~1M msg/s | ~100K msg/s | ~500K msg/s |
| Filesystem permission security | N/A | ✘ | ✓ |
| Multi-host deployment | ✘ | ✓ | ✘ |

## Configuration

### Embedded (default — no listener)

```cpp
auto bus = stdiobus::BusBuilder()
    .config_path("config.json")
    .build();
```

Best for: single-process, testing, tightly-coupled host-worker.

### TCP

```cpp
auto bus = stdiobus::BusBuilder()
    .config_path("config.json")
    .listen_tcp("0.0.0.0", 9800)
    .on_client_connect([](int id, auto peer) {
        std::cout << "Client " << id << " from " << peer << std::endl;
    })
    .on_client_disconnect([](int id, auto reason) {
        std::cout << "Client " << id << " left: " << reason << std::endl;
    })
    .build();
```

Best for: remote workers, load balancer integration, Kubernetes.

Security: bind to `127.0.0.1` for local-only, use firewall rules, consider TLS proxy.

### Unix Socket

```cpp
auto bus = stdiobus::BusBuilder()
    .config_path("config.json")
    .listen_unix("/var/run/stdio_bus/bus.sock")
    .build();
```

Best for: single-host production, filesystem-based access control, containers with shared volumes.

Security: use filesystem permissions (chmod) on the socket file.

## Client callbacks (TCP and Unix only)

```cpp
bus.on_client_connect([](int client_id, std::string_view peer_info) {
    // TCP: "192.168.1.100:54321"
    // Unix: "unix"
});

bus.on_client_disconnect([](int client_id, std::string_view reason) {
    // "closed", "error", "timeout"
});
```

`bus.client_count()` returns connected client count (always 0 in embedded mode).

## Migrating between modes

Only the builder call changes. The rest of the API (send, step, callbacks) is identical:

```cpp
// Embedded → TCP: add listen_tcp()
// TCP → Unix: replace listen_tcp() with listen_unix()
// Any → Embedded: remove listen_*() calls
```

## Selection guide

| Scenario | Recommended Mode |
|----------|-----------------|
| Unit tests | Embedded |
| Single-process AI agent host | Embedded |
| Microservice with remote workers | TCP |
| Container sidecar pattern | Unix Socket |
| High-throughput local IPC | Unix Socket |
| Multi-host orchestration | TCP |
| Development / prototyping | Embedded |
