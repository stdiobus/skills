/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

import { AdmissionCapabilities, CORE_CAPABILITIES, SkillsCapabilities } from './capabilities.js';
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
import type { NamespaceOwnershipTable } from './admission/namespace-ownership.js';
import type { AdmittedProvider } from './admission/outcome.js';
import type { RawProviderDescriptor } from './admission/provider-descriptor.js';
import { type AggregateDiagnostics, attachAggregateDiagnostics } from './federation.js';
import { finalizeProvenance } from './provenance.js';
import { ConstantProviderView, type ProviderView } from './registry.js';
import { checkIsolation, checkWithinRoot } from './security/boundary.js';
import { ProviderOutputValidator } from './security/provider-output-validator.js';
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
 * In-process admission seam for the `request` extension dispatch (Task 9.2; design §"Components" 7).
 *
 * The OPTIONAL handler the runtime delegates a `skills.add.v1` `request` to, so admission is
 * reached IN-PROCESS through `runtime.request(AdmissionCapabilities.add, rawDescriptor)` —
 * the same way the bus reaches it through the worker dispatch — without the runtime importing
 * the concrete {@link AdmissionCapabilityHandler} (the structural shape is enough, keeping the
 * dependency direction runtime ⇠ admission intact). It is wired as an OPTIONAL constructor
 * dependency: when omitted (every proven call site), `request('skills.add.v1', …)` returns
 * `unsupported` exactly as before, so this is strictly additive and backward-compatible
 * (Req 15.1, 15.3). The handler normalizes the raw wire descriptor and delegates to the
 * single {@link AdmissionController}; the runtime holds no admission logic of its own.
 */
