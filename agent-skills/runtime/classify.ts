/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Classification boundary — the prompt agent contract (Migration Step 8, design §8; Req 7).
 *
 * This module establishes the **boundary** between the typed capability contract
 * ({@link ../contract.js}, the `SkillsRuntime` critical path) and the prompt-shaped,
 * assistive `classify` operation. Per Milestone §5 invariant 6 and design §8:
 *
 *   - `read`, `search`, `list`, `getReferences`, `readReference`, and skill `fetch`/`add`
 *     stay on the **typed** capability contract with typed inputs/outputs and a provenance
 *     envelope; they are NEVER exposed through a `prompt(string)` shape (Req 7.1). This
 *     module deliberately does NOT touch `SkillsRuntime` or `InProcessSkillsRuntime`, and is
 *     NOT exported from the package entry point — `classify` stays OFF the typed critical
 *     path (Milestone §8: "assistive, not a critical-path hard dependency").
 *   - `classify` is the prompt-shaped, assistive exception, reached through the
 *     {@link AgentHandler} `prompt` contract (Req 7.2).
 *
 * ─── SCOPE OF THIS TASK (10.1) ─────────────────────────────────────────────────────
 *
 * This task establishes only the boundary TYPES, the registration-time VALIDATION, and the
 * ASSISTIVE-result contract:
 *
 *   - {@link AgentHandler} / {@link PromptAgentHandler} — the prompt agent contract,
 *   - {@link registerAgentHandler} — registration/config-time validation (Req 7.3),
 *   - {@link ClassifyResult} / {@link AssistiveClassification} — the assistive result type,
 *   - {@link classifyThroughAgent} — runs classification THROUGH `AgentHandler.prompt`,
 *   - {@link mayPromoteAssistiveClassification} — the Req 7.4 / 11.6 promotion guard.
 *
 * Fallback-safe wiring (custom/uncategorized on unavailable/failed/low-confidence) and the
 * pinned override are **Task 10.2** — intentionally NOT implemented here. {@link classifyThroughAgent}
 * therefore performs no fallback and may reject if the underlying agent's `prompt` rejects;
 * Task 10.2 wraps it fallback-safe (Req 7.5–7.7).
 *
 * ─── INTERIM TYPES — mirror @stdiobus/mcp-agentic ──────────────────────────────────
 *
 * {@link AgentHandler}, {@link AgentResult}, {@link AgentEvent}, {@link PromptOpts}, and
 * {@link StreamOpts} are defined LOCALLY as small, forward-compatible interim types that
 * MIRROR the verified `@stdiobus/mcp-agentic` `AgentHandler` contract. `@stdiobus/mcp-agentic`
 * is a devDependency (used for type-checking / verification), NOT a direct runtime dependency
 * of `@stdiobus/skills`; this module lives in the production-bundled `runtime/` tree, so it
 * must not import from a devDependency and must not add a new dependency. The verified package
 * additionally exposes session-lifecycle hooks (`onSessionCreate`/`onSessionClose`/`cancel`)
 * and richer `AgentResult` fields (`stopReason` required, `usage`, `requestId`); those are
 * omitted here as interim and can be widened later without breaking call sites.
 */

import type { TrustPolicy } from './trust.js';
import { mayPromoteClassification } from './trust.js';

// ---------------------------------------------------------------------------
// Prompt agent contract (interim — mirrors @stdiobus/mcp-agentic AgentHandler)
// ---------------------------------------------------------------------------

/**
 * Complete result returned by an agent after processing a prompt.
 *
 * Mirrors `@stdiobus/mcp-agentic` `AgentResult`. INTERIM: only `text` is required here and
 * `stopReason` is optional (the verified package marks `stopReason` required and adds
 * `usage`/`requestId`). The classify path only reads `text`.
 */
export interface AgentResult {
  /** The agent's textual response. */
  text: string;
  /** Why the agent stopped, e.g. `'end_turn'`. Optional in this interim mirror. */
  stopReason?: string;
}

/** A single text chunk emitted during streaming (mirrors `@stdiobus/mcp-agentic`). */
export interface AgentChunk {
  type: 'chunk';
  text: string;
  index: number;
}

/** Terminal event carrying the final result of a streaming agent. */
export interface AgentFinal {
  type: 'final';
  result: AgentResult;
}

