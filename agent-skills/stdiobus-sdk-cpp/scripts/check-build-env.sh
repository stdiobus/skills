#!/usr/bin/env bash
# Checks that the build environment is ready for stdiobus-sdk-cpp.
# Usage: bash scripts/check-build-env.sh [--project-root /path/to/stdiobus-cpp]
#
# Exit codes:
#   0 - All checks passed
#   1 - Missing required tool
#   2 - Missing kernel library

set -euo pipefail

PROJECT_ROOT="."

while [[ $# -gt 0 ]]; do
    case "$1" in
        --project-root) PROJECT_ROOT="$2"; shift 2 ;;
        --help|-h)
            echo "Usage: bash scripts/check-build-env.sh [--project-root /path/to/stdiobus-cpp]"
            echo ""
            echo "Checks build environment readiness:"
            echo "  - C++17 compiler available"
            echo "  - CMake 3.14+ installed"
            echo "  - Platform is supported (Linux/macOS)"
            echo "  - Prebuilt kernel library exists"
            echo ""
            echo "Exit codes: 0=ready, 1=missing tool, 2=missing kernel"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

PASS=0
FAIL=0

check() {
    local label="$1"
    local result="$2"
    if [[ "$result" == "ok" ]]; then
        echo "  ✓ $label"
        PASS=$((PASS + 1))
    else
        echo "  ✘ $label — $result"
        FAIL=$((FAIL + 1))
    fi
}

echo "stdiobus-sdk-cpp build environment check"
echo "====================================="
echo ""

# Platform
PLATFORM="$(uname -s)"
ARCH="$(uname -m)"
echo "Platform: $PLATFORM $ARCH"
echo ""

if [[ "$PLATFORM" != "Linux" && "$PLATFORM" != "Darwin" ]]; then
    check "Supported platform" "unsupported: $PLATFORM (need Linux or macOS)"
else
    check "Supported platform" "ok"
fi

# C++ compiler
if command -v c++ &>/dev/null; then
    CXX_VERSION=$(c++ --version 2>&1 | head -1)
    check "C++ compiler" "ok"
    echo "    → $CXX_VERSION"
elif command -v g++ &>/dev/null; then
    check "C++ compiler (g++)" "ok"
elif command -v clang++ &>/dev/null; then
    check "C++ compiler (clang++)" "ok"
else
    check "C++ compiler" "not found (need GCC 11+, Clang 14+, or AppleClang 15+)"
fi

# CMake
if command -v cmake &>/dev/null; then
    CMAKE_VER=$(cmake --version | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
    CMAKE_MAJOR=$(echo "$CMAKE_VER" | cut -d. -f1)
    CMAKE_MINOR=$(echo "$CMAKE_VER" | cut -d. -f2)
    if [[ "$CMAKE_MAJOR" -gt 3 ]] || { [[ "$CMAKE_MAJOR" -eq 3 ]] && [[ "$CMAKE_MINOR" -ge 14 ]]; }; then
        check "CMake 3.14+" "ok"
        echo "    → cmake $CMAKE_VER"
    else
        check "CMake 3.14+" "found $CMAKE_VER (need 3.14+)"
    fi
else
    check "CMake" "not found"
fi

# Kernel library
echo ""
echo "Kernel library (libstdio_bus.a):"

if [[ "$PLATFORM" == "Darwin" ]]; then
    if [[ "$ARCH" == "arm64" ]]; then
        TRIPLE="aarch64-apple-darwin"
    else
        TRIPLE="x86_64-apple-darwin"
    fi
else
    if [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]]; then
        TRIPLE="aarch64-unknown-linux-gnu"
    else
        TRIPLE="x86_64-unknown-linux-gnu"
    fi
fi

PREBUILD_PATH="$PROJECT_ROOT/prebuilds/$TRIPLE/libstdio_bus.a"
PARENT_PATH="$PROJECT_ROOT/../../build/libstdio_bus.a"

if [[ -f "$PREBUILD_PATH" ]]; then
    check "Prebuilt kernel ($TRIPLE)" "ok"
    echo "    → $PREBUILD_PATH"
elif [[ -f "$PARENT_PATH" ]]; then
    check "Kernel from parent build" "ok"
    echo "    → $PARENT_PATH"
else
    check "Kernel library" "not found at $PREBUILD_PATH"
    echo "    → Run ./scripts/sync-prebuilds.sh or build kernel from parent repo"
fi

# Summary
echo ""
echo "---"
if [[ $FAIL -eq 0 ]]; then
    echo "Result: READY ($PASS checks passed)"
    exit 0
else
    echo "Result: NOT READY ($FAIL issues, $PASS passed)"
    exit 1
fi
