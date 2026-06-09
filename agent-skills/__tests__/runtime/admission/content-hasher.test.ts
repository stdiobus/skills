/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Unit tests — ContentHasher (record-only) + default SHA-256 implementation
// (Milestone-002, Task 7.2; design §"Components" 4; Req 8.2).
//
// Subject under test:
//   - runtime/admission/content-hasher.ts
//       ContentHasher          the record-only hash seam (swappable algorithm)
//       Sha256ContentHasher    default: lowercase-hex SHA-256 over acquired bytes
//       defaultContentHasher   shared default instance
//
// Behavior verified:
//   - stable hash for identical bytes (string and Buffer agree on UTF-8 content)
//   - differing bytes → differing hash
//   - matches the canonical SHA-256 test vector (locks the algorithm)
//
// Validates: Requirements 8.2
// =============================================================================

import { createHash } from 'node:crypto';
import * as fc from 'fast-check';

import {
  ContentHasher,
  Sha256ContentHasher,
  defaultContentHasher,
} from '../../../runtime/admission/content-hasher.js';

const hasher: ContentHasher = new Sha256ContentHasher();

describe('Sha256ContentHasher — stable hash for identical bytes (Req 8.2)', () => {
  it('produces an identical digest for the same string input', () => {
    expect(hasher.hash('skill body content')).toBe(hasher.hash('skill body content'));
  });

  it('produces an identical digest for the same Buffer input', () => {
    const bytes = Buffer.from('skill body content', 'utf8');
    expect(hasher.hash(bytes)).toBe(hasher.hash(Buffer.from('skill body content', 'utf8')));
  });

  it('hashes a string and its UTF-8 Buffer identically', () => {
    const body = '# SKILL\n\nbody with unicode: café — ✓';
    expect(hasher.hash(body)).toBe(hasher.hash(Buffer.from(body, 'utf8')));
  });

  it('matches the canonical SHA-256 vector for "abc" (algorithm lock)', () => {
    expect(hasher.hash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('returns a 64-char lowercase hex digest', () => {
    expect(hasher.hash('anything')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('Sha256ContentHasher — differing bytes → differing hash (Req 8.2)', () => {
  it('produces a different digest for a single-byte difference', () => {
    expect(hasher.hash('skill body content')).not.toBe(hasher.hash('skill body contend'));
  });

  it('distinguishes the empty input from non-empty input', () => {
    expect(hasher.hash('')).not.toBe(hasher.hash('x'));
  });

  // Property: equal inputs hash equal; differing inputs hash differing. (Validates: Requirements 8.2)
  it('property: identical inputs collide, distinct inputs do not', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        // Determinism: the same input always yields the same digest.
        expect(hasher.hash(a)).toBe(hasher.hash(a));
        // Difference: distinct UTF-8 inputs yield distinct digests (no SHA-256 collisions here).
        if (a !== b) {
          expect(hasher.hash(a)).not.toBe(hasher.hash(b));
        }
      }),
    );
  });

  it('property: hashing a string equals hashing its UTF-8 buffer', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(hasher.hash(s)).toBe(hasher.hash(Buffer.from(s, 'utf8')));
      }),
    );
  });
});

describe('defaultContentHasher — shared default instance', () => {
  it('is a SHA-256 hasher equivalent to a fresh Sha256ContentHasher', () => {
    expect(defaultContentHasher.hash('payload')).toBe(hasher.hash('payload'));
  });

  it('agrees with a direct node:crypto SHA-256 computation', () => {
    const expected = createHash('sha256').update(Buffer.from('payload', 'utf8')).digest('hex');
    expect(defaultContentHasher.hash('payload')).toBe(expected);
  });
});