export interface AdmissionRequestHandler {
  handle(raw: RawProviderDescriptor): Promise<SkillResponse<AdmittedProvider>>;
}

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
   * The stable read seam the runtime obtains its provider list from (Req 10.1, 10.2;
   * design §"Components" 5). Each public operation captures EXACTLY ONE snapshot from this
   * view at entry (`view.providers()`) and threads that single array through every helper —
   * the helpers never re-read the view, so mixed-snapshot reads are mechanically prevented
   * (Req 10.3) and an `admit` interleaved with an in-flight operation cannot change that
   * operation's provider set (design Property 3).
   */
  private readonly view: ProviderView;

  /**
   * Provider-output ingress validator (Task 6; design §"Components" 6; Req 6, 5.4, 5.5).
   *
   * Applied at the provider-output boundary of EVERY public operation — `resolve` (via
   * {@link resolveOne}), `list`, `search`, and the provider methods behind `getReferences` /
   * `readReference` — BEFORE a returned value is exposed to a caller or to aggregation. It
   * composes the existing pure guards ({@link guardDescriptorIdentity}, {@link checkContentSize})
   * and the namespace anti-spoofing predicate, adding NO new trust evaluation. Both the
   * namespace table and the trust lookup it holds are optional, so when neither is wired the
   * validator is identity-only and behaves exactly like the pre-Task-6 boundary — the proven
   * single-bundled-provider baseline is byte-for-byte unchanged (Req 15.2).
   */
  private readonly outputValidator: ProviderOutputValidator;

  /**
   * @param view - the provider source. Accepts EITHER a stable {@link ProviderView} (the
   *   admission-capable `MutableProviderView`, or any view) OR — for backward compatibility
   *   with every proven array-constructed call site — a plain `ReadonlyArray<SkillProvider>`,
   *   which is wrapped verbatim in a {@link ConstantProviderView}. The wrap is a pure
   *   structural adapter: provider order, identity, `trustOf`/provenance lookup, and the
   *   exact inputs handed to `dedupeWithConflicts` are byte-for-byte unchanged, so the
   *   single-bundled-provider baseline is identical to pre-M-002 (Req 10.1, 15.2, design
   *   fix 9).
   * @param trustOf - OPTIONAL per-provider trust lookup (Task 9.2). When supplied, the
   *   runtime enforces each provider's `permittedRoot` (path-traversal → `out_of_bounds`)
   *   and `maxContentBytes` (oversize → `content_too_large`) at the read boundary, as
   *   RETURNED errors (never thrown). When omitted, no security enforcement is applied and
   *   behavior is identical to the proven baseline.
   * @param namespaces - OPTIONAL namespace-ownership source of truth (Task 6; Req 5.4, 5.5).
   *   When supplied, the provider-output boundary additionally rejects any descriptor whose
   *   declared FQID falls outside the namespace owned by the producing provider — keyed on
   *   the actual child provider id, never masked by aggregation. The reserved `bundled`
   *   provider (and any provider that owns no namespace) is EXEMPT, so wiring a table for a
   *   federated deployment never rejects bundled output. When omitted, the namespace check
   *   is inert and the descriptor-identity boundary is exactly the proven baseline.
   * @param admission - OPTIONAL in-process admission seam (Task 9.2). When supplied,
   *   `request(AdmissionCapabilities.add, rawDescriptor)` is delegated to it (normalize →
   *   admit → map), so admission is reachable in-process through the SAME `request` seam the
   *   bus reaches it through the worker dispatch. When omitted, `request('skills.add.v1', …)`
   *   returns `unsupported` exactly as before — strictly additive, backward-compatible.
   */
  constructor(
    view: ProviderView | ReadonlyArray<SkillProvider>,
    private readonly trustOf?: TrustLookup,
    namespaces?: NamespaceOwnershipTable,
    private readonly admission?: AdmissionRequestHandler,
  ) {
    // Backward-compat (Req 10.1, 15.2): a passed array is wrapped in a ConstantProviderView
    // so the proven baseline is byte-for-byte unchanged; a ProviderView is used as given.
    this.view = Array.isArray(view) ? new ConstantProviderView(view) : (view as ProviderView);
    // The validator reuses the runtime's own trust lookup for the content-size bound and the
    // optional namespace table for anti-spoofing. Both optional → inert by default (baseline).
    this.outputValidator = new ProviderOutputValidator(namespaces, this.trustOf);
  }

  // --- security boundary (Task 9.2; design §9; Req 11.4, 11.5) ----------

  /**
   * Path-traversal boundary (Req 11.4; Milestone-002 provider resource-scope contract).
   *
   * Returns an `out_of_bounds` error response when `candidatePath` escapes the resolved
   * skill's effective resource root; the caller MUST return this WITHOUT reading the
   * location. The root is sourced in this order, so the runtime NEVER invents filesystem
   * containment of its own:
   *
   *   1. the PROVIDER's declared resource root for this resolved skill / reference
   *      ({@link SkillProvider.resourceRoot}) — the correctly-scoped root (e.g. the bundled
   *      provider's `{packageRoot}/agent-skills/{skill}/references` directory). Enforcing
   *      against THIS makes the guard a TRUE generalization of the provider's own
   *      containment: it catches a cross-skill reference (an absolute path into a SIBLING
   *      skill), not merely a `..` segment;
   *   2. else the registration's coarse trust `permittedRoot` (a backstop for a provider
   *      that declares no resource root but still has a coarse permitted root);
   *   3. else `null` — the provider opted out of a filesystem resource root (remote/DB), so
   *      the runtime applies no path guard and relies on the provider's OWN containment.
   *
   * Enforcement is active only when a trust lookup is wired (preserving the proven baseline:
   * direct construction → no enforcement). When wired but neither a provider resource root
   * nor a `permittedRoot` is available, behavior matches the prior baseline (no guard).
   */
  private enforceWithinRoot(
    provider: SkillProvider,
    resolved: ResolvedSkill,
    candidatePath: string,
  ): SkillResponse<never> | null {
    if (!this.trustOf) return null;
    const root = provider.resourceRoot?.(resolved, candidatePath) ?? this.trustOf(provider.id)?.permittedRoot;
    if (root === undefined) return null;
    const res = checkWithinRoot(root, candidatePath, provider.id);
    return res.ok ? null : { ok: false, error: res.error };
  }

  /**
   * Content-size boundary (Req 11.5). Returns a `content_too_large` error response when the
   * provider has a trust policy and `content` exceeds its `maxContentBytes`. Returns `null`
   * when there is no trust lookup (no enforcement → proven baseline behavior).
   */
  private enforceContentSize(providerId: string, content: string): SkillResponse<never> | null {
    // Delegated to the provider-output validator (Task 6): it reuses the same pure
    // `checkContentSize` guard against the provider's effective `maxContentBytes`, so this
    // is behavior-identical to the prior inline check (inert with no trust lookup → baseline).
    const error = this.outputValidator.validateContentSize(providerId, content);
    return error ? { ok: false, error } : null;
  }

  /**
   * PRE-READ content-size boundary (Req 11.5, "shall not load in full"; design §9).
   *
   * Closes the latent gap where {@link enforceContentSize} only runs AFTER the provider has
   * already materialized the full body. When the provider has a trust policy AND implements
   * the OPTIONAL {@link SkillProvider.readMetadata} probe, the runtime asks for the declared
   * byte size AT SOURCE and rejects oversize content via the byte-count
   * {@link checkContentSize} overload BEFORE `read`/`readReference` is ever called — so an
   * untrusted (e.g. remote/bus) provider cannot transmit a 200MB body before the check.
   *
   * Returns:
   * - an error response when the probe declares an oversize → the caller MUST return it and
   *   MUST NOT materialize the body;
   * - `null` when there is nothing to enforce here (no trust lookup → proven baseline; no
   *   `readMetadata` probe; or the probe declines to declare a size) — the caller proceeds
   *   and the post-read {@link enforceContentSize} backstop still applies.
   *
   * `reference` selects which body to size: omitted → the skill body ({@link read});
   * supplied → that reference body ({@link readReference}). The probe is awaited inside the
   * caller's existing try/catch, so a throwing probe surfaces as a returned `provider_error`
   * (never thrown across the boundary), consistent with every other provider call.
   */
  private async enforceContentSizePreRead(
    provider: SkillProvider,
    resolved: ResolvedSkill,
    reference?: string,
  ): Promise<SkillResponse<never> | null> {
    const policy = this.trustOf?.(provider.id);
    if (!policy) return null;
    if (!provider.readMetadata) return null;
    const meta = await provider.readMetadata(resolved, reference);
    if (typeof meta.sizeBytes !== 'number') return null;
    // Pre-read ("not loaded in full") size bound via the provider-output validator (Task 6):
    // the byte-count overload of the same pure `checkContentSize` guard, so this is
    // behavior-identical to the prior inline check.
    const error = this.outputValidator.validateContentSize(provider.id, meta.sizeBytes);
    return error ? { ok: false, error } : null;
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
   *
   * DETERMINISTIC ATTRIBUTION (Req 2.5, 4.8): `failures` is ordered by PROVIDER
   * PRECEDENCE (the `providers` array order), NOT by resolve() completion timing.
   * `Promise.all` preserves result order positionally regardless of which promise
   * settles first, so collecting failures while iterating `outcomes` in order makes
   * attribution independent of a slow-vs-fast resolve() race. This mirrors the
   * order-stable per-source collection `list`/`search` already perform, and is the
   * internal `ResolutionDiagnostics` the runtime attributes from — not a public type.
   */
  private async resolveAll(
    providers: ReadonlyArray<SkillProvider>,
    ref: SkillRef,
  ): Promise<{ candidates: ResolvedSkill[]; failures: Array<{ provider: string; error: SkillRuntimeError }> }> {
    const outcomes = await Promise.all(
      providers.map(
        async (
          p,
        ): Promise<
          | { ok: true; resolved: ResolvedSkill[] }
          | { ok: false; failure: { provider: string; error: SkillRuntimeError } }
        > => {
          try {
            return { ok: true, resolved: await p.resolve(ref) };
          } catch (e) {
            const error: SkillRuntimeError = { code: 'provider_error', provider: p.id, message: String(e) };
            return { ok: false, failure: { provider: p.id, error } };
          }
        },
      ),
    );

    const candidates: ResolvedSkill[] = [];
    const failures: Array<{ provider: string; error: SkillRuntimeError }> = [];
    for (const outcome of outcomes) {
      if (outcome.ok) {
        candidates.push(...outcome.resolved);
        continue;
      }
      failures.push(outcome.failure);
    }
    return { candidates, failures };
  }

  /**
   * Content-distinct candidate descriptors, in first-seen (provider-precedence) order.
   *
   * Collapses GENUINE duplicates (descriptors that are byte-for-byte equal by
   * {@link descriptorSignature}) to a single entry, while preserving every descriptor that
   * differs in any field — including two descriptors that COLLIDE on one FQID but differ in
   * content. This is exactly the candidate set surfaced on an `ambiguous` result so the
   * caller sees every clashing descriptor and the runtime never silently drops one
   * (Req 1.4, 2.7, 5.6).
   */
  private distinctDescriptors(candidates: readonly ResolvedSkill[]): SkillDescriptor[] {
    const bySignature = new Map<string, SkillDescriptor>();
    for (const c of candidates) {
      const signature = this.descriptorSignature(c.descriptor);
      if (!bySignature.has(signature)) bySignature.set(signature, c.descriptor);
    }
    return [...bySignature.values()];
  }

  /**
   * Descriptor identity guard at provider ingress (Req 5.7, 1.5; design §5).
   *
   * Runs {@link ProviderOutputValidator.validateDescriptors} over a batch of descriptors
   * produced by ONE provider and returns the FIRST inadmissible descriptor's error, or
   * `null` when every descriptor is admissible. Funnelling every resolution / list / search
   * ingress through this one method guarantees no partial, malformed, oversized, or
   * out-of-namespace descriptor is admitted — or used as an FQID dedupe key — without being
   * rejected as a returned error (never thrown).
   *
   * `producingProviderId` is the id of the provider that ACTUALLY produced the batch (the
   * child id — Req 5.5), so the validator's namespace anti-spoofing check is anchored on the
   * real source and can never be masked by aggregation. Identity is always checked; the
   * namespace check is additive and inert unless an ownership table is wired and the provider
   * owns a namespace (so the bundled-only baseline is unchanged).
   */
  private guardDescriptors(
    producingProviderId: string,
    descriptors: readonly SkillDescriptor[],
  ): SkillRuntimeError | null {
    return this.outputValidator.validateDescriptors(producingProviderId, descriptors);
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
    return finalizeProvenance(resolved, askedRef);
  }

  /**
   * Resolve a ref to exactly one candidate or a typed error.
   *
   * Single-skill resolution routes through the SAME conflict-aware {@link dedupeWithConflicts}
   * that `list`/`search` use, so identity collisions are handled identically everywhere
   * (Task 31 — supersedes T13). Ambiguity is NEVER resolved by a silent first-match:
   *
   * - two DISTINCT descriptors that COLLIDE on one FQID (same `fqid`, differing content) are
   *   surfaced as a `conflicts` entry by the dedupe and yield `ambiguous` (Req 5.6) — the
   *   prior `dedupeByFqid` silently kept the first such descriptor, which this fix removes;
   * - two or more candidates with DIFFERING FQIDs likewise yield `ambiguous` (Req 1.4, 2.7);
   * - GENUINE duplicates (same FQID AND identical descriptor content) collapse to one and
   *   resolve cleanly — a single bundled provider never collides, so its resolution is
   *   unchanged (Req 5.5).
   *
   * The `ambiguous` candidate list is the set of CONTENT-DISTINCT descriptors
   * ({@link distinctDescriptors}), so every clashing descriptor — whether it differs by
   * FQID or by same-FQID content — is reported and none is dropped. A pluggable
   * `IdentityConflictPolicy` is a future refinement (provider-boundary draft T27); this
   * fix reuses the existing mechanism rather than introducing a new policy type.
   */
  private async resolveOne(
    providers: ReadonlyArray<SkillProvider>,
    ref: SkillRef,
  ): Promise<{ ok: true; resolved: ResolvedSkill } | { ok: false; error: SkillResponse<never> }> {
    const { candidates, failures } = await this.resolveAll(providers, ref);
    // Provider-output boundary (Req 6.1, 5.4, 5.5): a provider-produced descriptor must
    // carry a valid, CONSISTENT identity AND fall under the producing provider's owned
    // namespace BEFORE it enters FQID-keyed dedupe/resolution. The check is anchored on the
    // ACTUAL producing provider id (`c.providerId` — the child id, Req 5.5), so it cannot be
    // masked by aggregation. An invalid (malformed/partial/oversized/out-of-namespace)
    // descriptor is rejected as a returned error — never admitted, never used as a dedupe
    // key, never thrown.
    for (const c of candidates) {
      const error = this.outputValidator.validateDescriptor(c.providerId, c.descriptor);
      if (error) return { ok: false, error: { ok: false, error } };
    }

    // Conflict-aware dedupe (the EXISTING helper used by list/search): `deduped` keeps one
    // entry per FQID in provider-precedence order; `conflicts` names every FQID under which
    // two descriptors differ in content. Routing resolveOne through this is the structural
    // fix for Req 5.6 (no silent first-match on a same-FQID collision).
    const { deduped, conflicts } = this.dedupeWithConflicts(
      candidates,
      (c) => c.descriptor.fqid,
      (c) => c.descriptor,
    );

    if (deduped.length === 0) {
      // No candidate resolved — attribute the outcome DETERMINISTICALLY from the
      // precedence-ordered `failures` (Req 2.5, 4.8), independent of resolve()
      // completion timing:
      //   • exactly one contributing provider threw → that provider's `provider_error`
      //     (single-provider behavior is byte-for-byte unchanged from the baseline);
      //   • two or more threw → `aggregate_error` preserving EACH failure's code in
      //     provider-precedence order, so no contributing failure is silently lost;
      //   • every contributing provider cleanly returned zero candidates (no throws)
      //     → `not_found`.
      if (failures.length === 1) {
        return { ok: false, error: { ok: false, error: failures[0]!.error } };
      }
      if (failures.length > 1) {
        return { ok: false, error: { ok: false, error: { code: 'aggregate_error', failures } } };
      }
      return { ok: false, error: { ok: false, error: { code: 'not_found', ref } } };
    }

    // Ambiguous when EITHER multiple distinct FQIDs survive (Req 1.4, 2.7) OR a same-FQID
    // content conflict was surfaced (Req 5.6). In both cases report every content-distinct
    // candidate descriptor and select NONE.
    if (deduped.length > 1 || conflicts.length > 0) {
      return {
        ok: false,
        error: {
          ok: false,
          error: { code: 'ambiguous', ref, candidates: this.distinctDescriptors(candidates) },
        },
      };
    }

    // Exactly one FQID with no content conflict: genuine duplicates collapsed to one.
    return { ok: true, resolved: deduped[0] };
  }

  private providerById(providers: ReadonlyArray<SkillProvider>, id: string): SkillProvider | undefined {
    return providers.find((p) => p.id === id);
  }

  // --- core capabilities ------------------------------------------------

  async read(input: ReadSkillInput): Promise<SkillResponse<SkillContent>> {
    // ONE snapshot at entry (Req 10.2); threaded through every helper (Req 10.3).
    return this.readFrom(this.view.providers(), input);
  }

  private async readFrom(
    providers: ReadonlyArray<SkillProvider>,
    input: ReadSkillInput,
  ): Promise<SkillResponse<SkillContent>> {
    const r = await this.resolveOne(providers, input.ref);
    if (!r.ok) return r.error;

    const provider = this.providerById(providers, r.resolved.providerId);
    if (!provider?.read) {
      return { ok: false, error: { code: 'unsupported', capability: 'read', provider: r.resolved.providerId } };
    }
    try {
      // Pre-read content-size boundary (Req 11.5, "shall not load in full"): when the
      // provider declares an oversize via the optional readMetadata probe, reject BEFORE
      // materializing the body. Absent probe → fall through to the post-read backstop.
      const preGuard = await this.enforceContentSizePreRead(provider, r.resolved);
      if (preGuard) return preGuard;
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
    // ONE snapshot at entry (Req 10.2); threaded through the aggregation (Req 10.3).
    return this.listFrom(this.view.providers(), input);
  }

  private async listFrom(
    providers: ReadonlyArray<SkillProvider>,
    input?: ListSkillsInput,
  ): Promise<SkillResponse<SkillDescriptor[]>> {
    // Supporting providers = those that DECLARE `capabilities.list` AND expose a `list`
    // method (Req 3.2: never invoke an operation a provider declares unsupported), after
    // applying the optional `input.provider` scope.
    const supporting = providers
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
          const resolved = await p.list!(input);
          // Provider-output boundary (Req 6.1, 6.2, 5.4, 5.5): a provider that emits a
          // malformed/partial/oversized/out-of-namespace descriptor is recorded as a source
          // error — its items are NOT admitted — preserving partial-failure resilience for
          // the remaining well-formed providers (never thrown). Anchored on the producing
          // provider id `p.id` (the child id), so the namespace check cannot be masked by
          // aggregation.
          const guardError = this.guardDescriptors(p.id, resolved.map((r) => r.descriptor));
          if (guardError) return { provider: p.id, error: guardError };
          return { provider: p.id, resolved };
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
    // ONE snapshot at entry (Req 10.2); threaded through the aggregation (Req 10.3).
    return this.searchFrom(this.view.providers(), input);
  }

  private async searchFrom(
    providers: ReadonlyArray<SkillProvider>,
    input: SearchSkillsInput,
  ): Promise<SkillResponse<SearchResult[]>> {
    // Federated search (Task 15; design §4b — mirrors the `list()` aggregation exactly).
    //
    // Build the ordered set of CONTRIBUTORS in provider-precedence order. Each provider
    // contributes EITHER through its native `search` (when it declares the capability AND
    // exposes the method) OR — for a listable NON-search provider — through the documented
    // list+substring fallback (Req 3.3). A native-search provider is never ALSO
    // list-fallbacked: the fallback exists only for providers that cannot search, so a
    // provider is counted exactly once and never double-serves the same query.
    type Contributor =
      | { kind: 'native'; provider: SkillProvider & Required<Pick<SkillProvider, 'search'>> }
      | { kind: 'fallback'; provider: SkillProvider & Required<Pick<SkillProvider, 'list'>> };

    const contributors: Contributor[] = [];
    for (const p of providers) {
      if (p.capabilities.search && p.search) {
        contributors.push({
          kind: 'native',
          provider: p as SkillProvider & Required<Pick<SkillProvider, 'search'>>,
        });
      } else if (p.capabilities.list && p.list) {
        contributors.push({
          kind: 'fallback',
          provider: p as SkillProvider & Required<Pick<SkillProvider, 'list'>>,
        });
      }
    }

    // Polarity branch 1 — no path can serve the operation at all → `unsupported`
    // (Req 3.4): neither a native-search provider nor a listable fallback provider exists.
    if (contributors.length === 0) {
      return { ok: false, error: { code: 'unsupported', capability: 'search' } };
    }

    const usedFallback = contributors.some((c) => c.kind === 'fallback');
    const q = input.query.toLowerCase();

    // INTERIM fan-out (open-item B): invoke every contributor concurrently with
    // `Promise.all`, exactly as `list()` does, bounded only by registry size. A
    // throwing/failing contributor is RECORDED in `sources`, never propagated as a throw
    // (aggregate totality, Req 2.6 + 4.3). A `FanoutPolicy` injects here later unchanged.
    const outcomes = await Promise.all(
      contributors.map(async (c) => {
        try {
          if (c.kind === 'native') {
            const results = await c.provider.search(input);
            // Provider-output boundary (Req 6.1, 6.2, 5.4, 5.5): native-search results carry
            // provider-produced descriptors; reject a batch with any invalid identity or
            // out-of-namespace FQID as a source error (items not admitted), preserving
            // partial-failure resilience. Anchored on the producing provider's child id.
            const guardError = this.guardDescriptors(c.provider.id, results.map((r) => r.descriptor));
            if (guardError) return { provider: c.provider.id, error: guardError };
            return { provider: c.provider.id, results };
          }
          // Listable non-search provider → serve `search` over THAT provider's own
          // descriptors via list + substring match (Req 3.3, the documented fallback).
          const listed = await c.provider.list();
          // Same provider-output boundary before the fallback admits any descriptor
          // (identity + namespace, anchored on the producing provider's child id).
          const guardError = this.guardDescriptors(c.provider.id, listed.map((r) => r.descriptor));
          if (guardError) return { provider: c.provider.id, error: guardError };
          const results: SearchResult[] = listed
            .filter((r) => r.descriptor.name.toLowerCase().includes(q))
            .map((r) => ({ descriptor: r.descriptor, score: 1 }));
          return { provider: c.provider.id, results };
        } catch (e) {
          const error: SkillRuntimeError = {
            code: 'provider_error',
            provider: c.provider.id,
            message: String(e),
          };
          return { provider: c.provider.id, error };
        }
      }),
    );

    // Per-provider outcomes (Req 4.1, 4.3) + collected results, in providers order.
    const sources: AggregateDiagnostics['sources'] = [];
    const collected: SearchResult[] = [];
    for (const outcome of outcomes) {
      if ('error' in outcome) {
        sources.push({ provider: outcome.provider, ok: false, error: outcome.error });
        continue;
      }
      sources.push({ provider: outcome.provider, ok: true, count: outcome.results.length });
      collected.push(...outcome.results);
    }

    // INTERIM dedupe by exact FQID + conflict surfacing (Req 4.2, 4.4): keep the first
    // occurrence (provider precedence — no silent "best" pick); never silently collapse a
    // same-FQID-differing-content clash. Identical treatment to `list()`.
    const { deduped, conflicts } = this.dedupeWithConflicts(
      collected,
      (r) => r.descriptor.fqid,
      (r) => r.descriptor,
    );
    const data = input.limit !== undefined ? deduped.slice(0, input.limit) : deduped;

    // Polarity branch 4 — every contributing provider failed → `aggregate_error` preserving
    // each provider's returned error code (Req 4.8). `contributors.length >= 1` here, so
    // `sources` is non-empty and `every` is a genuine all-failed test, not vacuous.
    if (sources.every((s) => !s.ok)) {
      const failures = sources.map((s) => ({ provider: s.provider, error: s.error! }));
      return { ok: false, error: { code: 'aggregate_error', failures } };
    }

    // Polarity branches 2 & 3 — at least one contributor succeeded → `ok: true` with the
    // (possibly partial, possibly empty) collection + aggregate diagnostics (Req 4.6, 4.7).
    // When any listable non-search provider participated, the documented fallback was used
    // and is recorded in `fallbacksApplied` (Req 3.3); the provenance `source` then reflects
    // the fallback. A pure native-search aggregation reports `search:native`.
    const diagnostics: AggregateDiagnostics = { sources, conflicts };
    if (usedFallback) {
      diagnostics.fallbacksApplied = ['search:fallback(list+substring)'];
    }
    const provenance = attachAggregateDiagnostics(
      {
        fqid: '*',
        provider: 'runtime',
        source: usedFallback ? 'search:fallback(list+substring)' : 'search:native',
      },
      diagnostics,
    );
    return { ok: true, data, provenance };
  }

  async getReferences(input: GetReferencesInput): Promise<SkillResponse<ReferenceDescriptor[]>> {
    // ONE snapshot at entry (Req 10.2); threaded through every helper (Req 10.3).
    return this.getReferencesFrom(this.view.providers(), input);
  }

  private async getReferencesFrom(
    providers: ReadonlyArray<SkillProvider>,
    input: GetReferencesInput,
  ): Promise<SkillResponse<ReferenceDescriptor[]>> {
    const r = await this.resolveOne(providers, input.ref);
    if (!r.ok) return r.error;
    const provider = this.providerById(providers, r.resolved.providerId);
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
    // ONE snapshot at entry (Req 10.2); threaded through every helper (Req 10.3).
    return this.readReferenceFrom(this.view.providers(), input);
  }

  private async readReferenceFrom(
    providers: ReadonlyArray<SkillProvider>,
    input: ReadReferenceInput,
  ): Promise<SkillResponse<ReferenceContent>> {
    const r = await this.resolveOne(providers, input.ref);
    if (!r.ok) return r.error;
    const provider = this.providerById(providers, r.resolved.providerId);
    if (!provider?.readReference) {
      return {
        ok: false,
        error: { code: 'unsupported', capability: 'references', provider: r.resolved.providerId },
      };
    }
    // Path-traversal boundary (Req 11.4): reject an out-of-bounds reference path BEFORE
    // delegating, so the out-of-bounds location is never read. The root is the PROVIDER's
    // declared resource root (correctly scoped to the resolved skill's references), so the
    // guard catches a cross-skill reference, not only a `..` segment.
    const pathGuard = this.enforceWithinRoot(provider, r.resolved, input.reference);
    if (pathGuard) return pathGuard;
    try {
      // Pre-read content-size boundary (Req 11.5, "shall not load in full"): reject an
      // oversize reference body declared by the optional readMetadata probe BEFORE it is
      // materialized. Absent probe → fall through to the post-read backstop.
      const preGuard = await this.enforceContentSizePreRead(provider, r.resolved, input.reference);
      if (preGuard) return preGuard;
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
    // ONE snapshot at entry (Req 10.2): `request` captures the provider set once and threads
    // it into the dispatched operation's `*From` helper, so a capability routed through
    // `request` observes exactly the same single-snapshot discipline as a direct call and
    // never double-reads the view (Req 10.3).
    const providers = this.view.providers();
    switch (capability.method) {
      case SkillsCapabilities.read.method:
        return this.readFrom(providers, input as ReadSkillInput) as Promise<SkillResponse<TOutput>>;
      case SkillsCapabilities.list.method:
        return this.listFrom(providers, input as ListSkillsInput) as Promise<SkillResponse<TOutput>>;
      case SkillsCapabilities.search.method:
        return this.searchFrom(providers, input as SearchSkillsInput) as Promise<SkillResponse<TOutput>>;
      case SkillsCapabilities.listReferences.method:
        return this.getReferencesFrom(providers, input as GetReferencesInput) as Promise<SkillResponse<TOutput>>;
      case SkillsCapabilities.readReference.method:
        return this.readReferenceFrom(providers, input as ReadReferenceInput) as Promise<SkillResponse<TOutput>>;
      default:
        // EXTENSION dispatch (Task 9.2): `skills.add.v1` is reached in-process through the
        // SAME `request` seam the bus reaches it through the worker dispatch. Delegated to the
        // optional admission handler (normalize → admit → map); when no handler is wired the
        // capability is `unsupported`, exactly as before (backward-compatible).
        if (this.admission && capability.method === AdmissionCapabilities.add.method) {
          return this.admission.handle(input as RawProviderDescriptor) as Promise<
            SkillResponse<TOutput>
          >;
        }
        return { ok: false, error: { code: 'unsupported', capability: capability.method } };
    }
  }
}
