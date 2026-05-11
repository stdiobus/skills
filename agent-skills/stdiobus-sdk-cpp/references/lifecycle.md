# Lifecycle State Machine

## States

| State | Value | Description |
|-------|-------|-------------|
| Created | 0 | Constructed, not yet started |
| Starting | 1 | Workers being spawned |
| Running | 2 | Accepting and routing messages |
| Stopping | 3 | Graceful shutdown in progress |
| Stopped | 4 | All resources released |

## Transitions

```
Created ──start()──→ Starting ──workers ready──→ Running
                     Starting ──spawn fail──→ Stopped
Running ──stop()──→ Stopping ──drain done──→ Stopped
Running ──fatal──→ Stopped
Stopping ──timeout──→ Stopped (force kill)
```

## API validity by state

| API | Created | Starting | Running | Stopping | Stopped |
|-----|---------|----------|---------|----------|---------|
| `start()` | ✓ | ✘ | ✘ | ✘ | ✘ |
| `step()` | ✘ | ✓ | ✓ | ✓ | ✘ |
| `send()` | ✘ | ✘ | ✓ | ✘ | ✘ |
| `stop()` | no-op | ✓ | ✓ | idempotent | no-op |
| `state()` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `stats()` | ✓ | ✓ | ✓ | ✓ | ✓ |

Calling `send()` outside Running returns `ErrorCode::State`.

## Invariants

1. **Single lifecycle** — after Stopped, create a new Bus instance
2. **Idempotent stop** — `stop()` can be called multiple times safely
3. **No restart** — cannot `start()` after `stop()`
4. **RAII** — destructor calls `stop()` automatically

## Graceful shutdown sequence

When `stop(timeout)` is called:

1. Stop accepting new messages
2. Send SIGTERM to all workers
3. Wait for workers to exit (up to timeout)
4. If timeout expires: send SIGKILL
5. Close all connections
6. Release all resources
7. Transition to Stopped

```cpp
auto err = bus.stop(std::chrono::seconds(10));
// State is Stopped regardless of whether err indicates timeout
```

## Event loop pattern

```cpp
stdiobus::Bus bus("config.json");
bus.on_message([](auto msg) { /* handle */ });
bus.start();

while (bus.is_running()) {
    int events = bus.step(std::chrono::milliseconds(100));
    // events > 0: I/O was processed
    // events == 0: timeout, no activity
    // events < 0: error (rare)
}

bus.stop();
```

## External event loop integration (epoll/kqueue)

```cpp
int fd = bus.poll_fd();
if (fd >= 0) {
    // Add fd to your epoll/kqueue set
    // When fd is readable, call bus.step(Duration::zero()) for non-blocking processing
}
```

## Signal handling pattern

```cpp
#include <atomic>
#include <csignal>

static std::atomic<bool> g_running{true};

void handler(int) { g_running = false; }

int main() {
    std::signal(SIGINT, handler);
    std::signal(SIGTERM, handler);

    stdiobus::Bus bus("config.json");
    bus.start();

    while (g_running && bus.is_running()) {
        bus.step(std::chrono::milliseconds(100));
    }

    bus.stop(std::chrono::seconds(5));
}
```
