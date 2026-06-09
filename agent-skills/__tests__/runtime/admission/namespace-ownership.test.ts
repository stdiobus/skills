/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Unit + property tests — NamespaceOwnershipTable
// (Milestone-002, Task 3; design §"Components" 3; Req 5).
//
// Subject under test:
//   - runtime/admission/namespace-ownership.ts
//       claim(namespace, providerId): unowned & not reserved → claim, else typed error
//       owns(namespace): owning providerId | undefined
//       permits(providerId, fqid): parse FQID → prefix check (anti-spoofing)
//
// Behavior verified:
//   - claiming `bundled` (reserved) or an already-owned namespace is rejected (Req 5.3)
//   - an out-of-namespace FQID fails `permits` (Req 5.4)
//   - for any registered provider, a returned FQID outside its namespace is rejected
//     on the child id, never masked by aggregation (Req 5.4, 5.5; design Property 4)
//
// Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5
// =============================================================================

import * as fc from 'fast-check';

import { NamespaceOwnershipTable } from '../../../runtime/admission/namespace-ownership.js';
import { formatFqid } from '../../../runtime/fqid.js';

describe('NamespaceOwnershipTable — claim (Req 5.2, 5.3)', () => {
  it('claims an unowned, non-reserved namespace', () => {
    const table = new NamespaceOwnershipTable();

    const result = table.claim('acme', 'acme');

    expect(result.ok).toBe(true);
    expect(table.owns('acme')).toBe('acme');
  });

  it('rejects claiming the reserved `bundled` namespace (Req 5.3)', () => {
    const table = new NamespaceOwnershipTable();

    const result = table.claim('bundled', 'attacker');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('bad_request');
    }
    // No partial registration: bundled is never recorded as owned by the attacker.
    expect(table.owns('bundled')).toBeUndefined();
  });

  it('rejects claiming an already-owned namespace (Req 5.2, 5.3)', () => {
    const table = new NamespaceOwnershipTable();
    expect(table.claim('acme', 'acme').ok).toBe(true);

    const second = table.claim('acme', 'other-provider');

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('bad_request');
    }
    // Ownership is unchanged — the first claimant keeps the namespace.
    expect(table.owns('acme')).toBe('acme');
  });

  it('rejects an empty namespace', () => {
    const table = new NamespaceOwnershipTable();

    const result = table.claim('', 'p');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('bad_request');
    }
  });

  it('allows distinct providers to own distinct namespaces', () => {
    const table = new NamespaceOwnershipTable();

    expect(table.claim('acme', 'acme').ok).toBe(true);
    expect(table.claim('globex', 'globex').ok).toBe(true);

    expect(table.owns('acme')).toBe('acme');
    expect(table.owns('globex')).toBe('globex');
  });
});

describe('NamespaceOwnershipTable — owns (Req 5.2)', () => {
  it('returns undefined for an unowned namespace', () => {
    const table = new NamespaceOwnershipTable();

    expect(table.owns('acme')).toBeUndefined();
  });

  it('returns undefined for the reserved `bundled` namespace (never claimed externally)', () => {
    const table = new NamespaceOwnershipTable();

    expect(table.owns('bundled')).toBeUndefined();
  });
});

describe('NamespaceOwnershipTable — permits / anti-spoofing (Req 5.4, 5.5)', () => {
  it('permits an FQID under the namespace the provider owns', () => {
    const table = new NamespaceOwnershipTable();
    table.claim('acme', 'acme');

    expect(table.permits('acme', 'acme:widget')).toBe(true);
  });

  it('permits an FQID with a version suffix under the owned namespace', () => {
    const table = new NamespaceOwnershipTable();
    table.claim('acme', 'acme');

    expect(table.permits('acme', 'acme:widget@1.2.0')).toBe(true);
  });

  it('rejects an out-of-namespace FQID (different prefix) (Req 5.4)', () => {
    const table = new NamespaceOwnershipTable();
    table.claim('acme', 'acme');

    // acme tries to mint under another prefix → not permitted.
    expect(table.permits('acme', 'globex:widget')).toBe(false);
  });

  it("rejects an FQID spoofing the reserved `bundled` prefix (Req 5.3, 5.4)", () => {
    const table = new NamespaceOwnershipTable();
    table.claim('acme', 'acme');

    expect(table.permits('acme', 'bundled:core-skill')).toBe(false);
  });

  it("rejects an FQID under another provider's owned namespace (Req 5.4)", () => {
    const table = new NamespaceOwnershipTable();
    table.claim('acme', 'acme');
    table.claim('globex', 'globex');

    // acme cannot mint under globex's namespace even though globex is owned.
    expect(table.permits('acme', 'globex:widget')).toBe(false);
    // globex can mint under its own.
    expect(table.permits('globex', 'globex:widget')).toBe(true);
  });

  it('rejects a malformed FQID (no provider prefix)', () => {
    const table = new NamespaceOwnershipTable();
    table.claim('acme', 'acme');

    expect(table.permits('acme', 'no-colon-here')).toBe(false);
    expect(table.permits('acme', '')).toBe(false);
  });

  it('rejects any FQID when the provider owns no namespace', () => {
    const table = new NamespaceOwnershipTable();

    expect(table.permits('ghost', 'ghost:widget')).toBe(false);
  });
});