/** Error event emitted during streaming. */
export interface AgentError {
  type: 'error';
  message: string;
  retryable: boolean;
}

/** Union of all events a streaming agent can yield. */
export type AgentEvent = AgentChunk | AgentFinal | AgentError;

/** Options for {@link PromptCapable.prompt} (interim subset of the verified `PromptOpts`). */
export interface PromptOpts {
  /** Request timeout in milliseconds. Interpretation is executor-specific. */
  timeout?: number;
  /** Optional AbortSignal for cooperative cancellation. */
  signal?: AbortSignal;
}

/** Options for {@link StreamCapable.stream} (interim subset of the verified `StreamOpts`). */
export interface StreamOpts {
  /** AbortSignal for cooperative cancellation of the stream. */
  signal?: AbortSignal;
}

/** Common agent identity fields shared by every {@link AgentHandler}. */
export interface AgentIdentity {
  /** Unique agent identifier (required). */
  readonly id: string;
  /** Optional list of capability tags this agent supports. */
  readonly capabilities?: readonly string[];
}

/** An agent that implements `prompt` (and may also implement `stream`). */
export interface PromptCapable {
  /**
   * Synchronous prompt handler. Returns a complete {@link AgentResult}.
   *
   * @param sessionId - session identifier.
   * @param input - prompt text.
   * @param opts - timeout / cancellation options.
   */
  prompt(sessionId: string, input: string, opts?: PromptOpts): Promise<AgentResult>;
  stream?(sessionId: string, input: string, opts?: StreamOpts): AsyncIterable<AgentEvent>;
}

/** An agent that implements `stream` (and may also implement `prompt`). */
export interface StreamCapable {
  prompt?(sessionId: string, input: string, opts?: PromptOpts): Promise<AgentResult>;
  /**
   * Streaming handler. Yields chunks and a final result.
   *
   * @param sessionId - session identifier.
   * @param input - prompt text.
   * @param opts - cancellation options.
   */
  stream(sessionId: string, input: string, opts?: StreamOpts): AsyncIterable<AgentEvent>;
}

/**
 * Prompt agent contract — mirrors the verified `@stdiobus/mcp-agentic` `AgentHandler`.
 *
 * Requires an `id` plus **at least one** of `prompt` / `stream` (Req 7.3). The constraint is
 * expressed at the TYPE level via a union: neither member makes both optional, so a handler
 * object with `id` alone is not assignable to {@link AgentHandler}. A handler does NOT require
 * an LLM executor — a deterministic implementation is valid (Req 7.3).
 *
 * Runtime/config-time enforcement (for handlers built from untyped config) lives in
 * {@link registerAgentHandler}.
 */
export type AgentHandler =
  | (AgentIdentity & PromptCapable)
  | (AgentIdentity & StreamCapable);

/** A {@link AgentHandler} that is guaranteed to implement `prompt`. */
export type PromptAgentHandler = AgentIdentity & PromptCapable;

// ---------------------------------------------------------------------------
// Registration-time validation (Req 7.3) — NOT a SkillsRuntime returned error
// ---------------------------------------------------------------------------

/**
 * Registration/config-time error for an invalid agent handler.
 *
 * DESIGN CHOICE (documented per Task 10.1): "a handler providing neither `prompt` nor
 * `stream` fails at the registration/config boundary" (design §8). This is intentionally a
 * **returned validation result** (not a thrown exception), satisfying Req 7.3's "registration
 * SHALL fail with a returned error". It is a distinct type — NOT a `SkillRuntimeError`, and it
 * is never thrown across the `SkillsRuntime` data boundary — because validating an agent
 * handler is a config-time concern, separate from the runtime's per-operation data boundary.
 */
export interface AgentRegistrationError {
  readonly code: 'invalid_agent_handler';
  /** Human-readable reasons the handler was rejected. */
  readonly issues: string[];
}

/** Result of {@link registerAgentHandler}: a validated handler, or a typed registration error. */
export type AgentRegistrationResult =
  | { ok: true; handler: AgentHandler }
  | { ok: false; error: AgentRegistrationError };

