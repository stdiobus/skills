/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Security invariant — classify is ASSISTIVE-ONLY (Task 32 / T32).
//
// Locks, in code AND tests, the invariant that a `classify` /
// `AssistiveClassification` result can ONLY ever suggest a skill's `layer`/`category`
// and can NEVER influence any security-relevant decision — trust tier, namespace /
// ownership, authority / allow-list, sandbox / isolation level, provider tier, or any
// admission (fetch/import/read) decision — REGARDLESS of confidence. A suggestion
// becomes authoritative metadata ONLY via explicit pin/persist by a trusted authority,
// through the single narrow `promoteAssistiveClassification` surface, which reuses the
// shared `mayPromoteClassification` gate (no duplicated promotion rule).
//
// Three layers of enforcement are exercised:
//   A. COMPILE-TIME typed boundary — the security-boundary predicates structurally
//      cannot accept a classify result type (`@ts-expect-error` assertions).
//   B. UNIT — the promotion surface refuses untrusted/unpinned hints at any confidence
//      and, when permitted, emits ONLY `layer`/`category`.
//   C. PROPERTY (fast-check) — across arbitrary hints/confidence/authority/tier, the
//      promotion polarity and the layer/category-only narrowing always hold, and the
//      admission/isolation/trust decisions are invariant to the classify hint.
//
// Validates: Requirements 7.4, 11.6  (extends design Property 13 — assistive
// classification — with the security-boundary half of the invariant).
// =============================================================================

import * as fc from 'fast-check';

import {
  promoteAssistiveClassification,
  mayPromoteAssistiveClassification,
  type AssistiveClassification,
  type ClassifyResult,
} from '../../../runtime/classify.js';
import {
  mayPromoteClassification,
  resolveTrustPolicy,
  bundledTrustPolicy,
  UNTRUSTED_DEFAULT,
  type TrustPolicy,
} from '../../../runtime/trust.js';
import {
  checkIsolation,
  checkWithinRoot,
  checkContentSize,
} from '../../../runtime/security/boundary.js';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeAssistive(result: ClassifyResult, agentId = 'agent'): AssistiveClassification {
  return { assistive: true, agentId, result, raw: JSON.stringify(result) };
}

/** A maximal-confidence hint suggesting a concrete layer/category. */
const MAXIMAL = makeAssistive({ layer: 1, category: 'concepts', confidence: 1.0 });

const TRUSTED: TrustPolicy = bundledTrustPolicy('/srv/skills/root');

// =============================================================================
// A. Compile-time typed boundary — classify types cannot reach security APIs
// =============================================================================

describe('A. typed boundary: classify result cannot flow into trust/admission APIs', () => {
  it('security-boundary predicates structurally reject classify types (compile-time)', () => {
    const assistive = MAXIMAL;
    const hint: ClassifyResult = assistive.result;

    // These calls are never executed; the test asserts they DO NOT TYPE-CHECK, which is the
    // in-code expression of the assistive-only invariant: no security-boundary predicate
    // accepts an AssistiveClassification / ClassifyResult as an input.
    if (false as boolean) {
      // Trust tier selection keys on TrustPolicy — not on a classify result.
      // @ts-expect-error AssistiveClassification is not assignable to TrustPolicy.
      resolveTrustPolicy(assistive);
      // @ts-expect-error ClassifyResult is not assignable to TrustPolicy.
      resolveTrustPolicy(hint);

      // Isolation/admission keys on TrustPolicy — not on a classify result.
      // @ts-expect-error AssistiveClassification is not assignable to TrustPolicy.
      checkIsolation(assistive, { provider: 'p', isolationAvailable: false });
      // @ts-expect-error ClassifyResult is not assignable to TrustPolicy.
      checkIsolation(hint, { provider: 'p', isolationAvailable: false });

      // The promotion gate keys on TrustPolicy — a classify result is not a policy.
      // @ts-expect-error AssistiveClassification is not assignable to TrustPolicy.
      mayPromoteClassification(assistive, { pinned: true, persisted: false });

      // Path-/size-admission key on strings/bytes — not on a classify result.
      // @ts-expect-error ClassifyResult is not assignable to a path string.
      checkWithinRoot('/root', hint, 'p');
      // @ts-expect-error ClassifyResult is not assignable to string | Buffer | number.
      checkContentSize(hint, 10, 'p');
    }

    // The narrow promotion surface returns ONLY a layer/category shape — never anything that
    // could carry trust/authority/namespace/sandbox/provider-tier information.
    const promoted = promoteAssistiveClassification(assistive, TRUSTED, {
      pinned: false,
      persisted: false,
    });
    expect(promoted).toBeDefined();
    if (promoted !== undefined) {
      expect(Object.keys(promoted).sort()).toEqual(['category', 'layer']);
    }
  });
});

// =============================================================================
// B. Unit — promotion polarity and layer/category-only narrowing
// =============================================================================