// ─── Property-based tests (fast-check) ────────────────────────────────────────

// Smart generators constrained to the FQID grammar's segment space: a non-empty
// kebab-ish token with no ':' or '@' so it is a single, well-formed FQID segment.
const arbSegment: fc.Arbitrary<string> = fc
  .stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')), {
    minLength: 1,
    maxLength: 24,
  })
  .filter((s) => s.length > 0);

describe('NamespaceOwnershipTable — properties (Req 5.3, 5.4; design Property 4)', () => {
  it('claiming `bundled` is always rejected for any provider id', () => {
    fc.assert(
      fc.property(arbSegment, (providerId) => {
        const table = new NamespaceOwnershipTable();
        const result = table.claim('bundled', providerId);
        expect(result.ok).toBe(false);
        expect(table.owns('bundled')).toBeUndefined();
      }),
    );
  });

  it('claiming an already-owned namespace is always rejected (idempotent ownership)', () => {
    fc.assert(
      fc.property(arbSegment, arbSegment, arbSegment, (namespace, first, second) => {
        fc.pre(namespace !== 'bundled');
        const table = new NamespaceOwnershipTable();

        expect(table.claim(namespace, first).ok).toBe(true);
        const again = table.claim(namespace, second);

        expect(again.ok).toBe(false);
        // Ownership stays with the first claimant regardless of the second attempt.
        expect(table.owns(namespace)).toBe(first);
      }),
    );
  });

  it('Property 4: a registered provider may mint only FQIDs under its own namespace', () => {
    fc.assert(
      fc.property(arbSegment, arbSegment, arbSegment, (namespace, otherPrefix, name) => {
        fc.pre(namespace !== 'bundled');
        fc.pre(otherPrefix !== namespace);

        const table = new NamespaceOwnershipTable();
        const providerId = namespace; // id derived from namespace (Req 3.5)
        expect(table.claim(namespace, providerId).ok).toBe(true);

        // An in-namespace FQID is permitted.
        const ownFqid = formatFqid({ provider: namespace, name });
        expect(table.permits(providerId, ownFqid)).toBe(true);

        // Any FQID outside the owned namespace is rejected on the child id.
        const foreignFqid = formatFqid({ provider: otherPrefix, name });
        expect(table.permits(providerId, foreignFqid)).toBe(false);

        // Spoofing the reserved first-party prefix is rejected too.
        const spoofBundled = formatFqid({ provider: 'bundled', name });
        expect(table.permits(providerId, spoofBundled)).toBe(false);
      }),
    );
  });

  it('permits is anchored to the exact owner: a different provider id is never permitted', () => {
    fc.assert(
      fc.property(arbSegment, arbSegment, arbSegment, (namespace, intruder, name) => {
        fc.pre(namespace !== 'bundled');
        fc.pre(intruder !== namespace);

        const table = new NamespaceOwnershipTable();
        expect(table.claim(namespace, namespace).ok).toBe(true);

        const fqid = formatFqid({ provider: namespace, name });
        // The owner is permitted; an intruder claiming the same FQID is not.
        expect(table.permits(namespace, fqid)).toBe(true);
        expect(table.permits(intruder, fqid)).toBe(false);
      }),
    );
  });
});