/**
 * Validate an agent handler at the registration/config boundary (Req 7.3).
 *
 * Accepts a loosely-typed candidate (handlers may be assembled from untyped config) and
 * enforces the two invariants the {@link AgentHandler} type encodes:
 *
 *   1. a non-empty string `id`, and
 *   2. at least one of `prompt` / `stream` as a function.
 *
 * A handler providing neither `prompt` nor `stream` (or lacking a valid `id`) fails here with
 * a returned {@link AgentRegistrationError} — registration-time validation, NOT a
 * `SkillsRuntime` returned error and never thrown across the runtime boundary.
 *
 * @param candidate - the handler to validate; fields are read defensively.
 * @returns `{ ok: true, handler }` when valid, else `{ ok: false, error }`.
 */
export function registerAgentHandler(
  candidate: { id?: unknown; prompt?: unknown; stream?: unknown },
): AgentRegistrationResult {
  const issues: string[] = [];

  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    issues.push('agent handler requires a non-empty string `id`');
  }

  const hasPrompt = typeof candidate.prompt === 'function';
  const hasStream = typeof candidate.stream === 'function';
  if (!hasPrompt && !hasStream) {
    issues.push('agent handler requires at least one of `prompt` or `stream`');
  }

  if (issues.length > 0) {
    return { ok: false, error: { code: 'invalid_agent_handler', issues } };
  }

  return { ok: true, handler: candidate as unknown as AgentHandler };
}

// ---------------------------------------------------------------------------
// Assistive classification result (Req 7.4)
// ---------------------------------------------------------------------------

/** The subject a classification is computed for. Minimal interim shape. */
export interface ClassifySubject {
  /** Skill name being classified. */
  readonly name: string;
  /** Optional skill body, supplied to the agent as context. */
  readonly body?: string;
}

/**
 * The assistive classification hint produced by `classify`.
 *
 * INTERIM shape (design §8). The confidence mechanism and any threshold are open policy
 * (Req 7.6, Milestone §10); `confidence` is carried opaquely and interpreted by Task 10.2.
 */
export interface ClassifyResult {
  /** Inferred layer, when the agent provides one. */
  layer?: number;
  /** Inferred category, when the agent provides one. */
  category?: string;
  /** Optional confidence signal; mechanism/threshold is open policy (Req 7.6). */
  confidence?: number;
}

/**
 * An assistive classification — the result of running `classify` through an agent.
 *
 * The `assistive: true` flag is the contract marker (Req 7.4): a classify result is assistive
 * and is NEVER written to authoritative registry metadata unless promotion is permitted by
 * {@link mayPromoteAssistiveClassification} (pinned/persisted, or a trusted provider).
 */
export interface AssistiveClassification {
  /** Always `true` — this result is assistive, never authoritative on its own (Req 7.4). */
  readonly assistive: true;
  /** Id of the agent that produced the hint. */
  readonly agentId: string;
  /** The parsed classification hint (may be empty when the agent text is unparseable). */
  readonly result: ClassifyResult;
  /** Raw agent text, retained for diagnostics. */
  readonly raw: string;
}

/**
 * Build the prompt input that asks an agent to classify a skill.
 *
 * INTERIM deterministic template; the exact wording is policy. Asks for a small JSON object
 * so {@link parseClassifyResult} can extract `layer`/`category`/`confidence`.
 *
 * @param subject - the skill to classify.
 * @returns the prompt string passed to {@link PromptAgentHandler.prompt}.
 */
export function classifyPromptInput(subject: ClassifySubject): string {
  const context = subject.body !== undefined ? `\n\nContent:\n${subject.body}` : '';
  return (
    `Classify the agent skill "${subject.name}".` +
    ` Respond ONLY with a JSON object of the form ` +
    `{"layer": <number>, "category": <string>, "confidence": <0..1>}.` +
    context
  );
}

/**
 * Parse an agent's textual response into a {@link ClassifyResult}.
 *
 * INTERIM, defensive parser: attempts to read a JSON object and extracts only well-typed
 * `layer` (finite number), `category` (non-empty string), and `confidence` (finite number)
 * fields. Any malformed or unparseable text yields an empty {@link ClassifyResult} — it never
 * throws, so callers can treat an empty result as "no hint".
 *
 * @param text - the agent's `AgentResult.text`.
 * @returns the extracted classification hint (possibly empty).
 */
