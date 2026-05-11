---
name: stdiobus-cpp-sdk
description: Build, integrate, and troubleshoot the stdiobus C++ SDK — an AI agent transport layer that manages child worker processes communicating over stdin/stdout using JSON-RPC (MCP/ACP). Use when writing C++ code that uses stdiobus, configuring the bus, debugging worker lifecycle issues, implementing async request/response patterns, or integrating stdiobus into CMake projects.
license: Apache-2.0
compatibility: Requires CMake 3.14+, C++17 compiler (GCC 11+, Clang 14+, AppleClang 15+). Linux x64/arm64 or macOS x64/arm64.
metadata:
  author: stdiobus
  version: "1.0.0"
  repository: https://github.com/stdiobus/stdiobus-cpp
---

# stdiobus C++ SDK

A C++ SDK for stdio Bus — a process-embedded message bus that manages child worker processes communicating over stdin/stdout using JSON-RPC.

## When to use this skill

- Writing C++ code that creates, configures, or operates a `stdiobus::Bus`
- Implementing async request/response with `stdiobus::AsyncBus`
- Configuring worker pools via JSON config
- Choosing between Embedded, TCP, or Unix Socket operating modes
- Handling errors (status-style or exception mode)
- Integrating stdiobus into a CMake project (find_package, Conan, vcpkg)
- Debugging worker lifecycle, routing, or backpressure issues
- Writing event loops with `step()` and `poll_fd()`

## Project layout

```
include/stdiobus.hpp          # Umbrella header (include this)
include/stdiobus/bus.hpp      # Bus class + BusBuilder
include/stdiobus/async.hpp    # AsyncBus (std::future wrapper)
include/stdiobus/error.hpp    # ErrorCode, Error, Exception
include/stdiobus/types.hpp    # State, Stats, Options, callbacks
include/stdiobus/ffi.hpp      # Thin 1:1 C API wrapper
include/stdiobus/version.hpp  # Version constants
src/bus.cpp                   # Implementation
```

## Quick start

```cpp
#include <stdiobus.hpp>
#include <iostream>

int main() {
    stdiobus::Bus bus("config.json");

    bus.on_message([](std::string_view msg) {
        std::cout << "Received: " << msg << std::endl;
    });

    if (auto err = bus.start(); err) {
        std::cerr << "Failed: " << err.message() << std::endl;
        return 1;
    }

    bus.send(R"({"jsonrpc":"2.0","method":"echo","params":{"msg":"hi"},"id":1})");

    while (bus.is_running()) {
        bus.step(std::chrono::milliseconds(100));
    }
}
```

## Config file format

```json
{
  "pools": [
    {
      "id": "worker-name",
      "command": "/path/to/worker",
      "args": ["--flag"],
      "instances": 2
    }
  ],
  "limits": {
    "max_input_buffer": 1048576,
    "max_output_queue": 4194304
  }
}
```

## Core API patterns

### Construction

```cpp
// From config file
stdiobus::Bus bus("config.json");

// Builder pattern
auto bus = stdiobus::BusBuilder()
    .config_path("config.json")
    .log_level(1)  // 0=DEBUG, 1=INFO, 2=WARN, 3=ERROR
    .on_message([](auto msg) { /* handle */ })
    .on_error([](auto code, auto msg) { /* handle */ })
    .build();

// TCP listener mode
auto bus = stdiobus::BusBuilder()
    .config_path("config.json")
    .listen_tcp("0.0.0.0", 9800)
    .build();

// Unix socket mode
auto bus = stdiobus::BusBuilder()
    .config_path("config.json")
    .listen_unix("/tmp/bus.sock")
    .build();
```

### Lifecycle: start → step → stop

```cpp
bus.start();                              // Spawn workers
bus.step(std::chrono::milliseconds(100)); // Process I/O (call in loop)
bus.stop(std::chrono::seconds(5));        // Graceful shutdown
```

State machine: `Created → Starting → Running → Stopping → Stopped`

- `send()` only valid in Running state
- `step()` valid in Starting, Running, Stopping
- `stop()` is idempotent and always safe to call
- Destructor calls `stop()` automatically (RAII)

### Error handling (default: status-style)

```cpp
if (auto err = bus.send(message); err) {
    if (err.is_retryable()) {
        // ErrorCode::Again, Full, Timeout — safe to retry with backoff
    } else {
        // Fatal: Invalid, State, Config, Worker, Routing, PolicyDenied
        std::cerr << err.message() << std::endl;
    }
}
```

