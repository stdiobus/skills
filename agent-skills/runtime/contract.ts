/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SkillsRuntime contract — the generative foundation for the federated skills runtime.
 *
 * Design intent (R&D Milestone 001):
 * - This is NOT a fixed set of methods. It is a stable typed CORE plus an open
 *   extension seam (`request` + capability descriptors) so new capabilities can be
 *   added over time WITHOUT breaking the contract.
 * - Identity is open-world: a skill is addressed by a {@link SkillRef}, never by a
 *   closed compile-time enum.
 * - Every public result carries provenance (the runtime finalizes it; providers only
 *   contribute a seed).
 * - The error model lives in the contract as data ({@link SkillResponse}), not as thrown
 *   exceptions — so the same contract survives a serialized transport boundary (stdio Bus).
 *
 * Invariant being proven by the spike: the runtime knows only providers, refs,
 * capabilities, responses, and provenance — never the `SkillName` enum, never a
 * filesystem package root.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Registry-level identity unit. NOT a filesystem path. */
export interface SkillDescriptor {
  /** Fully-qualified id. Format is intentionally open (Milestone 001 §10). */
  fqid: string;
  /** Short, human-facing name (kebab-case). May collide across providers. */
  name: string;
  /** Id of the provider that owns this descriptor. */
  provider: string;
  /** Opaque provider source reference (path, git ref, registry url, ...). Not necessarily a path. */
  source: string;
  layer?: number;
  category?: string;
  pinned?: boolean;
}

/**
 * How a caller addresses a skill. Open-world: a `name` is valid input even if it is
 * unknown — resolution returns zero candidates rather than failing a closed-world check.
 */
export type SkillRef =
  | { kind: 'fqid'; fqid: string }
  | { kind: 'name'; name: string; provider?: string }
  | { kind: 'descriptor'; descriptor: SkillDescriptor };

// ---------------------------------------------------------------------------
// Provenance (runtime-finalized result envelope metadata)
// ---------------------------------------------------------------------------

/**
 * Provenance attached to every successful public result. The runtime builds this; a
 * provider may only contribute a {@link ProvenanceSeed}. The exact field set beyond the
 * minimum is open (Milestone 001 §10) — hence the index signature.
 */
export interface Provenance {
  fqid: string;
  provider: string;
  source: string;
  /** What the caller asked for (e.g. a `name`) vs what resolved (the `fqid`). */
  resolvedFrom?: SkillRef;
  [key: string]: unknown;
}

