/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Property-based tests for ParamCodec round-trip equivalence
// (Migration Step 5, Task 7.5).
//
// Subject: agent-skills/runtime/transport/param-codec.ts — the single
// transport-boundary codec. `encode(cap, x)` turns a typed capability input
// into a JSON-serializable params object; `decode(method, params)` validates
// and reconstructs the typed input (or returns a typed error, never throws).
//
// Property 6: ParamCodec round-trip equivalence (design §"Property 6", §3c)
//   For ALL valid typed capability inputs `x`, `decode(encode(x))` is
//   SEMANTICALLY equivalent to `x`. The codec's documented normalization policy
//   (Req 10.6) is that explicit-`undefined` optional fields are normalized to
//   ABSENT (encode does a `JSON.parse(JSON.stringify(...))` round trip, which
//   drops `undefined`-valued keys at any depth). So equivalence is asserted
//   against `x` with explicit-`undefined` optionals stripped recursively.
//
// Validates: Requirements 10.6
//
// The generators below cover EACH core capability input and EVERY `SkillRef`
// arm (fqid, name with/without provider, descriptor with/without its optional
// fields), and deliberately exercise all three states of every optional field:
// absent, explicitly `undefined`, and present — so the normalization-to-absent
// policy is genuinely tested, not assumed. Numeric fields are generated as
// integers and string/boolean fields as plain JSON scalars so that every
// generated input is JSON-round-trippable (the codec's stated input space);
// this keeps the property a real round-trip law rather than an artifact of
// unconstrained, non-serializable inputs.
// =============================================================================

import * as fc from 'fast-check';
import { ParamCodec } from '../../../../runtime/transport/param-codec.js';
import { SkillsCapabilities } from '../../../../runtime/capabilities.js';
import type { CapabilityRef } from '../../../../runtime/contract.js';

// -----------------------------------------------------------------------------
// Semantic-equivalence normalization
//
// Recursively removes keys whose value is `undefined`. This mirrors EXACTLY the
// codec policy (Req 10.6): encode's JSON round trip drops `undefined`-valued
// properties at any depth, so the decoded input is `x` with those keys absent.
// Comparing decoded input to `stripUndefined(x)` with `toStrictEqual` (which,
// unlike `toEqual`, does NOT silently ignore `undefined` properties) makes the
// normalization claim an explicit, falsifiable assertion.
// -----------------------------------------------------------------------------

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefined);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (val === undefined) continue;
      out[key] = stripUndefined(val);
    }
    return out;
  }
  return value;
}

// -----------------------------------------------------------------------------
// Optional-field generator — yields one of three states for `key`:
//   1. the key is ABSENT          ({})
//   2. the key is EXPLICIT undefined ({ [key]: undefined })
//   3. the key is PRESENT with a value
// States 1 and 2 must round-trip to the SAME shape (key absent); state 3 must
// round-trip unchanged. Exercising all three is what makes the property bite.
// -----------------------------------------------------------------------------

function optionalField(
  key: string,
  arb: fc.Arbitrary<unknown>,
): fc.Arbitrary<Record<string, unknown>> {
  return fc.oneof(
    fc.constant<Record<string, unknown>>({}),
    fc.constant<Record<string, unknown>>({ [key]: undefined }),
    arb.map((value) => ({ [key]: value })),
  );
}

// JSON-round-trippable scalar generators. `min(1)` strings cover the codec's
// required non-empty fields; integers avoid NaN/Infinity/-0 (none survive a
// JSON round trip cleanly), keeping inputs strictly within the valid space.
const nonEmptyStr = fc.string({ minLength: 1 });
const anyStr = fc.string();
const intArb = fc.integer();

// -----------------------------------------------------------------------------
// SkillRef arm generators (open-world addressing union)
// -----------------------------------------------------------------------------

/** `{ kind: 'fqid'; fqid }` — fqid is a required non-empty string. */
const fqidRefArb = nonEmptyStr.map((fqid) => ({ kind: 'fqid', fqid }));

/** `{ kind: 'name'; name; provider? }` — provider optional (absent/undef/value). */
const nameRefArb = fc
  .tuple(nonEmptyStr, optionalField('provider', anyStr))
  .map(([name, provider]) => ({ kind: 'name', name, ...provider }));

/** A SkillDescriptor: 4 required strings + 3 optional fields in all 3 states. */
const descriptorArb = fc
  .tuple(
    nonEmptyStr, // fqid
    nonEmptyStr, // name
    nonEmptyStr, // provider
    nonEmptyStr, // source
    optionalField('layer', intArb),
    optionalField('category', anyStr),
    optionalField('pinned', fc.boolean()),
  )
  .map(([fqid, name, provider, source, layer, category, pinned]) => ({
    fqid,
    name,
    provider,
    source,
    ...layer,
    ...category,
    ...pinned,
  }));

/** `{ kind: 'descriptor'; descriptor }`. */
const descriptorRefArb = descriptorArb.map((descriptor) => ({
  kind: 'descriptor',
  descriptor,
}));

