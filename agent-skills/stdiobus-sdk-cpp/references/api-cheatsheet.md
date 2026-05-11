# API Cheatsheet

Complete reference for all public classes, methods, and types.

## Bus Class

RAII wrapper — automatic cleanup in destructor.

### Construction

| Constructor | Description |
|-------------|-------------|
| `Bus(std::string_view config_path)` | Create from JSON config file |
| `Bus(Options options)` | Create from Options struct |

Non-copyable, movable.

### Lifecycle

| Method | Returns | Valid States | Description |
|--------|---------|--------------|-------------|
| `start()` | `Error` | Created | Spawn workers, transition to Running |
| `step(Duration timeout)` | `int` | Starting, Running, Stopping | Process I/O, returns events count |
| `step(chrono::duration)` | `int` | Starting, Running, Stopping | Template overload |
| `stop(chrono::seconds)` | `Error` | Any (idempotent) | Graceful shutdown with drain timeout |

### Messaging

| Method | Returns | Valid States | Description |
|--------|---------|--------------|-------------|
| `send(std::string_view)` | `Error` | Running | Send JSON message to workers |
| `send(const std::string&)` | `Error` | Running | String overload |
| `send(const char*)` | `Error` | Running | C-string overload |

### State Queries

| Method | Returns | Description |
|--------|---------|-------------|
| `state()` | `State` | Current lifecycle state |
| `is_running()` | `bool` | state() == Running |
| `is_created()` | `bool` | state() == Created |
| `is_stopped()` | `bool` | state() == Stopped |
| `stats()` | `Stats` | Message/byte counters |
| `worker_count()` | `int` | Active worker processes |
| `session_count()` | `int` | Active sessions |
| `pending_count()` | `int` | Pending requests |
| `client_count()` | `int` | Connected clients (TCP/Unix) |
| `poll_fd()` | `int` | Event loop fd (-1 if unavailable) |
| `operator bool()` | `bool` | True if handle is valid |

### Callbacks

| Method | Callback Signature |
|--------|-------------------|
| `on_message(cb)` | `void(std::string_view message)` |
| `on_error(cb)` | `void(ErrorCode code, std::string_view message)` |
| `on_log(cb)` | `void(int level, std::string_view message)` |
| `on_worker(cb)` | `void(int worker_id, std::string_view event)` |
| `on_client_connect(cb)` | `void(int client_id, std::string_view peer_info)` |
| `on_client_disconnect(cb)` | `void(int client_id, std::string_view reason)` |

### Advanced

| Method | Returns | Description |
|--------|---------|-------------|
| `raw_handle()` | `stdio_bus_t*` | Access underlying C handle |

---

## BusBuilder Class

Fluent builder for Bus construction.

| Method | Description |
|--------|-------------|
| `config_path(string)` | JSON config file path |
| `config_json(string)` | Inline JSON config string |
| `log_level(int)` | 0=DEBUG, 1=INFO, 2=WARN, 3=ERROR |
| `listen_tcp(host, port)` | Enable TCP listener |
| `listen_unix(path)` | Enable Unix socket listener |
| `on_message(cb)` | Set message callback |
| `on_error(cb)` | Set error callback |
| `on_log(cb)` | Set log callback |
| `on_worker(cb)` | Set worker event callback |
| `build()` | Returns `Bus` |

---

## AsyncBus Class

Promise-based async wrapper. Non-copyable, non-movable.

| Method | Returns | Description |
|--------|---------|-------------|
| `start()` | `Error` | Start the bus |
| `stop(chrono::seconds)` | `Error` | Stop the bus |
| `pump(Duration)` | `int` | Process I/O (call in loop) |
| `request_async(string, chrono::ms)` | `future<AsyncResult>` | Send request, get future |
| `notify(string_view)` | `Error` | Send notification (no response) |
| `check_timeouts()` | `void` | Resolve timed-out requests |
| `bus()` | `Bus&` | Access underlying Bus |