describe('B. promoteAssistiveClassification — gated, narrow promotion (Req 7.4, 11.6)', () => {
  it('refuses an untrusted, unpinned hint even at maximal confidence (1.0)', () => {
    expect(
      promoteAssistiveClassification(MAXIMAL, UNTRUSTED_DEFAULT, {
        pinned: false,
        persisted: false,
      }),
    ).toBeUndefined();
  });

  it('promotes an untrusted hint ONLY when explicitly pinned', () => {
    const out = promoteAssistiveClassification(MAXIMAL, UNTRUSTED_DEFAULT, {
      pinned: true,
      persisted: false,
    });
    expect(out).toEqual({ layer: 1, category: 'concepts' });
  });

  it('promotes an untrusted hint ONLY when explicitly persisted', () => {
    const out = promoteAssistiveClassification(MAXIMAL, UNTRUSTED_DEFAULT, {
      pinned: false,
      persisted: true,
    });
    expect(out).toEqual({ layer: 1, category: 'concepts' });
  });

  it('promotes a trusted-authority hint without pin/persist', () => {
    const out = promoteAssistiveClassification(MAXIMAL, TRUSTED, {
      pinned: false,
      persisted: false,
    });
    expect(out).toEqual({ layer: 1, category: 'concepts' });
  });

  it('emits ONLY layer/category — confidence and agent identity never cross', () => {
    const out = promoteAssistiveClassification(MAXIMAL, TRUSTED, {
      pinned: false,
      persisted: false,
    });
    expect(out).toBeDefined();
    if (out !== undefined) {
      expect(out).not.toHaveProperty('confidence');
      expect(out).not.toHaveProperty('agentId');
      expect(out).not.toHaveProperty('assistive');
      expect(out).not.toHaveProperty('raw');
    }
  });

  it('omits absent fields rather than fabricating them', () => {
    const layerOnly = makeAssistive({ layer: 3, confidence: 1.0 });
    expect(
      promoteAssistiveClassification(layerOnly, TRUSTED, { pinned: false, persisted: false }),
    ).toEqual({ layer: 3 });
  });

  it('delegates the gate verbatim to mayPromoteClassification (no duplicated rule)', () => {
    for (const policy of [UNTRUSTED_DEFAULT, TRUSTED]) {
      for (const pinned of [false, true]) {
        for (const persisted of [false, true]) {
          const opts = { pinned, persisted };
          const permitted = mayPromoteClassification(policy, opts);
          expect(mayPromoteAssistiveClassification(policy, opts)).toBe(permitted);
          const out = promoteAssistiveClassification(MAXIMAL, policy, opts);
          expect(out !== undefined).toBe(permitted);
        }
      }
    }
  });
});

// =============================================================================
// C. Unit — admission/isolation/trust decisions ignore classify output entirely
// =============================================================================

describe('C. security decisions are invariant to any classify hint (Req 11.6)', () => {
  it('trust tier is resolved from policy alone, never raised by a confident hint', () => {
    // No API accepts the hint; the tier of the untrusted default stays untrusted.
    expect(resolveTrustPolicy(UNTRUSTED_DEFAULT).tier).toBe('untrusted');
    expect(resolveTrustPolicy(undefined).tier).toBe('untrusted');
  });

  it('isolation admission keys on policy; a maximal hint cannot make it admit', () => {
    // Untrusted (isolateFetch: true) + isolation unavailable → rejected, regardless of any hint.
    const res = checkIsolation(UNTRUSTED_DEFAULT, { provider: 'p', isolationAvailable: false });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('isolation_failed');
  });
});

// =============================================================================
// D. Property — assistive-only invariant holds across all hints/confidence
// =============================================================================

const layerArb = fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined });
const categoryArb = fc.option(fc.stringMatching(/^[a-z]{1,12}$/), { nil: undefined });
// Confidence spans the full range INCLUDING the maximal 1.0 — confidence must never gate promotion.
const confidenceArb = fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: undefined });

const hintArb: fc.Arbitrary<ClassifyResult> = fc
  .record({ layer: layerArb, category: categoryArb, confidence: confidenceArb })
  .map(({ layer, category, confidence }) => {
    const r: ClassifyResult = {};
    if (layer !== undefined) r.layer = layer;
    if (category !== undefined) r.category = category;
    if (confidence !== undefined) r.confidence = confidence;
    return r;
  });

const tierArb = fc.constantFrom<TrustPolicy>(UNTRUSTED_DEFAULT, TRUSTED);

describe('D. Property: classify is assistive-only (Req 7.4, 11.6)', () => {
  it('promotion polarity follows the trusted-authority/pin/persist gate, never confidence', () => {
    fc.assert(
      fc.property(
        hintArb,
        tierArb,
        fc.boolean(),
        fc.boolean(),
        (hint, policy, pinned, persisted) => {
          const assistive = makeAssistive(hint);
          const out = promoteAssistiveClassification(assistive, policy, { pinned, persisted });

          const permitted = policy.tier === 'trusted' || pinned || persisted;

          // Polarity is decided ONLY by tier/pin/persist — confidence is irrelevant.
          expect(out !== undefined).toBe(permitted);

          if (out === undefined) {
            // Untrusted + unpinned + unpersisted → stays assistive at ANY confidence.
            expect(policy.tier).toBe('untrusted');
            expect(pinned).toBe(false);
            expect(persisted).toBe(false);
          } else {
            // Narrow surface: only layer/category cross, exactly mirroring the hint.
            const keys = Object.keys(out).sort();
            expect(keys.every((k) => k === 'layer' || k === 'category')).toBe(true);
            expect(out.layer).toBe(hint.layer);
            expect(out.category).toBe(hint.category);
          }

          // The hint NEVER alters the admission/isolation decision — that keys on policy only.
          const admit = checkIsolation(policy, { provider: 'p', isolationAvailable: false });
          // Untrusted requires isolation (unavailable here) → rejected; trusted needs none → admitted.
          expect(admit.ok).toBe(policy.tier === 'trusted');
        },
      ),
      { numRuns: 300 },
    );
  });
});