/** Provider's contribution to provenance. The runtime owns the rest. */
export interface ProvenanceSeed {
  source: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Error model (public boundary — returned, never thrown)
// ---------------------------------------------------------------------------

export type SkillRuntimeError =
  | { code: 'not_found'; ref: SkillRef }
  | { code: 'ambiguous'; ref: SkillRef; candidates: SkillDescriptor[] }
  | { code: 'unsupported'; capability: string; provider?: string }
  | { code: 'provider_error'; provider: string; message: string }
  | { code: 'bad_request'; issues: string[] }
  | { code: 'out_of_bounds'; provider: string; detail: string }
  | { code: 'content_too_large'; provider: string; limitBytes: number }
  | { code: 'isolation_failed'; provider: string; reason: string }
  | { code: 'aggregate_error'; failures: Array<{ provider: string; error: SkillRuntimeError }> };

/** Discriminated response. Survives a serialized transport boundary unchanged. */
export type SkillResponse<T> =
  | { ok: true; data: T; provenance: Provenance }
  | { ok: false; error: SkillRuntimeError; provenance?: Provenance };

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

export interface SkillContent {
  descriptor: SkillDescriptor;
  /** Raw SKILL.md body. */
  body: string;
}

export interface ReferenceDescriptor {
  /** Reference path relative to the skill's references root. */
  path: string;
}

export interface ReferenceContent {
  path: string;
  body: string;
}

/**
 * Pre-read content metadata returned by the OPTIONAL provider size probe
 * ({@link SkillProvider.readMetadata}; design §9, Req 11.5).
 *
 * Lets a provider declare the byte size of a skill body (or a reference body) AT SOURCE,
 * so the runtime can reject oversize content via the byte-count path BEFORE the body is
 * materialized. The probe is transport-agnostic — a remote/bus provider answers from a
 * `Content-Length`-style header or registry metadata, NOT `fs.stat` — so a remote provider
 * cannot ship a 200MB body before the size check runs.
 *
 * `sizeBytes` is OPTIONAL: a provider that cannot cheaply determine the size at source
 * omits it, and the runtime falls back to the post-read content-size backstop. The shape is
 * intentionally an object (not a bare `number`) so it can carry further pre-read metadata in
 * future without changing the probe signature.
 */
export interface SkillContentMetadata {
  /** Declared byte length of the content at source, or omitted when unknown. */
  sizeBytes?: number;
}

export interface SearchResult {
  descriptor: SkillDescriptor;
  score: number;
  /**
   * Optional, provider-supplied display description / snippet for the matched skill.
   *
   * Additive presentation field: a search result commonly carries a human-facing
   * description alongside its identity and score. It is OPTIONAL and provider-supplied —
   * the runtime never synthesizes it, and the list+substring fallback leaves it absent.
   * Identity, dedupe, and conflict detection key on `descriptor.fqid` only, so this field
   * never participates in equivalence. Presenters (e.g. the MCP `search_skills` surface)
   * use it to preserve the published result shape without an adapter side-channel.
   */
  description?: string;
}

// ---------------------------------------------------------------------------
// Resolution (provider-owned)
// ---------------------------------------------------------------------------

/**
 * A descriptor bound to the provider that produced it. `providerLocalRef` is
 * provider-private (filesystem path, DB row id, remote url/cache key) and never leaks
 * to callers — only the producing provider interprets it.
 */
export interface ResolvedSkill {
  descriptor: SkillDescriptor;
  providerId: string;
  providerLocalRef?: unknown;
  provenanceSeed: ProvenanceSeed;
}

// ---------------------------------------------------------------------------
// Capability descriptors (extension seam)
// ---------------------------------------------------------------------------

/**
 * A typed handle to a capability. Carries phantom input/output types so the extension
 * `request<TIn,TOut>` stays type-safe, while the wire `method` string maps 1:1 onto
 * `StdioBus.request(method, params)`. New capabilities are descriptors, not new methods.
 */
export interface CapabilityRef<TInput, TOutput> {
  readonly method: string;
  readonly version: string;
  /** Phantom — never assigned at runtime; carries the input type for `request`. */
  readonly __input?: (input: TInput) => void;
  /** Phantom — never assigned at runtime; carries the output type for `request`. */
  readonly __output?: () => TOutput;
}

/** Runtime-introspectable capability metadata. */
export interface CapabilityDescriptor {
  method: string;
  version: string;
}

/** Construct a typed capability descriptor. */
export function capability<TInput, TOutput>(
  method: string,
  version: string,
): CapabilityRef<TInput, TOutput> {
  return { method, version };
}

// ---------------------------------------------------------------------------
// Core method inputs
// ---------------------------------------------------------------------------

export interface ReadSkillInput {
  ref: SkillRef;
}
export interface ListSkillsInput {
  provider?: string;
}
export interface SearchSkillsInput {
  query: string;
  limit?: number;
}
export interface GetReferencesInput {
  ref: SkillRef;
}
export interface ReadReferenceInput {
  ref: SkillRef;
  reference: string;
}

// ---------------------------------------------------------------------------
// The runtime contract
// ---------------------------------------------------------------------------

/**
 * Stable typed core + open extension seam.
 *
 * The five core methods are a common protocol every skill must support (this is a
 * closed set of OPERATIONS, not of identities). `request` is the generative seam:
 * provider-specific or future capabilities are reached via typed {@link CapabilityRef}
 * without changing this interface.
 */
export interface SkillsRuntime {
  read(input: ReadSkillInput): Promise<SkillResponse<SkillContent>>;
  list(input?: ListSkillsInput): Promise<SkillResponse<SkillDescriptor[]>>;
  search(input: SearchSkillsInput): Promise<SkillResponse<SearchResult[]>>;
  getReferences(input: GetReferencesInput): Promise<SkillResponse<ReferenceDescriptor[]>>;
  readReference(input: ReadReferenceInput): Promise<SkillResponse<ReferenceContent>>;

