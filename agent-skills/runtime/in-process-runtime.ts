/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

import { CORE_CAPABILITIES, SkillsCapabilities } from './capabilities.js';
import type {
  CapabilityDescriptor,
  CapabilityRef,
  GetReferencesInput,
  ListSkillsInput,
  Provenance,
  ReadReferenceInput,
  ReadSkillInput,
  ReferenceContent,
  ReferenceDescriptor,
  ResolvedSkill,
  SearchResult,
  SearchSkillsInput,
  SkillContent,
  SkillDescriptor,
  SkillProvider,
  SkillRef,
  SkillResponse,
  SkillRuntimeError,
  SkillsRuntime,
} from './contract.js';
import {
  type AggregateDiagnostics,
  attachAggregateDiagnostics,
  readAggregateDiagnostics,
} from './federation.js';
import { checkContentSize, checkIsolation, checkWithinRoot } from './security/boundary.js';
import type { TrustPolicy } from './trust.js';

/**
 * Per-provider trust lookup (Task 9.2 wiring choice (b); design §9).
 *
 * Resolves a provider id to its effective {@link TrustPolicy} so the runtime can enforce
 * that provider's `permittedRoot` / `maxContentBytes` at the import boundary. Threaded in
 * as an OPTIONAL constructor dependency: when omitted (all direct-construction call sites),
 * the runtime applies NO security enforcement and behaves exactly as before — so this is a
 * strictly additive, backward-compatible seam. The registry → factory path supplies it for
 * federated/bundled deployments (see `registry.ts`).
 */
export type TrustLookup = (providerId: string) => TrustPolicy | undefined;

/**
 * In-process implementation of {@link SkillsRuntime}.
 *
 * Knows ONLY providers, refs, capabilities, responses, and provenance. It does not know
 * the `SkillName` enum and never touches a package root directly — that lives entirely
 * inside providers. This is the invariant the spike proves.
 *
 * Transport: this implementation calls providers directly in-process (no serialization).
 * A future Bus-backed implementation satisfies the SAME interface; `request()` already
 * maps capability descriptors onto `StdioBus.request(method, params)` shape.
 */
export class InProcessSkillsRuntime implements SkillsRuntime {
  /**
   * @param providers - the ordered providers (precedence = order).
   * @param trustOf - OPTIONAL per-provider trust lookup (Task 9.2). When supplied, the
   *   runtime enforces each provider's `permittedRoot` (path-traversal → `out_of_bounds`)
   *   and `maxContentBytes` (oversize → `content_too_large`) at the read boundary, as
   *   RETURNED errors (never thrown). When omitted, no security enforcement is applied and
   *   behavior is identical to the proven baseline.
   */
  constructor(
    private readonly providers: ReadonlyArray<SkillProvider>,
    private readonly trustOf?: TrustLookup,
  ) { }

  // --- security boundary (Task 9.2; design §9; Req 11.4, 11.5) ----------

  /**
   * Path-traversal boundary (Req 11.4). Returns an `out_of_bounds` error response when the
   * provider has a `permittedRoot` and `candidatePath` escapes it; the caller MUST return
   * this WITHOUT reading the location. Returns `null` when there is nothing to enforce
   * (no trust lookup, or no `permittedRoot` — in which case the provider's own resolver
   * guard remains the backstop, as documented on {@link TrustPolicy.permittedRoot}).
   */
  private enforceWithinRoot(providerId: string, candidatePath: string): SkillResponse<never> | null {
    const policy = this.trustOf?.(providerId);
    if (!policy?.permittedRoot) return null;
    const res = checkWithinRoot(policy.permittedRoot, candidatePath, providerId);
    return res.ok ? null : { ok: false, error: res.error };
  }

  /**
   * Content-size boundary (Req 11.5). Returns a `content_too_large` error response when the
   * provider has a trust policy and `content` exceeds its `maxContentBytes`. Returns `null`
   * when there is no trust lookup (no enforcement → proven baseline behavior).
   */
  private enforceContentSize(providerId: string, content: string): SkillResponse<never> | null {
    const policy = this.trustOf?.(providerId);
    if (!policy) return null;
    const res = checkContentSize(content, policy.maxContentBytes, providerId);
    return res.ok ? null : { ok: false, error: res.error };
  }