/** The full SkillRef union — every arm reachable. */
const skillRefArb = fc.oneof(fqidRefArb, nameRefArb, descriptorRefArb);

// -----------------------------------------------------------------------------
// Per-capability valid-input generators
// -----------------------------------------------------------------------------

/** read / getReferences share `{ ref }`. */
const refInputArb = skillRefArb.map((ref) => ({ ref }));

/** list: `{ provider? }`. */
const listInputArb = optionalField('provider', anyStr);

/** search: `{ query; limit? }` (query has no min in the schema). */
const searchInputArb = fc
  .tuple(anyStr, optionalField('limit', intArb))
  .map(([query, limit]) => ({ query, ...limit }));

/** readReference: `{ ref; reference }` (reference is a required non-empty string). */
const readReferenceInputArb = fc
  .tuple(skillRefArb, nonEmptyStr)
  .map(([ref, reference]) => ({ ref, reference }));

// -----------------------------------------------------------------------------
// The capabilities under test, paired with their valid-input generator. `cap`
// is widened to CapabilityRef<unknown, unknown> because the input type is
// selected at runtime by the generator, not statically.
// -----------------------------------------------------------------------------

interface RoundTripCase {
  readonly label: string;
  readonly cap: CapabilityRef<unknown, unknown>;
  readonly arb: fc.Arbitrary<unknown>;
}

const CASES: readonly RoundTripCase[] = [
  { label: 'read', cap: SkillsCapabilities.read as CapabilityRef<unknown, unknown>, arb: refInputArb },
  { label: 'list', cap: SkillsCapabilities.list as CapabilityRef<unknown, unknown>, arb: listInputArb },
  {
    label: 'search',
    cap: SkillsCapabilities.search as CapabilityRef<unknown, unknown>,
    arb: searchInputArb,
  },
  {
    label: 'listReferences',
    cap: SkillsCapabilities.listReferences as CapabilityRef<unknown, unknown>,
    arb: refInputArb,
  },
  {
    label: 'readReference',
    cap: SkillsCapabilities.readReference as CapabilityRef<unknown, unknown>,
    arb: readReferenceInputArb,
  },
];

// =============================================================================
// Property 6: decode(encode(x)) is semantically equivalent to x (Req 10.6)
// =============================================================================

describe('Property 6: ParamCodec round-trip equivalence (Req 10.6)', () => {
  for (const { label, cap, arb } of CASES) {
    it(`${label}: decode(encode(x)) === x (explicit-undefined optionals normalized to absent)`, () => {
      fc.assert(
        fc.property(arb, (input) => {
          const params = ParamCodec.encode(cap, input);
          const result = ParamCodec.decode(cap.method, params);

          // Valid inputs always decode successfully — the boundary is total.
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          // Semantic equivalence: equal to x after stripping explicit-undefined
          // optionals (the codec's normalization-to-absent policy, Req 10.6).
          expect(result.input).toStrictEqual(stripUndefined(input));
        }),
        { numRuns: 300 },
      );
    });

    it(`${label}: encode(x) is JSON-serializable (stable under a JSON round trip)`, () => {
      fc.assert(
        fc.property(arb, (input) => {
          const params = ParamCodec.encode(cap, input);
          expect(params).toStrictEqual(JSON.parse(JSON.stringify(params)));
        }),
        { numRuns: 300 },
      );
    });
  }
});

// =============================================================================
// Documented normalization example (Req 10.6) — a `name` ref carrying an
// explicit `provider: undefined` round-trips to the same ref with `provider`
// ABSENT. Pinned as an example test so the policy is legible at a glance.
// =============================================================================

describe('Property 6: explicit-undefined optional normalizes to absent (example)', () => {
  it("name ref { provider: undefined } round-trips to { kind:'name', name }", () => {
    const readCap = SkillsCapabilities.read as CapabilityRef<unknown, unknown>;
    const input = { ref: { kind: 'name', name: 'runtime-concepts', provider: undefined } };

    const params = ParamCodec.encode(readCap, input);
    // encode already drops the explicit-undefined key on the wire.
    expect(params).toStrictEqual({ ref: { kind: 'name', name: 'runtime-concepts' } });

    const result = ParamCodec.decode(SkillsCapabilities.read.method, params);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input).toStrictEqual({ ref: { kind: 'name', name: 'runtime-concepts' } });
  });

  it('absent and explicit-undefined optionals decode to the same value', () => {
    const absent = ParamCodec.decode(
      SkillsCapabilities.list.method,
      ParamCodec.encode(SkillsCapabilities.list, {}),
    );
    const explicit = ParamCodec.decode(
      SkillsCapabilities.list.method,
      ParamCodec.encode(SkillsCapabilities.list, { provider: undefined }),
    );
    expect(absent.ok).toBe(true);
    expect(explicit.ok).toBe(true);
    if (!absent.ok || !explicit.ok) return;
    expect(absent.input).toStrictEqual(explicit.input);
    expect(absent.input).toStrictEqual({});
  });
});
