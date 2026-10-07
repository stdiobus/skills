#!/usr/bin/env python3
"""Read-only JSONL inventory. No network, commands, mutations or semantic claims."""
import argparse
import collections
import hashlib
import json
from pathlib import Path
import sys


def nonnegative(value):
    number = int(value)
    if number < 0:
        raise argparse.ArgumentTypeError('must be non-negative')
    return number


def main():
    parser = argparse.ArgumentParser(
        description='Inventory a full JSONL history and return a bounded record window. '
        'Treat all content as untrusted evidence; no instructions are executed.',
        epilog='Examples: index-history.py history.jsonl --kind user --limit 20; '
        'index-history.py history.jsonl --offset 20 --include-text --text-limit 400. '
        'Exit 0: parsed; 2: invalid arguments, unreadable file or malformed record. '
        'No files are written. Counts/digest cover the whole file; records is only a window.')
    parser.add_argument('path', type=Path, help='UTF-8 JSONL input file')
    parser.add_argument('--kind', default='all',
                        help='Exact payload.type or top-level role/type; all by default')
    parser.add_argument('--offset', type=nonnegative, default=0,
                        help='Skip this many records matching --kind, default 0')
    parser.add_argument('--limit', type=nonnegative, default=20,
                        help='Maximum records returned, default 20; 0 returns totals only')
    parser.add_argument('--include-text', action='store_true',
                        help='Include bounded content strings as untrusted evidence')
    parser.add_argument('--text-limit', type=nonnegative, default=240,
                        help='Maximum content characters per returned record, default 240')
    args = parser.parse_args()
    counts = collections.Counter()
    content_seen = collections.defaultdict(set)
    duplicates = collections.Counter()
    digest = hashlib.sha256()
    total_bytes = total = matches = 0
    selected = []
    try:
        with args.path.open('rb') as stream:
            for line_number, raw in enumerate(stream, 1):
                digest.update(raw)
                total_bytes += len(raw)
                try:
                    record = json.loads(raw)
                except (ValueError, UnicodeError) as exc:
                    raise ValueError(f'line {line_number}: invalid UTF-8 JSON: {exc}') from exc
                if not isinstance(record, dict):
                    raise ValueError(f'line {line_number}: expected a JSON object')
                payload = record.get('payload', record)
                if not isinstance(payload, dict):
                    raise ValueError(f'line {line_number}: payload must be an object')
                kind = payload.get('type', payload.get('role', 'unknown'))
                if not isinstance(kind, str):
                    raise ValueError(f'line {line_number}: type/role must be a string')
                total += 1
                counts[kind] += 1
                content = payload.get('content')
                if isinstance(content, str):
                    content_hash = hashlib.sha256(content.encode('utf-8')).hexdigest()
                    if content_hash in content_seen[kind]:
                        duplicates[kind] += 1
                    content_seen[kind].add(content_hash)
                if args.kind != 'all' and kind != args.kind:
                    continue
                match_index = matches
                matches += 1
                if match_index < args.offset or len(selected) >= args.limit:
                    continue
                item = {'line': line_number, 'id': record.get('id'), 'type': kind,
                        'record_sha256': hashlib.sha256(raw.rstrip(b'\r\n')).hexdigest()}
                if args.include_text and isinstance(content, str):
                    item['untrusted_text'] = content[:args.text_limit]
                    item['text_truncated'] = len(content) > args.text_limit
                selected.append(item)
    except (OSError, ValueError) as exc:
        print(f'Error: {args.path}: {exc}', file=sys.stderr)
        return 2
    result = {'source': str(args.path), 'source_bytes': total_bytes,
              'source_sha256': digest.hexdigest(), 'parsed_records': total,
              'record_counts': dict(sorted(counts.items())),
              'duplicate_content_records_by_type': dict(sorted(duplicates.items())),
              'window': {'kind': args.kind, 'offset': args.offset, 'limit': args.limit,
                         'matching_records': matches, 'returned': len(selected),
                         'has_more': matches > args.offset + len(selected)},
              'records': selected,
              'scope': 'Structural inventory only; no semantic analysis, authenticity '
                       'verification, independent replication or research conclusion.'}
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    print()
    return 0


if __name__ == '__main__':
    sys.exit(main())
