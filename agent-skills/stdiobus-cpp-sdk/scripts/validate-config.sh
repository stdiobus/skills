#!/usr/bin/env bash
# Validates a stdiobus JSON config file for common issues.
# Usage: bash scripts/validate-config.sh <config.json>
#
# Exit codes:
#   0 - Valid config
#   1 - File not found or not readable
#   2 - Invalid JSON
#   3 - Missing required fields
#   4 - Invalid field values

set -euo pipefail

if [[ $# -lt 1 ]] || [[ "$1" == "--help" ]] || [[ "$1" == "-h" ]]; then
    echo "Usage: bash scripts/validate-config.sh <config.json>"
    echo ""
    echo "Validates a stdiobus JSON config file for common issues."
    echo ""
    echo "Checks:"
    echo "  - File exists and is valid JSON"
    echo "  - 'pools' array is present and non-empty"
    echo "  - Each pool has 'id', 'command', 'instances'"
    echo "  - 'instances' is a positive integer"
    echo "  - 'command' path exists (warning if not)"
    echo ""
    echo "Exit codes:"
    echo "  0 - Valid"
    echo "  1 - File not found"
    echo "  2 - Invalid JSON"
    echo "  3 - Missing required fields"
    echo "  4 - Invalid field values"
    exit 0
fi

CONFIG_FILE="$1"

# Check file exists
if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "Error: File not found: $CONFIG_FILE"
    exit 1
fi

# Check valid JSON
if ! python3 -c "import json, sys; json.load(open(sys.argv[1]))" "$CONFIG_FILE" 2>/dev/null; then
    if ! jq empty "$CONFIG_FILE" 2>/dev/null; then
        echo "Error: Invalid JSON in $CONFIG_FILE"
        exit 2
    fi
fi

# Use python3 for validation (more portable than jq for complex checks)
python3 -c "
import json, sys, os

with open(sys.argv[1]) as f:
    config = json.load(f)

errors = []
warnings = []

# Check pools
if 'pools' not in config:
    errors.append(\"Missing required field: 'pools'\")
elif not isinstance(config['pools'], list):
    errors.append(\"'pools' must be an array\")
elif len(config['pools']) == 0:
    errors.append(\"'pools' array must not be empty (at least one worker pool required)\")
else:
    for i, pool in enumerate(config['pools']):
        prefix = f'pools[{i}]'
        if 'id' not in pool:
            errors.append(f'{prefix}: missing required field \"id\"')
        elif not isinstance(pool['id'], str) or len(pool['id']) == 0:
            errors.append(f'{prefix}: \"id\" must be a non-empty string')

        if 'command' not in pool:
            errors.append(f'{prefix}: missing required field \"command\"')
        elif not isinstance(pool['command'], str) or len(pool['command']) == 0:
            errors.append(f'{prefix}: \"command\" must be a non-empty string')
        else:
            cmd = pool['command']
            if cmd.startswith('/') and not os.path.exists(cmd):
                warnings.append(f'{prefix}: command not found at \"{cmd}\"')

        if 'instances' in pool:
            inst = pool['instances']
            if not isinstance(inst, int) or inst < 1:
                errors.append(f'{prefix}: \"instances\" must be a positive integer, got {inst}')

        if 'args' in pool and not isinstance(pool['args'], list):
            errors.append(f'{prefix}: \"args\" must be an array')

# Check limits (optional)
if 'limits' in config:
    limits = config['limits']
    if not isinstance(limits, dict):
        errors.append(\"'limits' must be an object\")
    else:
        for key in ['max_input_buffer', 'max_output_queue']:
            if key in limits:
                val = limits[key]
                if not isinstance(val, int) or val < 1:
                    errors.append(f'limits.{key}: must be a positive integer')

# Report
if errors:
    print('INVALID CONFIG:')
    for e in errors:
        print(f'  ✘ {e}')
    sys.exit(3 if 'Missing' in errors[0] or 'missing' in errors[0] else 4)

if warnings:
    print('VALID (with warnings):')
    for w in warnings:
        print(f'  ⚠ {w}')
else:
    print('VALID: Config is well-formed.')

sys.exit(0)
" "$CONFIG_FILE"
