#!/bin/bash
# Verify the stdiobus-rust workspace builds correctly.
# Usage: bash scripts/check-build.sh [--native]
#
# Without flags: builds with default features (docker backend)
# With --native: builds with native feature (requires libstdio_bus.a)

set -e

WORKSPACE_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$WORKSPACE_ROOT"

echo "=== stdio Bus Rust SDK Build Check ==="
echo "Workspace: $WORKSPACE_ROOT"
echo ""

# Check Rust toolchain
if ! command -v cargo &> /dev/null; then
    echo "ERROR: cargo not found. Install Rust: https://rustup.rs"
    exit 1
fi

echo "Rust version: $(rustc --version)"
echo "Cargo version: $(cargo --version)"
echo ""

# Determine features
FEATURES=""
if [[ "$1" == "--native" ]]; then
    FEATURES="--features native"
    echo "Building with native backend..."
else
    echo "Building with default features (docker backend)..."
fi

# Build
echo ""
echo "--- cargo build $FEATURES ---"
cargo build $FEATURES 2>&1

# Check (lint)
echo ""
echo "--- cargo clippy $FEATURES ---"
cargo clippy $FEATURES -- -D warnings 2>&1 || echo "WARN: clippy warnings found"

# Test (unit tests only, no integration)
echo ""
echo "--- cargo test $FEATURES ---"
cargo test $FEATURES 2>&1

echo ""
echo "=== Build check passed ==="
