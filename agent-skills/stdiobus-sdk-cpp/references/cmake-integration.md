# CMake Integration

## find_package (installed)

After installing stdiobus (via `cmake --install` or package manager):

```cmake
cmake_minimum_required(VERSION 3.14)
project(my_app LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(stdiobus CONFIG REQUIRED)

add_executable(my_app main.cpp)
target_link_libraries(my_app PRIVATE stdiobus::stdiobus)
```

## Subdirectory (vendored)

```cmake
add_subdirectory(vendor/stdiobus-cpp)
target_link_libraries(my_app PRIVATE stdiobus::stdiobus)
```

## Conan 2.x

### conanfile.txt

```ini
[requires]
stdiobus/1.0.0

[generators]
CMakeDeps
CMakeToolchain
```

### Build with Conan

```bash
conan install . --output-folder=build --build=missing
cmake -S . -B build -DCMAKE_TOOLCHAIN_FILE=build/conan_toolchain.cmake
cmake --build build
```

## CMake options

| Option | Default | Description |
|--------|---------|-------------|
| `STDIOBUS_CPP_EXCEPTIONS` | OFF | Enable exception mode |
| `STDIOBUS_BUILD_TESTS` | ON | Build test targets |
| `STDIOBUS_BUILD_EXAMPLES` | ON | Build example targets |
| `STDIOBUS_BUILD_BENCHMARKS` | OFF | Build benchmarks |
| `STDIOBUS_WARNINGS_AS_ERRORS` | OFF | Treat warnings as errors |
| `STDIOBUS_SANITIZER` | _(empty)_ | address, undefined, thread |
| `STDIOBUS_INSTALL` | ON | Generate install targets |
| `STDIO_BUS_LIB_DIR` | _(auto)_ | Path to libstdio_bus.a directory |

## Kernel library resolution

The CMake build auto-detects the prebuilt kernel from `prebuilds/` based on platform:

| Platform | Triple |
|----------|--------|
| macOS arm64 | `aarch64-apple-darwin` |
| macOS x64 | `x86_64-apple-darwin` |
| Linux arm64 | `aarch64-unknown-linux-gnu` |
| Linux x64 | `x86_64-unknown-linux-gnu` |

To override: `-DSTDIO_BUS_LIB_DIR=/path/to/dir` (must contain `libstdio_bus.a`).

## Targets exported

| Target | Type | Description |
|--------|------|-------------|
| `stdiobus::stdiobus` | STATIC | Full library (headers + implementation + kernel link) |
| `stdiobus::headers` | INTERFACE | Headers only (for header-only usage patterns) |

## pkg-config

After install, `stdiobus.pc` is available:

```bash
g++ main.cpp $(pkg-config --cflags --libs stdiobus) -o my_app
```

## Exception mode

To enable exception-based error handling:

```cmake
# Option 1: CMake option
cmake -S . -B build -DSTDIOBUS_CPP_EXCEPTIONS=ON

# Option 2: In consumer CMakeLists.txt
target_compile_definitions(my_app PRIVATE STDIOBUS_CPP_EXCEPTIONS=1)
```

## Sanitizer builds

```bash
# ASan + UBSan
cmake -S . -B build -DSTDIOBUS_SANITIZER=address,undefined -DCMAKE_BUILD_TYPE=Debug

# TSan
cmake -S . -B build-tsan -DSTDIOBUS_SANITIZER=thread -DCMAKE_BUILD_TYPE=Debug
```

## Troubleshooting

### "libstdio_bus.a not found"

1. Ensure `prebuilds/` directory exists with platform binaries
2. Or set `-DSTDIO_BUS_LIB_DIR=/path/to/kernel/build`
3. Or build the kernel from the parent repo first

### macOS "C++ headers not found"

```bash
export SDKROOT=$(xcrun --show-sdk-path)
cmake -S . -B build
```

### Linker errors about pthread (Linux)

The CMakeLists.txt links pthread automatically. If using a custom build, add `-lpthread`.