  /**
   * Untrusted-content isolation admission boundary (Task 9.3; design §9; Req 11.2, 11.3).
   *
   * The single, reusable gate that the untrusted-content import path (`fetch`/`add` —
   * forward-looking per Req 7.1, NOT yet a core op) MUST route through BEFORE any fetched/
   * imported content is admitted to trusted runtime state. Mirrors
   * {@link enforceWithinRoot} / {@link enforceContentSize}:
   *
   * - returns an `isolation_failed` error response (RETURNED, never thrown — the Req 11.3
   *   totality case) when the provider's policy requires isolation but `isolationAvailable`
   *   is false; the caller MUST NOT admit the content;
   * - returns `null` when admission is allowed (trusted provider, `isolateFetch: false`, or
   *   isolation required AND satisfiable), or when there is no trust lookup (no enforcement
   *   → proven baseline behavior, identical to the other two boundary methods).
   *
   * This method is intentionally PUBLIC and currently has no core-op caller: there is no
   * `fetch`/`add` operation yet (Req 7.1 is forward-looking). It is exposed so the future
   * admission path routes through it and so the Task 9.4 unit / 9.5 property tests can
   * exercise the gate directly. `isolationAvailable` models "the configured isolation
   * boundary (e.g. the out-of-process stdio Bus worker, design open-item E) is present and
   * usable". The concrete sandbox mechanism remains open; this is the interim predicate.
   */
  enforceIsolation(providerId: string, isolationAvailable: boolean): SkillResponse<never> | null {
    const policy = this.trustOf?.(providerId);
    if (!policy) return null;
    const res = checkIsolation(policy, { provider: providerId, isolationAvailable });
    return res.ok ? null : { ok: false, error: res.error };
  }

  // --- resolution -------------------------------------------------------

  /**
   * Resolve a ref across ALL providers, returning every candidate plus any
   * per-provider resolution failures. A provider whose `resolve` throws is caught
   * here and recorded as a returned error rather than aborting the fan-out — one
   * throwing provider must never abort resolution or propagate across the boundary
   * (Req 2.6). Providers that resolve successfully still contribute their candidates.
   */
  private async resolveAll(
    ref: SkillRef,
  ): Promise<{ candidates: ResolvedSkill[]; errors: Array<{ provider: string; message: string }> }> {
    const errors: Array<{ provider: string; message: string }> = [];
    const perProvider = await Promise.all(
      this.providers.map(async (p) => {
        try {
          return await p.resolve(ref);
        } catch (e) {
          errors.push({ provider: p.id, message: String(e) });
          return [] as ResolvedSkill[];
        }
      }),
    );
    return { candidates: perProvider.flat(), errors };
  }

  /** Distinct candidates keyed by fqid (federation dedupe by stable identity). */
  private dedupeByFqid(candidates: ResolvedSkill[]): ResolvedSkill[] {
    const seen = new Map<string, ResolvedSkill>();
    for (const c of candidates) {
      if (!seen.has(c.descriptor.fqid)) seen.set(c.descriptor.fqid, c);
    }
    return [...seen.values()];
  }