### Error handling (exception mode)

Compile with `-DSTDIOBUS_CPP_EXCEPTIONS=1`:

```cpp
try {
    stdiobus::throw_if_error(bus.start());
} catch (const stdiobus::Exception& e) {
    std::cerr << e.what() << " code=" << static_cast<int>(e.code()) << std::endl;
}
```

### Async request/response

```cpp
stdiobus::AsyncBus bus("config.json");
bus.start();

auto future = bus.request_async(
    R"({"jsonrpc":"2.0","method":"work","id":1})",
    std::chrono::seconds(30)
);

while (future.wait_for(std::chrono::milliseconds(0)) != std::future_status::ready) {
    bus.pump(std::chrono::milliseconds(10));
    bus.check_timeouts();
}

auto result = future.get();
if (result) {
    std::cout << result.response << std::endl;
} else {
    std::cerr << result.error.message() << std::endl;
}
```

### Callbacks

| Setter | Signature |
|--------|-----------|
| `on_message(cb)` | `void(std::string_view msg)` |
| `on_error(cb)` | `void(ErrorCode, std::string_view)` |
| `on_log(cb)` | `void(int level, std::string_view)` |
| `on_worker(cb)` | `void(int id, std::string_view event)` |
| `on_client_connect(cb)` | `void(int id, std::string_view peer)` |
| `on_client_disconnect(cb)` | `void(int id, std::string_view reason)` |

### State queries

```cpp
bus.state();         // State enum
bus.is_running();    // bool
bus.worker_count();  // int
bus.session_count(); // int
bus.pending_count(); // int
bus.client_count();  // int (TCP/Unix modes)
bus.poll_fd();       // int (-1 if unavailable)
bus.stats();         // Stats struct
```

## CMake integration

```cmake
find_package(stdiobus CONFIG REQUIRED)
target_link_libraries(your_app PRIVATE stdiobus::stdiobus)
```

Or with FetchContent / subdirectory:

```cmake
add_subdirectory(vendor/stdiobus-cpp)
target_link_libraries(your_app PRIVATE stdiobus::stdiobus)
```

## Build commands

```bash
./scripts/build.sh              # Debug build
./scripts/build.sh --release    # Release build
./scripts/test.sh --all         # All tests
./scripts/test.sh --unit        # Unit tests only
./scripts/verify.sh             # Lint + build + test
```

## Gotchas

- **Bus is NOT thread-safe.** All calls (including `step()`) must come from one thread. Callbacks fire from the `step()` thread.
- **Single lifecycle.** After `stop()`, create a new Bus instance. No restart.
- **`send()` returns `Error`.** Always check it — `[[nodiscard]]` enforced.
- **`step()` must be called regularly.** It drives all I/O. Without it, no messages flow.
- **Config requires at least one pool.** An empty `pools` array causes `ErrorCode::Config`.
- **Prebuilt kernel required.** The SDK links against `libstdio_bus.a`. Either use `prebuilds/` or set `STDIO_BUS_LIB_DIR`.
- **No Windows support.** Linux and macOS only.
- **Namespace is `stdiobus::v1`** but accessed as `stdiobus::` via inline namespace.
- **`poll_fd()` returns -1** in embedded mode on some platforms. Check before using with epoll/kqueue.

## Error code reference

| Code | Value | Retryable | Meaning |
|------|-------|-----------|---------|
| Ok | 0 | — | Success |
| Error | -1 | No | Generic |
| Again | -2 | Yes | Temporarily busy |
| Eof | -3 | No | Stream ended |
| Full | -4 | Yes | Buffer/queue full |
| NotFound | -5 | No | Session/route missing |
| Invalid | -6 | No | Bad argument |
| Config | -10 | No | Config problem |
| Worker | -11 | No | Worker process issue |
| Routing | -12 | No | Routing failure |
| Buffer | -13 | No | Buffer error |
| State | -15 | No | Wrong lifecycle state |
| Timeout | -20 | Yes | Timed out |
| PolicyDenied | -21 | No | Policy rejected |

## Further reference

- See [references/api-cheatsheet.md](references/api-cheatsheet.md) for the complete API table
- See [references/operating-modes.md](references/operating-modes.md) for mode selection and configuration
- See [references/resilience-patterns.md](references/resilience-patterns.md) for retry, timeout, and circuit breaker patterns
- See [references/lifecycle.md](references/lifecycle.md) for the full state machine and transition rules
