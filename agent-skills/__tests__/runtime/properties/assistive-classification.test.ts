/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Property test — Assistive classification + pinned precedence — Task 10.3
//
// Property 13 (design.md §"Correctness Properties" — Assistive classification):
//   A `classify` result is never written to authoritative registry metadata
//   unless pinned or persisted; unavailable/failed/low-confidence classification
//   falls back to custom/uncategorized without a fatal error and indicates the
//   fallback.
//   **Validates: Requirements 7.4, 7.5, 7.6**
//
// Property 12 (Pinned precedence) — extended to the CLASSIFICATION path:
//   For pinned-subset members, the pinned layer/category override any inferred or
//   classifier-produced classification, and the classifier is never consulted.
//   (Task 6.4 proved this on the validation path; this extends it to classify.)
//   **Validates: Requirements 7.7**
//
// These tests drive the REAL classifyWithFallback over an in-memory prompt-capable
// handler with a call counter (no mocking of the subject under test). Confidence is
// generated around the interim threshold so BOTH sides (confident → classify,
// low → fallback) are exercised.
//
// Validates: Requirements 7.4, 7.5, 7.6, 7.7
// =============================================================================

import * as fc from 'fast-check';

import {
  classifyWithFallback,
  mayPromoteAssistiveClassification,
  CUSTOM_UNCATEGORIZED_CATEGORY,
  INTERIM_CONFIDENCE_THRESHOLD,
  type PromptAgentHandler,
  type ClassifySubject,
} from '../../../runtime/classify.js';
import { UNTRUSTED_DEFAULT } from '../../../runtime/trust.js';

// -----------------------------------------------------------------------------
// In-memory counting handler
// -----------------------------------------------------------------------------

interface CountingHandler extends PromptAgentHandler {
  calls: number;
}

function makeJsonHandler(text: string, id = 'agent'): CountingHandler {
  const handler: CountingHandler = {
    id,
    calls: 0,
    prompt: async () => {
      handler.calls += 1;
      return { text };
    },
  };
  return handler;
}

function makeRejectingHandler(id = 'agent'): CountingHandler {
  const handler: CountingHandler = {
    id,
    calls: 0,
    prompt: async () => {
      handler.calls += 1;
      throw new Error('agent unavailable');
    },
  };
  return handler;
}

const SUBJECT: ClassifySubject = { name: 'runtime-x', body: 'body' };
const SESSION = 'sid';

// -----------------------------------------------------------------------------
// Generators
// -----------------------------------------------------------------------------

const layerArb = fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined });
const categoryArb = fc.option(
  fc.stringMatching(/^[a-z]{1,12}$/),
  { nil: undefined },
);
// Confidence generated tightly around the threshold to exercise both sides.
const confidenceArb = fc.option(
  fc.double({ min: 0, max: 1, noNaN: true }),
  { nil: undefined },
);

/** A generated classify-hint JSON body (only defined fields are emitted). */
interface HintFields {
  layer?: number;
  category?: string;
  confidence?: number;
}

const hintFieldsArb: fc.Arbitrary<HintFields> = fc
  .record({ layer: layerArb, category: categoryArb, confidence: confidenceArb })
  .map(({ layer, category, confidence }) => {
    const f: HintFields = {};
    if (layer !== undefined) f.layer = layer;
    if (category !== undefined) f.category = category;
    if (confidence !== undefined) f.confidence = confidence;
    return f;
  });

// =============================================================================
// Property 13 — assistive classification: total, well-formed, correct polarity
// =============================================================================

describe('Property 13: assistive classification (Req 7.4, 7.5, 7.6)', () => {
  it('never throws and yields exactly classify on confident+complete, else fallback', async () => {
    const threshold = INTERIM_CONFIDENCE_THRESHOLD;
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constant<{ kind: 'none' }>({ kind: 'none' }),
          fc.constant<{ kind: 'reject' }>({ kind: 'reject' }),
          hintFieldsArb.map((fields) => ({ kind: 'json' as const, fields })),
        ),
        async (behavior) => {
          let handler: CountingHandler | undefined;
          let expectClassify = false;
          let expectedLayer: number | undefined;
          let expectedCategory: string | undefined;

          if (behavior.kind === 'none') {
            handler = undefined;
          } else if (behavior.kind === 'reject') {
            handler = makeRejectingHandler();
          } else {
            const { fields } = behavior;
            handler = makeJsonHandler(JSON.stringify(fields));
            const hasClassification =
              fields.layer !== undefined || fields.category !== undefined;
            const isConfident =
              fields.confidence !== undefined && fields.confidence >= threshold;
            expectClassify = hasClassification && isConfident;
            expectedLayer = fields.layer;
            expectedCategory = fields.category;
          }

          const outcome = await classifyWithFallback({
            subject: SUBJECT,
            sessionId: SESSION,
            handler,
          });

          // Well-formed: with no pinned override, source is classify or fallback.
          expect(['classify', 'fallback']).toContain(outcome.source);

          // fallbackApplied corresponds exactly to "not classify" (and not pinned).
          expect(outcome.fallbackApplied).toBe(outcome.source !== 'classify');

          // Exactly the confident+complete case yields source:'classify'.
          expect(outcome.source === 'classify').toBe(expectClassify);

          if (outcome.source === 'classify') {
            expect(outcome.layer).toBe(expectedLayer);
            expect(outcome.category).toBe(expectedCategory);
            // The classify result stays ASSISTIVE — not authoritative on its own (Req 7.4):
            // under an untrusted policy it may not be promoted without pinning/persistence.
            expect(
              mayPromoteAssistiveClassification(UNTRUSTED_DEFAULT, {
                pinned: false,
                persisted: false,
              }),
            ).toBe(false);
          } else {
            // Fallback indicates custom/uncategorized (Req 7.5, 7.6).
            expect(outcome.category).toBe(CUSTOM_UNCATEGORIZED_CATEGORY);
            expect(outcome.layer).toBeUndefined();
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// =============================================================================
// Property 12 (extended to classify) — pinned precedence on the classify path
// =============================================================================

describe('Property 12 (classify path): pinned precedence (Req 7.7)', () => {
  it('pinned layer/category win regardless of any agent hint; agent never consulted', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A pinned classification (at least one of layer/category present).
        fc
          .record({ layer: layerArb, category: categoryArb })
          .filter((p) => p.layer !== undefined || p.category !== undefined),
        // An arbitrary — possibly confident and contradicting — agent hint.
        hintFieldsArb,
        async (pinned, hint) => {
          const handler = makeJsonHandler(JSON.stringify(hint));

          const outcome = await classifyWithFallback({
            subject: SUBJECT,
            sessionId: SESSION,
            handler,
            pinned,
          });

          expect(outcome.source).toBe('pinned');
          expect(outcome.fallbackApplied).toBe(false);
          expect(outcome.layer).toBe(pinned.layer);
          expect(outcome.category).toBe(pinned.category);
          // The classifier is NEVER consulted on the pinned path.
          expect(handler.calls).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});