export function parseClassifyResult(text: string): ClassifyResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object') {
    return {};
  }

  const obj = parsed as Record<string, unknown>;
  const out: ClassifyResult = {};
  if (typeof obj.layer === 'number' && Number.isFinite(obj.layer)) {
    out.layer = obj.layer;
  }
  if (typeof obj.category === 'string' && obj.category.length > 0) {
    out.category = obj.category;
  }
  if (typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)) {
    out.confidence = obj.confidence;
  }
  return out;
}

/**
 * Run classification THROUGH a prompt-capable agent handler (Req 7.2).
 *
 * Maps the {@link ClassifySubject} to a prompt input via {@link classifyPromptInput}, invokes
 * {@link PromptAgentHandler.prompt}, and parses `AgentResult.text` into a {@link ClassifyResult}.
 * The returned {@link AssistiveClassification} is explicitly marked `assistive: true` — it is a
 * hint, not authoritative metadata (Req 7.4).
 *
 * NOTE (Task 10.1 scope): this helper performs NO fallback and may reject if the agent's
 * `prompt` rejects. Fallback-safe wiring (custom/uncategorized on unavailable/failed/
 * low-confidence) and the pinned override are Task 10.2 (Req 7.5–7.7). This helper is OFF the
 * typed `SkillsRuntime` critical path by construction.
 *
 * @param handler - a prompt-capable agent handler.
 * @param subject - the skill to classify.
 * @param sessionId - session identifier passed to the agent.
 * @param opts - optional prompt timeout / cancellation options.
 * @returns an assistive classification carrying the parsed hint and raw agent text.
 */
export async function classifyThroughAgent(
  handler: PromptAgentHandler,
  subject: ClassifySubject,
  sessionId: string,
  opts?: PromptOpts,
): Promise<AssistiveClassification> {
  const input = classifyPromptInput(subject);
  const res = await handler.prompt(sessionId, input, opts);
  return {
    assistive: true,
    agentId: handler.id,
    result: parseClassifyResult(res.text),
    raw: res.text,
  };
}

// ---------------------------------------------------------------------------
// Assistive → authoritative promotion guard (Req 7.4 / 11.6)
// ---------------------------------------------------------------------------

/**
 * Guard expressing that an assistive classify result is NOT written to authoritative registry
 * metadata unless it is pinned or persisted (Req 7.4) — or the classifying provider is trusted.
 *
 * This delegates to the shared trust guard {@link mayPromoteClassification} in `trust.ts`
 * (Req 11.6), making the linkage explicit: classification promotion and untrusted-provider
 * promotion are governed by the SAME rule. An untrusted provider's classification (including an
 * assistive `classify` hint) becomes authoritative ONLY through explicit pinning/persistence;
 * embedded skill content never grants that authority on its own (untrusted-as-data, Req 11.7).
 *
 * @param policy - the (effective) trust policy of the classifying provider.
 * @param opts.pinned - whether the skill is an explicit pinned-subset member.
 * @param opts.persisted - whether the classification has been explicitly persisted.
 * @returns `true` when the assistive classification may become authoritative, else `false`.
 */
export function mayPromoteAssistiveClassification(
  policy: TrustPolicy,
  opts: { pinned: boolean; persisted: boolean },
): boolean {
  return mayPromoteClassification(policy, opts);
}

// ---------------------------------------------------------------------------
// Assistive-only security invariant — the SINGLE narrow promotion surface
// (Task 32 / T32; Req 7.4, 11.6)
// ---------------------------------------------------------------------------

/**
 * The MAXIMAL influence an assistive classification may ever have on authoritative
 * registry state: a suggested `layer` and/or `category`, and NOTHING ELSE.
 *
 * SECURITY INVARIANT (Req 7.4, 11.6). A `classify` / {@link AssistiveClassification} result
 * may ONLY ever suggest a skill's `layer`/`category`. It must NEVER be an input to — and this
 * type deliberately cannot express — any of:
 *
 *   - trust tier selection (see {@link mayPromoteClassification}, `resolveTrustPolicy`),
 *   - namespace / ownership decisions,
 *   - authority / allow-list membership,
 *   - sandbox / isolation level (see `checkIsolation` in `./security/boundary.js`),
 *   - provider tier,
 *   - any admission decision (`fetch` / `import` / `read`; see `checkWithinRoot` /
 *     `checkContentSize` / `checkIsolation`).
 *
 * Those security-boundary predicates key EXCLUSIVELY on {@link TrustPolicy} (and structural
 * path/size facts); none of them accepts an {@link AssistiveClassification}, a
 * {@link ClassifyResult}, or this type as a parameter — so a classify hint structurally
 * cannot flow into them, at ANY confidence value.
 */