  /** Introspect available capabilities (core + extensions). */
  capabilities(): Promise<CapabilityDescriptor[]>;

  /** Extension seam — typed dispatch to any capability, maps onto bus method strings. */
  request<TInput, TOutput>(
    capability: CapabilityRef<TInput, TOutput>,
    input: TInput,
  ): Promise<SkillResponse<TOutput>>;
}

// ---------------------------------------------------------------------------
// Provider layer (capability-optional)
// ---------------------------------------------------------------------------

/** Which optional operations a provider supports. Drives runtime fallback orchestration. */
export interface SkillProviderCapabilities {
  read: boolean;
  list: boolean;
  search: boolean;
  references: boolean;
}

/**
 * A provider participates in the runtime. `resolve` is mandatory; everything else is
 * capability-optional. A provider that cannot `search` is not broken — the runtime
 * orchestrates a fallback. New sources are added as providers; the core contract is untouched.
 */
export interface SkillProvider {
  readonly id: string;
  readonly capabilities: SkillProviderCapabilities;

  /** Resolve a ref to zero or more candidates owned by THIS provider. */
  resolve(ref: SkillRef): Promise<ResolvedSkill[]>;

  read?(resolved: ResolvedSkill): Promise<SkillContent>;
  list?(input?: ListSkillsInput): Promise<ResolvedSkill[]>;
  search?(input: SearchSkillsInput): Promise<SearchResult[]>;
  listReferences?(resolved: ResolvedSkill): Promise<ReferenceDescriptor[]>;
  readReference?(resolved: ResolvedSkill, reference: string): Promise<ReferenceContent>;

  /**
   * OPTIONAL pre-read size probe (Req 11.5, "shall not load in full"; design §9).
   *
   * When implemented, the runtime calls this BEFORE {@link read}/{@link readReference} so an
   * untrusted provider's oversize content is rejected via the byte-count path WITHOUT being
   * materialized. The probe reports the body size AT SOURCE:
   * - `reference` omitted → size of the skill body served by {@link read};
   * - `reference` supplied → size of that reference body served by {@link readReference}.
   *
   * It is a CONTRACT, not an `fs.stat` binding: a remote/bus provider answers from a
   * declared `Content-Length`-style size so it cannot transmit a huge body before the check.
   * A provider that cannot determine the size cheaply returns `{ sizeBytes: undefined }` (or
   * omits the field), and the runtime falls back to the post-read content-size backstop.
   * Capability-optional by PRESENCE: a provider that does not implement this method opts out,
   * and the runtime relies on the backstop — exactly the bundled-provider behavior.
   */
  readMetadata?(resolved: ResolvedSkill, reference?: string): Promise<SkillContentMetadata>;

  /**
   * OPTIONAL provider resource-scope declaration (Milestone-002 provider resource-scope
   * contract; design §9, Req 11.4).
   *
   * Returns the absolute filesystem root that genuinely contains the resources for a
   * resolved skill (and, optionally, a specific reference) — e.g. the bundled provider's
   * `{packageRoot}/agent-skills/{skill}/references` directory. The runtime enforces
   * {@link checkWithinRoot} against THIS root so its path-traversal boundary is a TRUE
   * generalization of the provider's own containment: it rejects a cross-skill reference
   * that escapes the skill's references root (e.g. an absolute path into a SIBLING skill),
   * not merely a `..` segment.
   *
   * Knowing the on-disk layout is the PROVIDER's job, never the runtime's: the runtime must
   * not invent filesystem containment. A provider with no filesystem resource root (a
   * remote registry, a DB, a virtual provider) does NOT implement this method (or returns
   * `undefined`) and thereby OPTS OUT — the runtime then applies no path guard and relies on
   * the provider's own containment as the backstop. Capability-optional by PRESENCE, exactly
   * like {@link readMetadata}.
   *
   * @param resolved - the resolved skill whose resource root is requested.
   * @param reference - the specific reference path being admitted, when applicable.
   * @returns the absolute resource root to enforce containment against, or `undefined` to
   *   opt out (no filesystem resource root for this provider).
   */
  resourceRoot?(resolved: ResolvedSkill, reference?: string): string | undefined;
}
