/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Property-based tests for the FQID grammar boundary (Migration Step 1, Task 3.2)
//
// Subject: agent-skills/runtime/fqid.ts — the single place that formats/parses
// Fully-Qualified Skill Ids and guards descriptor identity (no partial FQID).
//
// Property 5: FQID stability & distinctness (design §"Property 5", §5)
//   `formatFqid` is a pure function of `(provider, name, version?)`:
//     - equal parts            → equal FQID            (stability, a stable key)
//     - differing `provider`   → distinct FQID         (provider distinctness)
//     - differing `version`    → distinct FQID         (version distinctness)
//     - same `name` across providers → distinct FQID   (cross-provider distinctness)
//   A descriptor missing `provider` or `name` is REJECTED with a returned error
//   and NO placeholder/partial FQID is minted (descriptor guard).
//
// Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.7
//
// Generators are constrained to the INTERIM grammar's segment alphabet
// (segment := [a-z0-9][a-z0-9._-]*) so that the format is injective and the
// distinctness assertions test a genuine property rather than an artifact of
// unconstrained input. `version` is generated as `:`/`@`-free so it never
// perturbs the `provider:` / `@version` delimiters.
// =============================================================================

import * as fc from 'fast-check';
import {
  formatFqid,
  parseFqid,
  descriptorFqid,
  FQID_MAX_BYTES,
} from '../../../runtime/fqid.js';
import type { FqidParts } from '../../../runtime/fqid.js';

// -----------------------------------------------------------------------------
// Grammar-conformant generators (smart generators constrained to the input space)
// -----------------------------------------------------------------------------

const HEAD_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
const TAIL_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789._-'.split('');

/** segment := [a-z0-9] [a-z0-9._-]*  — never contains ':' or '@'. */
const segmentArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...HEAD_CHARS),
    fc.array(fc.constantFrom(...TAIL_CHARS), { maxLength: 11 }),
  )
  .map(([head, tail]) => head + tail.join(''));

/** Provider id segment (e.g. "bundled", "npm", "registry.acme"). */
const providerArb = segmentArb;

/** Skill name segment (kebab-case style). */
const nameArb = segmentArb;

/** Declared version — semver-shaped, `:`/`@`-free so delimiters stay intact. */
const versionArb: fc.Arbitrary<string> = fc
  .tuple(fc.nat(99), fc.nat(99), fc.nat(99))
  .map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

/** Optional version: present (declared) or absent (undefined). */
const optVersionArb: fc.Arbitrary<string | undefined> = fc.option(versionArb, {
  nil: undefined,
});

/** A full, grammar-conformant FqidParts triple. */
const partsArb: fc.Arbitrary<FqidParts> = fc.record(
  {
    provider: providerArb,
    name: nameArb,
    version: optVersionArb,
  },
  { requiredKeys: ['provider', 'name'] },
);

// =============================================================================
// Stability — equal parts → equal FQID (Req 5.4)
// =============================================================================

describe('Property 5: FQID stability (Req 5.4)', () => {
  it('formatFqid is deterministic: the same parts produce the same FQID', () => {
    fc.assert(
      fc.property(partsArb, (parts) => {
        expect(formatFqid(parts)).toBe(formatFqid(parts));
      }),
      { numRuns: 200 },
    );
  });

  it('structurally-equal but distinct parts objects produce an equal FQID', () => {
    fc.assert(
      fc.property(providerArb, nameArb, optVersionArb, (provider, name, version) => {
        const a: FqidParts = { provider, name, version };
        const b: FqidParts = { provider, name, version };
        expect(a).not.toBe(b); // different object identities
        expect(formatFqid(a)).toBe(formatFqid(b)); // same value
      }),
      { numRuns: 200 },
    );
  });

  it('formatFqid is injective on grammar-conformant parts (round-trips through parseFqid)', () => {
    // Injectivity is the foundation of the distinctness invariants below: if the
    // formatted FQID round-trips back to the original parts, equal FQIDs imply
    // equal parts, so differing parts must yield differing FQIDs.
    fc.assert(
      fc.property(partsArb, (parts) => {
        const parsed = parseFqid(formatFqid(parts));
        expect(parsed).not.toBeNull();
        expect(parsed!.provider).toBe(parts.provider);
        expect(parsed!.name).toBe(parts.name);
        expect(parsed!.version).toBe(parts.version);
      }),
      { numRuns: 200 },
    );
  });
});

// =============================================================================
// Distinctness — differing provider/version → distinct FQID (Req 5.2, 5.3)
// =============================================================================