export interface AuthoritativeClassification {
  /** Promoted layer, when the assistive hint carried one. */
  readonly layer?: number;
  /** Promoted category, when the assistive hint carried one. */
  readonly category?: string;
}

/**
 * The ONE narrow surface through which an assistive `classify` hint may become authoritative
 * registry metadata (Task 32; Req 7.4, 11.6).
 *
 * This is the single, typed, documented boundary that converts an {@link AssistiveClassification}
 * into authoritative metadata, and it does so under a HARD gate:
 *
 *   - The promotion decision is delegated VERBATIM to {@link mayPromoteAssistiveClassification}
 *     (which reuses {@link mayPromoteClassification} in `trust.ts`) — the promotion rule is NOT
 *     duplicated here. An assistive classification becomes authoritative ONLY via explicit
 *     pin/persist (`opts.pinned || opts.persisted`) OR a trusted-authority provider
 *     (`policy.tier === 'trusted'`). For an untrusted provider WITHOUT pin/persist, promotion is
 *     refused regardless of {@link ClassifyResult.confidence} — confidence is not even consulted
 *     (the gate has no confidence parameter), so a maximal `confidence: 1.0` cannot promote.
 *   - When refused, the function returns `undefined`: the classification STAYS assistive and no
 *     authoritative metadata is produced.
 *   - When permitted, the ONLY fields that cross are `layer`/`category` (an
 *     {@link AuthoritativeClassification}). The trust tier, namespace, authority, allow-list,
 *     sandbox/isolation level, provider tier, and every admission decision are untouched by this
 *     function — it neither reads nor returns any of them.
 *
 * This makes the assistive-only invariant CHECKABLE in code: the security-boundary functions
 * (`resolveTrustPolicy`, `checkIsolation`, `checkWithinRoot`, `checkContentSize`) take no classify
 * input, and the sole classify→authoritative conversion is this gated, layer/category-only surface.
 *
 * @param classification - the assistive classification produced by `classify`.
 * @param policy - the (effective) {@link TrustPolicy} of the classifying provider.
 * @param opts.pinned - whether the skill is an explicit pinned-subset member.
 * @param opts.persisted - whether the classification has been explicitly persisted.
 * @returns the promoted `layer`/`category` when promotion is permitted, else `undefined`
 *   (the classification remains assistive and is NOT written to authoritative metadata).
 */
