# Resilience Patterns

Standard patterns for robust stdiobus integration: retry, timeout, circuit breaker.

## Retry policy

Only retry errors where `err.is_retryable()` returns true:
- `Again` — resource temporarily busy
- `Full` — queue/buffer at capacity (apply backoff)
- `Timeout` — operation timed out

Never retry: `Invalid`, `State`, `Config`, `NotFound`, `PolicyDenied`.

### Exponential backoff with jitter

```cpp
#include <random>
#include <thread>

class RetryPolicy {
public:
    RetryPolicy(int max_attempts = 3,
                std::chrono::milliseconds base_delay = std::chrono::milliseconds(100),
                std::chrono::milliseconds max_delay = std::chrono::seconds(10))
        : max_attempts_(max_attempts)
        , base_delay_(base_delay)
        , max_delay_(max_delay)
        , rng_(std::random_device{}())
    {}

    stdiobus::Error send_with_retry(stdiobus::Bus& bus, std::string_view msg) {
        for (int attempt = 1; attempt <= max_attempts_; ++attempt) {
            auto err = bus.send(msg);
            if (!err || !err.is_retryable()) return err;
            if (attempt < max_attempts_) {
                auto delay = base_delay_ * (1 << (attempt - 1));
                if (delay > max_delay_) delay = max_delay_;
                std::uniform_int_distribution<> jitter(0, delay.count());
                std::this_thread::sleep_for(delay + std::chrono::milliseconds(jitter(rng_)));
            }
        }
        return bus.send(msg);  // final attempt
    }

private:
    int max_attempts_;
    std::chrono::milliseconds base_delay_;
    std::chrono::milliseconds max_delay_;
    std::mt19937 rng_;
};
```

## Timeout handling

### With AsyncBus (recommended)

```cpp
auto future = asyncBus.request_async(message, std::chrono::seconds(30));

while (future.wait_for(std::chrono::milliseconds(0)) != std::future_status::ready) {
    asyncBus.pump(std::chrono::milliseconds(10));
    asyncBus.check_timeouts();  // resolves expired futures with ErrorCode::Timeout
}

auto result = future.get();
if (!result) {
    // result.error.code() == ErrorCode::Timeout if timed out
}
```

### Manual timeout tracking

```cpp
struct PendingRequest {
    std::string id;
    std::chrono::steady_clock::time_point deadline;
    std::function<void(bool, std::string)> callback;
};

std::unordered_map<std::string, PendingRequest> pending;

void check_timeouts() {
    auto now = std::chrono::steady_clock::now();
    for (auto it = pending.begin(); it != pending.end(); ) {
        if (now >= it->second.deadline) {
            it->second.callback(false, "timeout");
            it = pending.erase(it);
        } else {
            ++it;
        }
    }
}
```

## Circuit breaker

Prevents cascading failures by failing fast when a downstream is unhealthy.

States: `Closed` (normal) → `Open` (fail fast) → `HalfOpen` (probing)

```cpp
class CircuitBreaker {
public:
    enum class State { Closed, Open, HalfOpen };

    CircuitBreaker(int failure_threshold = 5,
                   std::chrono::seconds cooldown = std::chrono::seconds(30),
                   int success_threshold = 2);

    bool allow_request();   // false when Open (fail fast)
    void on_success();      // record success
    void on_failure();      // record failure, may trip breaker
    State state() const;
};
```

### Usage with Bus

```cpp
CircuitBreaker breaker(5, std::chrono::seconds(30), 2);

stdiobus::Error send_with_breaker(stdiobus::Bus& bus, std::string_view msg) {
    if (!breaker.allow_request()) {
        return stdiobus::Error(stdiobus::ErrorCode::Again, "Circuit open");
    }

    auto err = bus.send(msg);
    if (err) breaker.on_failure();
    else     breaker.on_success();
    return err;
}
```

## Combined: retry + circuit breaker

```cpp
class ResilientBus {
public:
    ResilientBus(stdiobus::Bus& bus) : bus_(bus) {}

    stdiobus::Error send(std::string_view msg) {
        if (!breaker_.allow_request()) {
            return stdiobus::Error(stdiobus::ErrorCode::Again, "Circuit open");
        }

        auto err = retry_.send_with_retry(bus_, msg);

        if (err) breaker_.on_failure();
        else     breaker_.on_success();

        return err;
    }

private:
    stdiobus::Bus& bus_;
    RetryPolicy retry_{3, std::chrono::milliseconds(100), std::chrono::seconds(10)};
    CircuitBreaker breaker_{5, std::chrono::seconds(30), 2};
};
```

## Backpressure handling

When `send()` returns `ErrorCode::Full`:

1. Stop sending new messages
2. Continue calling `step()` to drain the output queue
3. Retry after a short delay
4. If persistent, reduce send rate or increase `max_output_queue` in config

```cpp
auto err = bus.send(msg);
if (err.code() == stdiobus::ErrorCode::Full) {
    // Drain: pump I/O without sending
    for (int i = 0; i < 10; ++i) {
        bus.step(std::chrono::milliseconds(10));
    }
    // Retry
    err = bus.send(msg);
}
```