  /**
   * Canonical, order-stable serialization of a {@link SkillDescriptor} used as the
   * INTERIM content-equivalence criterion for conflict detection (open-item C).
   *
   * `list`/`search` carry no skill body, so two same-FQID descriptors are treated as a
   * CONFLICT iff their descriptor fields differ structurally (keys sorted so field order
   * is irrelevant). Open-item C will replace this with a `contentHash`-based comparison;
   * because conflict detection is funneled through this one method, that swap changes only
   * here and never touches the aggregation algorithm or the contract.
   */
  private descriptorSignature(d: SkillDescriptor): string {
    const entries = Object.entries(d as unknown as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return JSON.stringify(entries);
  }

  /**
   * Deterministic federation dedupe + conflict surfacing for an aggregated collection.
   *
   * Iterates `items` in the given (provider-precedence) order, keying by FQID:
   * - the FIRST occurrence of an FQID is kept in `deduped` (no silent "best" pick — order
   *   is registry/providers order, which is the documented interim precedence);
   * - a later item sharing an FQID but DIFFERING by {@link descriptorSignature} marks that
   *   FQID as a conflict (Req 4.2, 4.4) — the runtime surfaces it instead of silently
   *   collapsing it;
   * - every provider that contributed an entry under a conflicting FQID is recorded, in
   *   first-seen order, on the conflict entry.
   *
   * Generic over the item type so it serves both `list` (`ResolvedSkill`) and `search`
   * (`SearchResult`); `fqidOf`/`descriptorOf` project the identity and the comparable
   * descriptor. Determinism: `Map`/`Set` preserve insertion order, so `deduped` and
   * `conflicts` are stable functions of the input order.
   */
  private dedupeWithConflicts<T>(
    items: readonly T[],
    fqidOf: (item: T) => string,
    descriptorOf: (item: T) => SkillDescriptor,
  ): { deduped: T[]; conflicts: Array<{ fqid: string; providers: string[] }> } {
    const firstByFqid = new Map<string, T>();
    const providersByFqid = new Map<string, string[]>();
    const conflictFqids = new Set<string>();

    for (const item of items) {
      const fqid = fqidOf(item);
      const provider = descriptorOf(item).provider;
      const existing = firstByFqid.get(fqid);
      if (existing === undefined) {
        firstByFqid.set(fqid, item);
        providersByFqid.set(fqid, [provider]);
        continue;
      }
      const providers = providersByFqid.get(fqid)!;
      if (!providers.includes(provider)) providers.push(provider);
      if (this.descriptorSignature(descriptorOf(existing)) !== this.descriptorSignature(descriptorOf(item))) {
        conflictFqids.add(fqid);
      }
    }

    const conflicts = [...conflictFqids].map((fqid) => ({
      fqid,
      providers: providersByFqid.get(fqid)!,
    }));
    return { deduped: [...firstByFqid.values()], conflicts };
  }

  private finalizeProvenance(resolved: ResolvedSkill, askedRef: SkillRef): Provenance {
    return {
      ...resolved.provenanceSeed,
      fqid: resolved.descriptor.fqid,
      provider: resolved.providerId,
      source: resolved.provenanceSeed.source,
      resolvedFrom: askedRef,
    };
  }

  /**
   * Resolve a ref to exactly one candidate or a typed error.
   * Ambiguity (more than one distinct fqid) is NEVER resolved by silent first-match.
   */
  private async resolveOne(
    ref: SkillRef,
  ): Promise<{ ok: true; resolved: ResolvedSkill } | { ok: false; error: SkillResponse<never> }> {
    const { candidates, errors } = await this.resolveAll(ref);
    const distinct = this.dedupeByFqid(candidates);
    if (distinct.length === 0) {
      // A throwing provider with no successful candidate is attributed as a
      // returned provider_error rather than masquerading as not_found.
      if (errors.length > 0) {
        const first = errors[0];
        return {
          ok: false,
          error: {
            ok: false,
            error: { code: 'provider_error', provider: first.provider, message: first.message },
          },
        };
      }
      return { ok: false, error: { ok: false, error: { code: 'not_found', ref } } };
    }
    if (distinct.length > 1) {
      return {
        ok: false,
        error: {
          ok: false,
          error: { code: 'ambiguous', ref, candidates: distinct.map((c) => c.descriptor) },
        },
      };
    }
    return { ok: true, resolved: distinct[0] };
  }

  private providerById(id: string): SkillProvider | undefined {
    return this.providers.find((p) => p.id === id);
  }

  // --- core capabilities ------------------------------------------------

  async read(input: ReadSkillInput): Promise<SkillResponse<SkillContent>> {
    const r = await this.resolveOne(input.ref);
    if (!r.ok) return r.error;

    const provider = this.providerById(r.resolved.providerId);
    if (!provider?.read) {
      return { ok: false, error: { code: 'unsupported', capability: 'read', provider: r.resolved.providerId } };
    }
    try {
      const data = await provider.read(r.resolved);
      // Content-size boundary (Req 11.5): reject oversize content as a RETURNED error.
      const sizeGuard = this.enforceContentSize(r.resolved.providerId, data.body);
      if (sizeGuard) return sizeGuard;
      return { ok: true, data, provenance: this.finalizeProvenance(r.resolved, input.ref) };
    } catch (e) {
      return {
        ok: false,
        error: { code: 'provider_error', provider: r.resolved.providerId, message: String(e) },
      };
    }
  }

  async list(input?: ListSkillsInput): Promise<SkillResponse<SkillDescriptor[]>> {
    // Supporting providers = those that DECLARE `capabilities.list` AND expose a `list`
    // method (Req 3.2: never invoke an operation a provider declares unsupported), after
    // applying the optional `input.provider` scope.
    const supporting = this.providers
      .filter((p) => (input?.provider ? p.id === input.provider : true))
      .filter(
        (p): p is SkillProvider & Required<Pick<SkillProvider, 'list'>> =>
          p.capabilities.list && Boolean(p.list),
      );

    // Polarity branch 1 — no provider supports the operation for the target → `unsupported`
    // (Req 3.4). When the request is provider-scoped, name that provider for diagnosis.
    if (supporting.length === 0) {
      return {
        ok: false,
        error: input?.provider
          ? { code: 'unsupported', capability: 'list', provider: input.provider }
          : { code: 'unsupported', capability: 'list' },
      };
    }

    // INTERIM fan-out (open-item B): invoke every supporting provider concurrently with
    // `Promise.all`, bounded only by registry size. A `FanoutPolicy` (max concurrency,
    // per-provider timeout, AbortSignal) injects here later without changing the contract.
    // Aggregate totality: a single throwing/failing provider is RECORDED in `sources`, never
    // propagated as a throw (builds on the proven per-provider try/catch).
    const outcomes = await Promise.all(
      supporting.map(async (p) => {
        try {
          return { provider: p.id, resolved: await p.list!(input) };
        } catch (e) {
          const error: SkillRuntimeError = { code: 'provider_error', provider: p.id, message: String(e) };
          return { provider: p.id, error };
        }
      }),
    );

    // Per-provider outcomes (Req 4.1, 4.3) + collected candidates, in providers order.
    const sources: AggregateDiagnostics['sources'] = [];
    const collected: ResolvedSkill[] = [];
    for (const outcome of outcomes) {
      if ('error' in outcome) {
        sources.push({ provider: outcome.provider, ok: false, error: outcome.error });
        continue;
      }
      sources.push({ provider: outcome.provider, ok: true, count: outcome.resolved.length });
      collected.push(...outcome.resolved);
    }

    // INTERIM dedupe by exact FQID + conflict surfacing (Req 4.2, 4.4): keep the first
    // occurrence; never silently pick among same-FQID-differing-content clashes.
    const { deduped, conflicts } = this.dedupeWithConflicts(
      collected,
      (r) => r.descriptor.fqid,
      (r) => r.descriptor,
    );
    const data = deduped.map((r) => r.descriptor);

    // Polarity branch 4 — every SUPPORTING provider failed → `aggregate_error` preserving
    // each provider's returned error code (Req 4.8). `supporting.length >= 1` here, so
    // `sources` is non-empty and `every` is a genuine all-failed test, not vacuous.
    if (sources.every((s) => !s.ok)) {
      const failures = sources.map((s) => ({ provider: s.provider, error: s.error! }));
      return { ok: false, error: { code: 'aggregate_error', failures } };
    }

    // Polarity branches 2 & 3 — at least one supporting provider succeeded → `ok: true`
    // with the (possibly partial, possibly empty) collection + aggregate diagnostics
    // (Req 4.6, 4.7). An empty `data` here is a supported-but-zero-results success.
    // Aggregate listing has no single origin — provenance carries the runtime as source,
    // with the per-source/conflict diagnostics attached under the named provenance key.
    const provenance = attachAggregateDiagnostics(
      { fqid: '*', provider: 'runtime', source: 'aggregate:list' },
      { sources, conflicts },
    );
    return { ok: true, data, provenance };
  }

  async search(input: SearchSkillsInput): Promise<SkillResponse<SearchResult[]>> {
    // Search "supporting path" = a native search provider, OR the list-based fallback,
    // which is available iff ≥1 provider supports `list` (declares capability + method).
    const native = this.providers.find((p) => p.capabilities.search && p.search);
    const hasListFallback = this.providers.some((p) => p.capabilities.list && Boolean(p.list));

    // Polarity branch 1 — no path can serve the operation at all → `unsupported`
    // (Req 3.4): neither a native search provider nor a list-based fallback exists.
    if (!native?.search && !hasListFallback) {
      return { ok: false, error: { code: 'unsupported', capability: 'search' } };
    }

    // Prefer a provider that natively supports search.
    if (native?.search) {
      try {
        const raw = await native.search(input);
        // Apply the same dedupe/conflict treatment to search results (by descriptor.fqid).
        const { deduped, conflicts } = this.dedupeWithConflicts(
          raw,
          (r) => r.descriptor.fqid,
          (r) => r.descriptor,
        );
        const sources: AggregateDiagnostics['sources'] = [
          { provider: native.id, ok: true, count: deduped.length },
        ];
        const provenance = attachAggregateDiagnostics(
          { fqid: '*', provider: native.id, source: 'search:native' },
          { sources, conflicts },
        );
        return { ok: true, data: deduped, provenance };
      } catch (e) {
        // The native search failed. Record it as the failing source and PREFER the
        // documented fallback (resilience + matches the bundled-deployment behavior). If
        // no list-based fallback exists, the native attempt was the only supporting path,
        // so every supporting provider failed → `aggregate_error` (Req 4.8).
        const nativeError: SkillRuntimeError = {
          code: 'provider_error',
          provider: native.id,
          message: String(e),
        };
        if (!hasListFallback) {
          return { ok: false, error: { code: 'aggregate_error', failures: [{ provider: native.id, error: nativeError }] } };
        }
        return this.searchViaListFallback(input, {
          extraSources: [{ provider: native.id, ok: false, error: nativeError }],
          fallbackLabel: 'search:fallback(list+substring) after native search failed',
          extraFailures: [{ provider: native.id, error: nativeError }],
        });
      }
    }

    // No native search → degrade to the documented list+substring fallback.
    return this.searchViaListFallback(input, {
      extraSources: [],
      fallbackLabel: 'search:fallback(list+substring)',
      extraFailures: [],
    });
  }

  /**
   * Search fallback: serve `search` THROUGH `list` + substring match when no provider
   * offers native search (or after a native search failed). The fallback inherits `list`'s
   * polarity exactly (design §4b step 4):
   * - `list` → `unsupported` (no list providers) ⇒ search is `unsupported` (capability:'search');
   * - `list` → `aggregate_error` (every list provider failed) ⇒ propagate as the search
   *   failure, merging any prior (native) failure so each provider's error is preserved (Req 4.8);
   * - `list` → `ok` ⇒ apply the substring filter and return `ok` (possibly empty, Req 4.7).
   *
   * `extraSources`/`fallbackLabel`/`extraFailures` carry diagnostics from a preceding native
   * attempt so the surfaced provenance/aggregate error reflects the full supporting set.
   */
  private async searchViaListFallback(
    input: SearchSkillsInput,
    opts: {
      extraSources: AggregateDiagnostics['sources'];
      fallbackLabel: string;
      extraFailures: Array<{ provider: string; error: SkillRuntimeError }>;
    },
  ): Promise<SkillResponse<SearchResult[]>> {
    const listed = await this.list();
    if (!listed.ok) {
      // No list providers → the whole search operation is unsupported (name the capability
      // the CALLER asked for, not the internal `list` it delegated to).
      if (listed.error.code === 'unsupported') {
        return { ok: false, error: { code: 'unsupported', capability: 'search' } };
      }
      // Every list provider failed → propagate as an aggregate search failure, preserving
      // each provider's error code and merging any prior native-search failure (Req 4.8).
      if (listed.error.code === 'aggregate_error') {
        return {
          ok: false,
          error: {
            code: 'aggregate_error',
            failures: [...opts.extraFailures, ...listed.error.failures],
          },
        };
      }
      return listed;
    }

    const listDiagnostics = readAggregateDiagnostics(listed.provenance);
    const q = input.query.toLowerCase();
    const matched: SearchResult[] = listed.data
      .filter((d) => d.name.toLowerCase().includes(q))
      .slice(0, input.limit ?? listed.data.length)
      .map((descriptor) => ({ descriptor, score: 1 }));
    // `list` already deduped by FQID, so this is identity here; running it keeps the
    // treatment uniform and surfaces any residual same-FQID clash deterministically.
    const { deduped, conflicts } = this.dedupeWithConflicts(
      matched,
      (r) => r.descriptor.fqid,
      (r) => r.descriptor,
    );
    const diagnostics: AggregateDiagnostics = {
      sources: [...opts.extraSources, ...(listDiagnostics?.sources ?? [])],
      conflicts: [...(listDiagnostics?.conflicts ?? []), ...conflicts],
      fallbacksApplied: [opts.fallbackLabel],
    };
    const provenance = attachAggregateDiagnostics(
      { fqid: '*', provider: 'runtime', source: opts.fallbackLabel },
      diagnostics,
    );
    return { ok: true, data: deduped, provenance };
  }

  async getReferences(input: GetReferencesInput): Promise<SkillResponse<ReferenceDescriptor[]>> {
    const r = await this.resolveOne(input.ref);
    if (!r.ok) return r.error;
    const provider = this.providerById(r.resolved.providerId);
    if (!provider?.listReferences) {
      return {
        ok: false,
        error: { code: 'unsupported', capability: 'references', provider: r.resolved.providerId },
      };
    }
    try {
      const data = await provider.listReferences(r.resolved);
      return { ok: true, data, provenance: this.finalizeProvenance(r.resolved, input.ref) };
    } catch (e) {
      return {
        ok: false,
        error: { code: 'provider_error', provider: r.resolved.providerId, message: String(e) },
      };
    }
  }

  async readReference(input: ReadReferenceInput): Promise<SkillResponse<ReferenceContent>> {
    const r = await this.resolveOne(input.ref);
    if (!r.ok) return r.error;
    const provider = this.providerById(r.resolved.providerId);
    if (!provider?.readReference) {
      return {
        ok: false,
        error: { code: 'unsupported', capability: 'references', provider: r.resolved.providerId },
      };
    }
    // Path-traversal boundary (Req 11.4): reject an out-of-bounds reference path BEFORE
    // delegating, so the out-of-bounds location is never read.
    const pathGuard = this.enforceWithinRoot(r.resolved.providerId, input.reference);
    if (pathGuard) return pathGuard;
    try {
      const data = await provider.readReference(r.resolved, input.reference);
      // Content-size boundary (Req 11.5): reject oversize content as a RETURNED error.
      const sizeGuard = this.enforceContentSize(r.resolved.providerId, data.body);
      if (sizeGuard) return sizeGuard;
      return { ok: true, data, provenance: this.finalizeProvenance(r.resolved, input.ref) };
    } catch (e) {
      return {
        ok: false,
        error: { code: 'provider_error', provider: r.resolved.providerId, message: String(e) },
      };
    }
  }

  // --- introspection + extension seam -----------------------------------

  async capabilities(): Promise<CapabilityDescriptor[]> {
    return CORE_CAPABILITIES.map((c) => ({ method: c.method, version: c.version }));
  }

  /**
   * Typed extension dispatch. The `method` string is the same one that would be sent over
   * `StdioBus.request(method, params)`. New capabilities plug in here without changing the
   * core interface. The cast is the single controlled boundary where the phantom-typed
   * descriptor meets runtime dispatch.
   */
  async request<TInput, TOutput>(
    capability: CapabilityRef<TInput, TOutput>,
    input: TInput,
  ): Promise<SkillResponse<TOutput>> {
    switch (capability.method) {
      case SkillsCapabilities.read.method:
        return this.read(input as ReadSkillInput) as Promise<SkillResponse<TOutput>>;
      case SkillsCapabilities.list.method:
        return this.list(input as ListSkillsInput) as Promise<SkillResponse<TOutput>>;
      case SkillsCapabilities.search.method:
        return this.search(input as SearchSkillsInput) as Promise<SkillResponse<TOutput>>;
      case SkillsCapabilities.listReferences.method:
        return this.getReferences(input as GetReferencesInput) as Promise<SkillResponse<TOutput>>;
      case SkillsCapabilities.readReference.method:
        return this.readReference(input as ReadReferenceInput) as Promise<SkillResponse<TOutput>>;
      default:
        return { ok: false, error: { code: 'unsupported', capability: capability.method } };
    }
  }
}