### AsyncResult

```cpp
struct AsyncResult {
    Error error;
    std::string response;
    explicit operator bool() const; // true if no error
};
```

---

## Error Class

Lightweight, copyable, no heap allocation for common cases.

| Method | Returns | Description |
|--------|---------|-------------|
| `operator bool()` | `bool` | True if error occurred |
| `code()` | `ErrorCode` | Error code enum |
| `message()` | `string_view` | Human-readable message |
| `is_retryable()` | `bool` | Safe to retry? |
| `Error::ok()` | `Error` | Create success result |
| `Error::from_c(int)` | `Error` | Create from C API code |

---

## ErrorCode Enum

```cpp
enum class ErrorCode : int {
    Ok = 0, Error = -1, Again = -2, Eof = -3,
    Full = -4, NotFound = -5, Invalid = -6,
    Config = -10, Worker = -11, Routing = -12,
    Buffer = -13, State = -15, Timeout = -20,
    PolicyDenied = -21
};
```

Free functions:
- `error_code_name(ErrorCode) → string_view`
- `is_retryable(ErrorCode) → bool`

---

## State Enum

```cpp
enum class State { Created=0, Starting=1, Running=2, Stopping=3, Stopped=4 };
```

Free function: `state_name(State) → string_view`

---

## Stats Struct

```cpp
struct Stats {
    uint64_t messages_in, messages_out;
    uint64_t bytes_in, bytes_out;
    uint64_t worker_restarts, routing_errors;
    uint64_t client_connects, client_disconnects;
};
```

---

## ListenMode Enum

```cpp
enum class ListenMode { None=0, Tcp=1, Unix=2 };
```

---

## Options Struct

```cpp
struct Options {
    std::string config_path;
    std::string config_json;
    ListenerConfig listener;
    int log_level = 1;
    MessageCallback on_message;
    ErrorCallback on_error;
    LogCallback on_log;
    WorkerCallback on_worker;
    ClientConnectCallback on_client_connect;
    ClientDisconnectCallback on_client_disconnect;
};
```

---

## Callback Type Aliases

```cpp
using MessageCallback = std::function<void(std::string_view)>;
using ErrorCallback = std::function<void(ErrorCode, std::string_view)>;
using LogCallback = std::function<void(int level, std::string_view)>;
using WorkerCallback = std::function<void(int worker_id, std::string_view event)>;
using ClientConnectCallback = std::function<void(int client_id, std::string_view peer)>;
using ClientDisconnectCallback = std::function<void(int client_id, std::string_view reason)>;
```

---

## Version API

```cpp
constexpr std::string_view stdiobus::version();       // "1.0.0"
constexpr int stdiobus::version_major();              // 1
constexpr int stdiobus::version_minor();              // 0
constexpr int stdiobus::version_patch();              // 0
bool stdiobus::kernel_compatible();                   // runtime check
```

Macros: `STDIOBUS_VERSION_STRING`, `STDIOBUS_VERSION_MAJOR`, `STDIOBUS_VERSION_MINOR`, `STDIOBUS_VERSION_PATCH`, `STDIOBUS_VERSION_NUMBER`, `STDIOBUS_KERNEL_API_VERSION`

---

## FFI Layer (stdiobus::ffi)

Direct 1:1 C API wrapper for advanced use:

```cpp
#include <stdiobus/ffi.hpp>

auto handle = stdiobus::ffi::create(&c_options);
handle.start();
handle.step(100);
handle.ingest(msg, len);
handle.stop(5);
stdiobus::ffi::destroy(handle);
```

---

## Exception Mode (compile with -DSTDIOBUS_CPP_EXCEPTIONS=1)

```cpp
class Exception : public std::exception {
    const char* what() const noexcept;
    const Error& error() const noexcept;
    ErrorCode code() const noexcept;
};

void throw_if_error(const Error& err); // throws if err
```