describe('Property 5: FQID distinctness (Req 5.1, 5.2, 5.3)', () => {
  it('differing provider (same name, same version) → distinct FQID', () => {
    fc.assert(
      fc.property(providerArb, providerArb, nameArb, optVersionArb, (p1, p2, name, version) => {
        fc.pre(p1 !== p2);
        expect(formatFqid({ provider: p1, name, version })).not.toBe(
          formatFqid({ provider: p2, name, version }),
        );
      }),
      { numRuns: 200 },
    );
  });

  it('differing version (same provider, same name) → distinct FQID', () => {
    fc.assert(
      fc.property(providerArb, nameArb, optVersionArb, optVersionArb, (provider, name, v1, v2) => {
        fc.pre(v1 !== v2);
        expect(formatFqid({ provider, name, version: v1 })).not.toBe(
          formatFqid({ provider, name, version: v2 }),
        );
      }),
      { numRuns: 200 },
    );
  });

  it('same name across different providers → distinct FQID (Req 5.2)', () => {
    fc.assert(
      fc.property(providerArb, providerArb, nameArb, (p1, p2, name) => {
        fc.pre(p1 !== p2);
        // Two skills sharing the same `name` but owned by different providers
        // must receive distinct FQIDs.
        expect(formatFqid({ provider: p1, name })).not.toBe(
          formatFqid({ provider: p2, name }),
        );
      }),
      { numRuns: 200 },
    );
  });

  it('any two grammar-conformant parts that differ in any field → distinct FQID', () => {
    fc.assert(
      fc.property(partsArb, partsArb, (a, b) => {
        const sameTriple =
          a.provider === b.provider && a.name === b.name && a.version === b.version;
        fc.pre(!sameTriple);
        expect(formatFqid(a)).not.toBe(formatFqid(b));
      }),
      { numRuns: 300 },
    );
  });
});

// =============================================================================
// No-partial-FQID guard — example tests (Req 5.7)
//
// A descriptor lacking `provider` or `name` is rejected with a RETURNED error
// and NO placeholder FQID is minted.
// =============================================================================

describe('Property 5: no partial/placeholder FQID is minted (Req 5.7)', () => {
  it('missing provider is rejected with bad_request and mints no FQID', () => {
    const result = descriptorFqid({ name: 'runtime-concepts' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('bad_request');
    if (result.error.code === 'bad_request') {
      expect(result.error.issues.some((i) => i.includes('provider'))).toBe(true);
    }
    // No placeholder FQID leaked onto the result object.
    expect((result as { fqid?: unknown }).fqid).toBeUndefined();
  });

  it('missing name is rejected with bad_request and mints no FQID', () => {
    const result = descriptorFqid({ provider: 'bundled' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('bad_request');
    if (result.error.code === 'bad_request') {
      expect(result.error.issues.some((i) => i.includes('name'))).toBe(true);
    }
    expect((result as { fqid?: unknown }).fqid).toBeUndefined();
  });

  it('missing both provider and name reports both issues, mints no FQID', () => {
    const result = descriptorFqid({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('bad_request');
    if (result.error.code === 'bad_request') {
      expect(result.error.issues.some((i) => i.includes('provider'))).toBe(true);
      expect(result.error.issues.some((i) => i.includes('name'))).toBe(true);
    }
    expect((result as { fqid?: unknown }).fqid).toBeUndefined();
  });

  it('empty-string provider or name counts as missing (no FQID minted)', () => {
    expect(descriptorFqid({ provider: '', name: 'alpha' }).ok).toBe(false);
    expect(descriptorFqid({ provider: 'bundled', name: '' }).ok).toBe(false);
  });

  it('a complete identity mints the stable FQID produced by formatFqid', () => {
    const result = descriptorFqid({ provider: 'bundled', name: 'runtime-concepts' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fqid).toBe('bundled:runtime-concepts');
    expect(result.fqid).toBe(formatFqid({ provider: 'bundled', name: 'runtime-concepts' }));
  });

  it('a complete versioned identity mints the @version-suffixed FQID', () => {
    const result = descriptorFqid({ provider: 'npm', name: 'alpha', version: '1.2.3' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fqid).toBe('npm:alpha@1.2.3');
  });
});

// =============================================================================
// Property 5 (guard, generative): the no-partial rule holds for ALL identities
// that are missing provider and/or name, never minting a placeholder FQID.
// =============================================================================

describe('Property 5: no-partial-FQID guard holds for all incomplete identities (Req 5.7)', () => {
  it('any identity missing provider and/or name is rejected, no FQID minted', () => {
    // Generate identities where at least one required field is absent/empty.
    const incompleteArb = fc
      .record(
        {
          provider: fc.option(providerArb, { nil: undefined }),
          name: fc.option(nameArb, { nil: undefined }),
          version: optVersionArb,
        },
        { requiredKeys: [] },
      )
      .filter((id) => !id.provider || !id.name);

    fc.assert(
      fc.property(incompleteArb, (identity) => {
        const result = descriptorFqid(identity);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('bad_request');
        // Crucially: no placeholder/partial FQID is present on the rejection.
        expect((result as { fqid?: unknown }).fqid).toBeUndefined();
      }),
      { numRuns: 200 },
    );
  });

  it('any complete grammar-conformant identity mints an FQID within the interim byte bound', () => {
    fc.assert(
      fc.property(partsArb, (parts) => {
        const result = descriptorFqid(parts);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.fqid).toBe(formatFqid(parts));
        expect(Buffer.byteLength(result.fqid, 'utf8')).toBeLessThanOrEqual(FQID_MAX_BYTES);
      }),
      { numRuns: 200 },
    );
  });
});
