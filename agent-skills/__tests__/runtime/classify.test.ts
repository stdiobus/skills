/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Unit tests — Classification (assistive, fallback-safe) — Task 10.3
//
// Subjects under test (agent-skills/runtime/classify.ts, Task 10.1/10.2):
//   - registerAgentHandler            — registration/config-time validation (Req 7.3)
//   - classifyWithFallback            — fallback-safe classification + pinned override
//                                       (Req 7.5, 7.6, 7.7)
//   - mayPromoteAssistiveClassification — assistive→authoritative guard (Req 7.4)
//
// These tests drive the REAL classify module against an in-memory prompt-capable
// AgentHandler (no mocking of the subject under test). The handler carries a call
// counter so the "pinned path never consults the agent" claim is proven by count,
// not by inference.
//
// Validates: Requirements 7.3, 7.4, 7.5, 7.6, 7.7
// =============================================================================

import {
  registerAgentHandler,
  classifyWithFallback,
  mayPromoteAssistiveClassification,
  CUSTOM_UNCATEGORIZED_CATEGORY,
  INTERIM_CONFIDENCE_THRESHOLD,
  type PromptAgentHandler,
  type ClassifySubject,
} from '../../runtime/classify.js';
import {
  bundledTrustPolicy,
  UNTRUSTED_DEFAULT,
} from '../../runtime/trust.js';

// -----------------------------------------------------------------------------
// In-memory prompt-capable handler with a call counter.
// -----------------------------------------------------------------------------

interface CountingHandler extends PromptAgentHandler {
  /** Number of times `prompt` was invoked. */
  calls: number;
}

/**
 * Build a prompt-capable handler whose `prompt` returns the supplied text (or rejects).
 * `calls` increments on every invocation so callers can assert no-call on the pinned path.
 */
function makeHandler(
  behavior:
    | { kind: 'text'; text: string }
    | { kind: 'reject'; message: string },
  id = 'agent-1',
): CountingHandler {
  const handler: CountingHandler = {
    id,
    calls: 0,
    prompt: async () => {
      handler.calls += 1;
      if (behavior.kind === 'reject') {
        throw new Error(behavior.message);
      }
      return { text: behavior.text };
    },
  };
  return handler;
}

/** A confident, complete classification response body. */
function confidentJson(layer: number, category: string, confidence: number): string {
  return JSON.stringify({ layer, category, confidence });
}

const SUBJECT: ClassifySubject = { name: 'runtime-some-skill', body: '# body' };
const SESSION = 'session-1';

// =============================================================================
// Registration-time validation (Req 7.3)
// =============================================================================