export function promoteAssistiveClassification(
  classification: AssistiveClassification,
  policy: TrustPolicy,
  opts: { pinned: boolean; persisted: boolean },
): AuthoritativeClassification | undefined {
  // HARD GATE — reuse the shared promotion rule; do not duplicate it. Confidence is never an
  // input to the gate, so no confidence value can override an untrusted, unpinned refusal.
  if (!mayPromoteAssistiveClassification(policy, opts)) {
    return undefined;
  }

  // Narrow surface: ONLY layer/category may ever cross into authoritative metadata.
  const out: { layer?: number; category?: string } = {};
  if (classification.result.layer !== undefined) {
    out.layer = classification.result.layer;
  }
  if (classification.result.category !== undefined) {
    out.category = classification.result.category;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fallback-safe classification with pinned override (Task 10.2; Req 7.5–7.7)
// ---------------------------------------------------------------------------

/**
 * Where a {@link ClassificationOutcome}'s resolved layer/category came from.
 *
 *   - `'pinned'`   — the subject is a pinned-subset member; pinned layer/category was used
 *                    and classification inference was skipped entirely (Req 7.7).
 *   - `'classify'` — an assistive `classify` hint with sufficient confidence and a layer
 *                    and/or category was used (Req 7.4). The hint is carried on
 *                    {@link ClassificationOutcome.assistive} and stays assistive — promotion
 *                    to authoritative metadata is still gated by
 *                    {@link mayPromoteAssistiveClassification}.
 *   - `'fallback'` — the custom/uncategorized fallback was applied because `classify` was
 *                    unavailable, failed, or returned a low-confidence / uncertain result
 *                    (Req 7.5, 7.6).
 */
export type ClassificationSource = 'pinned' | 'classify' | 'fallback';

/**
 * The custom/uncategorized fallback category (Req 7.5, 7.6).
 *
 * INTERIM shape: the fallback carries `category: 'uncategorized'` and an **undefined** layer
 * — "custom" here means "no determinable layer". This deliberately matches the validation
 * path's custom/uncategorized fallback (Task 6.2, `validateLayerAssignment`) so the
 * classification and validation paths agree on what "uncategorized" means.
 */
export const CUSTOM_UNCATEGORIZED_CATEGORY = 'uncategorized';

/**
 * Interim confidence threshold below which a `classify` hint is treated as low-confidence and
 * falls back to custom/uncategorized (Req 7.6).
 *
 * OPEN / POLICY (Req 7.6, Milestone §10): the confidence *mechanism* and any *threshold* are
 * deliberately not frozen. This `0.5` is a documented interim default, overridable per call via
 * {@link ClassifyWithFallbackOptions.confidenceThreshold}. It is NOT an architectural invariant
 * and is expected to be replaced by a deployment/profile policy.
 */
export const INTERIM_CONFIDENCE_THRESHOLD = 0.5;

/**
 * The resolved classification for a skill, produced by {@link classifyWithFallback}.
 *
 * Captures the resolved `layer`/`category`, whether the custom/uncategorized fallback was
 * applied, the {@link ClassificationSource}, and — when an agent was actually consulted — the
 * assistive hint for diagnostics. This type is intentionally NOT a `SkillResponse`: classify is
 * off the typed `SkillsRuntime` critical path (design §8), so it has its own non-throwing,
 * fallback-safe outcome shape.
 */
export interface ClassificationOutcome {
  /** Resolved layer; `undefined` for the custom/uncategorized fallback. */
  readonly layer?: number;
  /** Resolved category; `'uncategorized'` for the fallback. */
  readonly category?: string;
  /** `true` when the custom/uncategorized fallback was applied (Req 7.5, 7.6). */
  readonly fallbackApplied: boolean;
  /** Where the resolved classification came from. */
  readonly source: ClassificationSource;
  /**
   * The assistive `classify` hint, present whenever an agent was actually consulted — both when
   * its result was used (`source: 'classify'`) and when it was rejected as low-confidence
   * (`source: 'fallback'`, retained for diagnostics). Absent when no agent ran (pinned override
   * or no handler available). Presence alone NEVER implies authority: {@link fallbackApplied}
   * and {@link mayPromoteAssistiveClassification} govern that (Req 7.4).
   */
  readonly assistive?: AssistiveClassification;
}

/** Pinned layer/category for a subject, derived from pinned descriptors (Req 7.7). */
export interface PinnedClassification {
  /** Pinned layer, when the pinned descriptor carries one. */
  readonly layer?: number;
  /** Pinned category, when the pinned descriptor carries one. */
  readonly category?: string;
}

/** Options for {@link classifyWithFallback}. */
export interface ClassifyWithFallbackOptions {
  /** The skill to classify. */
  readonly subject: ClassifySubject;
  /** Session identifier passed to the agent when `classify` runs. */
  readonly sessionId: string;
  /**
   * Pinned classification for this subject, IF it is a pinned-subset member. When provided, the
   * pinned layer/category is used and `classify` is NOT called — pinning overrides inference
   * (Req 7.7). A pinned lookup (`name → { layer; category }`) is typically derived from
   * `pinnedDescriptors(manifest)` by the caller.
   */
  readonly pinned?: PinnedClassification;
  /**
   * The prompt-capable agent handler. `undefined` means no classification agent is available →
   * the function falls back to custom/uncategorized, non-fatally (Req 7.5).
   */
  readonly handler?: PromptAgentHandler;
  /**
   * Interim confidence threshold (Req 7.6, open policy). Defaults to
   * {@link INTERIM_CONFIDENCE_THRESHOLD}. A hint with confidence below this — or with no
   * confidence at all — is treated as low-confidence and falls back.
   */
  readonly confidenceThreshold?: number;
  /** Optional prompt timeout / cancellation options forwarded to the agent. */
  readonly promptOpts?: PromptOpts;
}

/** Build the custom/uncategorized fallback outcome (Req 7.5, 7.6). */
function customUncategorizedOutcome(
  assistive?: AssistiveClassification,
): ClassificationOutcome {
  return {
    layer: undefined,
    category: CUSTOM_UNCATEGORIZED_CATEGORY,
    fallbackApplied: true,
    source: 'fallback',
    ...(assistive !== undefined ? { assistive } : {}),
  };
}

/**
 * Fallback-safe classification with pinned override (Task 10.2; Req 7.5, 7.6, 7.7).
 *
 * Resolution order:
 *
 *   1. **Pinned override (Req 7.7).** If {@link ClassifyWithFallbackOptions.pinned} is provided,
 *      the subject is a pinned-subset member: its pinned layer/category is used and `classify`
 *      is NOT called. Pinning overrides any inferred classification. `source: 'pinned'`,
 *      `fallbackApplied: false`.
 *
 *   2. **No agent available (Req 7.5).** If no `handler` is provided, the function assigns the
 *      custom/uncategorized fallback, non-fatally. `source: 'fallback'`, `fallbackApplied: true`.
 *
 *   3. **Agent failure (Req 7.5).** If {@link classifyThroughAgent} rejects (the agent's `prompt`
 *      throws/rejects), the rejection is caught and the custom/uncategorized fallback is applied,
 *      non-fatally. The function NEVER throws for this case.
 *
 *   4. **Low-confidence / uncertain (Req 7.6).** A hint is "sufficient" only when it carries a
 *      confidence at or above the (interim, open-policy) threshold AND at least one of `layer` or
 *      `category`. Absent confidence, confidence below threshold, or neither layer nor category
 *      → custom/uncategorized fallback (the assistive hint is retained for diagnostics).
 *
 *   5. **Sufficient hint (Req 7.4).** Otherwise the assistive layer/category is used.
 *      `source: 'classify'`, `fallbackApplied: false`. The result stays ASSISTIVE — it is NOT
 *      authoritative unless pinned/persisted (see {@link mayPromoteAssistiveClassification});
 *      actually writing authoritative metadata is out of scope here, so the outcome only carries
 *      the assistive marker.
 *
 * This function is fallback-safe and total for the unavailable / failed / low-confidence cases:
 * it NEVER throws across these paths (Req 7.5). It is a standalone helper that stays OFF the
 * typed `SkillsRuntime` critical path (design §8) — it is intentionally not a method on
 * `SkillsRuntime`.
 *
 * @param opts - subject, session, optional pinned override, optional handler, and policy knobs.
 * @returns the resolved {@link ClassificationOutcome}; never rejects for the fallback cases.
 */
export async function classifyWithFallback(
  opts: ClassifyWithFallbackOptions,
): Promise<ClassificationOutcome> {
  // 1. PINNED OVERRIDE (Req 7.7): pinning overrides inference; do not call classify.
  if (opts.pinned !== undefined) {
    return {
      layer: opts.pinned.layer,
      category: opts.pinned.category,
      fallbackApplied: false,
      source: 'pinned',
    };
  }

  // 2. No agent available → non-fatal custom/uncategorized fallback (Req 7.5).
  if (opts.handler === undefined) {
    return customUncategorizedOutcome();
  }

  const threshold = opts.confidenceThreshold ?? INTERIM_CONFIDENCE_THRESHOLD;

  // 3. Attempt classify THROUGH the agent — fallback-safe (Req 7.5): a rejection becomes a
  //    non-fatal fallback rather than propagating across this boundary.
  let assistive: AssistiveClassification;
  try {
    assistive = await classifyThroughAgent(
      opts.handler,
      opts.subject,
      opts.sessionId,
      opts.promptOpts,
    );
  } catch {
    return customUncategorizedOutcome();
  }

  // 4. Low-confidence / uncertain → custom/uncategorized fallback (Req 7.6). Absent confidence
  //    or absent layer AND category are both treated as uncertain. The assistive hint is carried
  //    for diagnostics so callers can see WHY the fallback was applied.
  const { layer, category, confidence } = assistive.result;
  const hasClassification = layer !== undefined || category !== undefined;
  const isConfident = confidence !== undefined && confidence >= threshold;
  if (!hasClassification || !isConfident) {
    return customUncategorizedOutcome(assistive);
  }

  // 5. Sufficient assistive hint → use it (Req 7.4). Stays assistive, not authoritative.
  return {
    layer,
    category,
    fallbackApplied: false,
    source: 'classify',
    assistive,
  };
}
