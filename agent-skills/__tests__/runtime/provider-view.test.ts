/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Unit tests — provider VIEW abstractions (Migration Step 3, Task 4.1; design
// §"Components" 5, Req 10.1, 10.5, 10.6).
//
// Subjects under test (runtime/registry.ts):
//   - ProviderView            (interface, exercised via the two implementations)
//   - ConstantProviderView    (baseline wrapper — returns the fixed array verbatim)
//   - MutableProviderView     (copy-on-write `admit`, add-only — no remove/dispose)
//
// Invariants validated:
//   1. ConstantProviderView returns the EXACT same array reference, order, and
//      provider identities it was given (byte-for-byte baseline; Req 10.1).
//   2. MutableProviderView.admit is COPY-ON-WRITE: a previously-captured
//      providers() snapshot is unaffected by a later admit (Req 10.5).
//   3. MutableProviderView is ADD-ONLY: no remove/dispose/evict method exists,
//      and admit appends at the end preserving precedence order (Req 10.6).
//
// Validates: Requirements 10.1, 10.5, 10.6
// =============================================================================

import {
  ConstantProviderView,
  MutableProviderView,
  type ProviderView,
} from '../../runtime/registry.js';
import type {
  ResolvedSkill,
  SkillProvider,
  SkillRef,
} from '../../runtime/contract.js';

// -----------------------------------------------------------------------------
// Minimal real SkillProvider — identity is all these tests need; the body is a
// no-op resolve. No mocking of the views under test.
// -----------------------------------------------------------------------------

function makeProvider(id: string): SkillProvider {
  return {
    id,
    capabilities: { read: false, list: false, search: false, references: false },
    async resolve(_ref: SkillRef): Promise<ResolvedSkill[]> {
      return [];
    },
  };
}

// =============================================================================
// Invariant 1 — ConstantProviderView returns the fixed array verbatim (Req 10.1)
// =============================================================================

describe('ConstantProviderView — byte-for-byte baseline wrapper (Req 10.1)', () => {
  it('returns the EXACT same array reference it was constructed with', () => {
    const fixed: ReadonlyArray<SkillProvider> = [makeProvider('a'), makeProvider('b')];
    const view = new ConstantProviderView(fixed);

    // Same reference: a pure structural adapter, no defensive copy that would change
    // the inputs handed to dedupeWithConflicts (design fix 9).
    expect(view.providers()).toBe(fixed);
  });

  it('preserves provider order and identity (same references, same ids)', () => {
    const a = makeProvider('a');
    const b = makeProvider('b');
    const c = makeProvider('c');
    const view: ProviderView = new ConstantProviderView([a, b, c]);

    const out = view.providers();
    expect(out.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
    expect(out[2]).toBe(c);
  });

  it('returns a stable snapshot across repeated calls', () => {
    const view = new ConstantProviderView([makeProvider('only')]);
    expect(view.providers()).toBe(view.providers());
  });
});

// =============================================================================
// Invariant 2 — MutableProviderView.admit is copy-on-write (Req 10.5)
// =============================================================================

describe('MutableProviderView — copy-on-write admit (Req 10.5)', () => {
  it('a snapshot captured BEFORE admit is unaffected by a LATER admit', () => {
    const view = new MutableProviderView([makeProvider('bundled')]);

    // Capture the snapshot an "in-flight operation" would hold at entry.
    const snapshot = view.providers();
    expect(snapshot.map((p) => p.id)).toEqual(['bundled']);

    // Admission interleaves AFTER the snapshot was captured.
    view.admit(makeProvider('admitted'));

    // The captured snapshot is frozen — the admit allocated a fresh array.
    expect(snapshot.map((p) => p.id)).toEqual(['bundled']);
    expect(view.providers()).not.toBe(snapshot);
    expect(view.providers().map((p) => p.id)).toEqual(['bundled', 'admitted']);
  });

  it('does not retain a reference to the caller-supplied seed array', () => {
    const seed: SkillProvider[] = [makeProvider('seed')];
    const view = new MutableProviderView(seed);

    // Mutating the original seed array after construction must not reach the view.
    seed.push(makeProvider('leaked'));
    expect(view.providers().map((p) => p.id)).toEqual(['seed']);
  });

  it('defaults to an empty provider set', () => {
    const view = new MutableProviderView();
    expect(view.providers()).toEqual([]);
  });
});

// =============================================================================
// Invariant 3 — MutableProviderView is add-only, append-at-end (Req 10.6)
// =============================================================================

describe('MutableProviderView — add-only precedence (Req 10.6)', () => {
  it('admit appends at the END, preserving precedence order', () => {
    const view = new MutableProviderView([makeProvider('first')]);
    view.admit(makeProvider('second'));
    view.admit(makeProvider('third'));
    expect(view.providers().map((p) => p.id)).toEqual(['first', 'second', 'third']);
  });

  it('exposes NO remove/dispose/evict operation (add-only milestone)', () => {
    const view = new MutableProviderView() as unknown as Record<string, unknown>;
    expect(typeof view['remove']).toBe('undefined');
    expect(typeof view['dispose']).toBe('undefined');
    expect(typeof view['evict']).toBe('undefined');
    expect(typeof view['delete']).toBe('undefined');
  });
});