describe('registerAgentHandler — registration boundary (Req 7.3)', () => {
  it('rejects a handler with neither prompt nor stream', () => {
    const result = registerAgentHandler({ id: 'a' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error.code).toBe('invalid_agent_handler');
    expect(result.error.issues.length).toBeGreaterThan(0);
  });

  it('accepts a handler with id + prompt', () => {
    const result = registerAgentHandler({ id: 'a', prompt: async () => ({ text: '' }) });
    expect(result.ok).toBe(true);
  });

  it('accepts a handler with id + stream', () => {
    // eslint-disable-next-line require-yield
    async function* stream() {
      return;
    }
    const result = registerAgentHandler({ id: 'a', stream });
    expect(result.ok).toBe(true);
  });

  it('rejects a handler with a missing id', () => {
    const result = registerAgentHandler({ prompt: async () => ({ text: '' }) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error.code).toBe('invalid_agent_handler');
  });

  it('rejects a handler with an empty-string id even when prompt is present', () => {
    const result = registerAgentHandler({ id: '', prompt: async () => ({ text: '' }) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error.code).toBe('invalid_agent_handler');
  });
});

// =============================================================================
// Fallback-safe classification (Req 7.5, 7.6)
// =============================================================================

describe('classifyWithFallback — fallback-safe (Req 7.5, 7.6)', () => {
  it('no handler → custom/uncategorized fallback, non-fatal', async () => {
    const outcome = await classifyWithFallback({ subject: SUBJECT, sessionId: SESSION });
    expect(outcome.source).toBe('fallback');
    expect(outcome.fallbackApplied).toBe(true);
    expect(outcome.category).toBe(CUSTOM_UNCATEGORIZED_CATEGORY);
    expect(outcome.layer).toBeUndefined();
  });

  it('handler whose prompt rejects → fallback, never throws (Req 7.5)', async () => {
    const handler = makeHandler({ kind: 'reject', message: 'boom' });
    const outcome = await classifyWithFallback({ subject: SUBJECT, sessionId: SESSION, handler });
    expect(outcome.source).toBe('fallback');
    expect(outcome.fallbackApplied).toBe(true);
    expect(outcome.category).toBe(CUSTOM_UNCATEGORIZED_CATEGORY);
    expect(handler.calls).toBe(1);
  });

  it('low-confidence hint (below threshold) → fallback (Req 7.6)', async () => {
    const low = INTERIM_CONFIDENCE_THRESHOLD - 0.1;
    const handler = makeHandler({ kind: 'text', text: confidentJson(2, 'api', low) });
    const outcome = await classifyWithFallback({ subject: SUBJECT, sessionId: SESSION, handler });
    expect(outcome.source).toBe('fallback');
    expect(outcome.fallbackApplied).toBe(true);
    expect(outcome.category).toBe(CUSTOM_UNCATEGORIZED_CATEGORY);
    // The assistive hint is retained for diagnostics even though it was rejected.
    expect(outcome.assistive?.result.confidence).toBeCloseTo(low);
  });

  it('confident hint with no layer/category → fallback (Req 7.6)', async () => {
    const handler = makeHandler({ kind: 'text', text: JSON.stringify({ confidence: 0.99 }) });
    const outcome = await classifyWithFallback({ subject: SUBJECT, sessionId: SESSION, handler });
    expect(outcome.source).toBe('fallback');
    expect(outcome.fallbackApplied).toBe(true);
  });

  it('confident, complete hint → source:classify, carries assistive (Req 7.4)', async () => {
    const handler = makeHandler({ kind: 'text', text: confidentJson(3, 'patterns', 0.9) });
    const outcome = await classifyWithFallback({ subject: SUBJECT, sessionId: SESSION, handler });
    expect(outcome.source).toBe('classify');
    expect(outcome.fallbackApplied).toBe(false);
    expect(outcome.layer).toBe(3);
    expect(outcome.category).toBe('patterns');
    expect(outcome.assistive?.assistive).toBe(true);
    expect(outcome.assistive?.agentId).toBe('agent-1');
  });
});

// =============================================================================
// Pinned override (Req 7.7) — agent is NEVER consulted on the pinned path
// =============================================================================

describe('classifyWithFallback — pinned override (Req 7.7)', () => {
  it('uses the pinned layer/category and never calls the agent', async () => {
    // A confident, contradicting handler — it must be ignored entirely.
    const handler = makeHandler({ kind: 'text', text: confidentJson(5, 'diagnostics', 0.99) });
    const outcome = await classifyWithFallback({
      subject: SUBJECT,
      sessionId: SESSION,
      handler,
      pinned: { layer: 1, category: 'concepts' },
    });
    expect(outcome.source).toBe('pinned');
    expect(outcome.fallbackApplied).toBe(false);
    expect(outcome.layer).toBe(1);
    expect(outcome.category).toBe('concepts');
    // The agent was never consulted on the pinned path.
    expect(handler.calls).toBe(0);
  });
});

// =============================================================================
// Assistive is not authoritative without pinning/persistence (Req 7.4)
// =============================================================================

describe('mayPromoteAssistiveClassification — promotion guard (Req 7.4)', () => {
  it('untrusted policy: not promotable without pinning/persistence', () => {
    expect(
      mayPromoteAssistiveClassification(UNTRUSTED_DEFAULT, { pinned: false, persisted: false }),
    ).toBe(false);
  });

  it('untrusted policy: promotable when pinned', () => {
    expect(
      mayPromoteAssistiveClassification(UNTRUSTED_DEFAULT, { pinned: true, persisted: false }),
    ).toBe(true);
  });

  it('untrusted policy: promotable when persisted', () => {
    expect(
      mayPromoteAssistiveClassification(UNTRUSTED_DEFAULT, { pinned: false, persisted: true }),
    ).toBe(true);
  });

  it('trusted policy: promotable on its own', () => {
    expect(
      mayPromoteAssistiveClassification(bundledTrustPolicy(), { pinned: false, persisted: false }),
    ).toBe(true);
  });
});
