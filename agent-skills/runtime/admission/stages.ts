/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Admission pipeline stage classes — `discover → validate → acquire → hash-record →
 * admit → register` (Milestone-002, Task 8.1; design §"Components" 2; Req 2.2, 2.3, 2.4,
 * 4.1, 5.3, 8.1, 8.3).
 *
 * Each stage is a first-class actor (architecture standard §9) implementing the binding
 * generic {@link AdmissionStage} seam: it consumes a typed input context and returns an
 * observable typed {@link StageResult} — **no silent placeholder** (Req 2.2). The
 * {@link AdmissionController} (Task 8.2) composes these in the fixed order, threading each
 * stage's output into the next stage's input, and runs every stage under the per-operation
 * budget `signal`. The FIRST failing stage short-circuits to a quarantine outcome naming
 * that stage (Req 2.3); a stage that throws unexpectedly is caught by the controller and
 * mapped to a `provider_error` quarantine (admission is total — Req 2.4).
 *
 * ─── ACCUMULATING CONTEXT (binding generics, §6) ───────────────────────────────────
 *
 * The stage I/O types form a chain where each result EXTENDS the previous one
 * ({@link DiscoverResult} ⊂ {@link ValidateResult} ⊂ {@link AcquireResult} ⊂
 * {@link HashRecordResult} ⊂ {@link AdmitResult}). The controller therefore cannot wire the
 * stages out of order without a type error — the pipeline shape is enforced by the compiler.
 * The final `register` stage produces the public {@link AdmittedProvider}.
 *
 * ─── AUTHORITY IS EARNED, NOT GRANTED (Req 3.6; Property 5) ─────────────────────────
 *
 * The provider is CONSTRUCTED in `validate` (after `configSchema.parse` succeeds) and stays
 * a PRIVATE admission candidate — not registered, not transport-reachable — until `admit`
 * (content-as-data validation + namespace verification + `namespaces.claim`) AND `register`
 * (copy-on-write add) both succeed. A quarantine at any earlier stage discards the candidate
 * with the registry view unchanged (Req 9.3).
 *
 * ─── DEPENDENCY DIRECTION: admission NEVER imports providers ────────────────────────
 *
 * `acquire` must surface a provider's typed acquisition error (e.g. `content_too_large`)
 * WITHOUT importing the concrete provider class (the dependency runs providers → admission,
 * never the reverse). It therefore detects a provider's typed error STRUCTURALLY via
 * {@link isTypedProviderError} — a provider throws an error carrying a `runtimeError` — so
 * the authoritative typed code is preserved without a reverse dependency.
 */

import type {
  ResolvedSkill,
  SkillContent,
  SkillDescriptor,
  SkillProvider,
  SkillRuntimeError,
} from '../contract.js';
import { guardDescriptorIdentity, parseFqid } from '../fqid.js';
import type { MutableProviderView } from '../registry.js';
import type { ProviderBlueprintRegistry } from './blueprint-registry.js';
import type { ContentHasher } from './content-hasher.js';
import { noCredentialHeaders } from './credential-headers.js';
import type { NamespaceOwnershipTable } from './namespace-ownership.js';
import type {
  CredentialHeadersProvider,
  ProviderCreationContext,
} from './provider-blueprint.js';
import type { ProviderBlueprint } from './provider-blueprint.js';
import type { ProviderDescriptor } from './provider-descriptor.js';
import type { AdmittedProvider } from './outcome.js';
import type { AdmissionStage, StageResult } from './stage.js';

// =============================================================================
// Accumulating stage I/O context types (each result extends the previous one).
// =============================================================================

/** The pipeline's seed input: the normalized descriptor under admission. */
export interface DiscoverInput {
  readonly descriptor: ProviderDescriptor;
}

/** `discover` output: the resolved blueprint + the creation context for `create`. */
export interface DiscoverResult extends DiscoverInput {
  /** The blueprint resolved by `descriptor.factoryId`. */
  readonly blueprint: ProviderBlueprint<unknown>;
  /** The admission-resolved context handed to `blueprint.create` (trust + credentials). */
  readonly creationContext: ProviderCreationContext;
}

/** `validate` output: the validated config + the PRIVATE constructed provider candidate. */
export interface ValidateResult extends DiscoverResult {
  /**
   * The validated config (the blueprint's `TConfig`). Erased to `unknown` at this
   * heterogeneous boundary — it was re-bound to `TConfig` inside `configSchema.parse`.
   */
  readonly config: unknown;
  /** The constructed provider — a private admission candidate, NOT yet registered. */
  readonly provider: SkillProvider;
}

/** `acquire` output: the bytes fetched over bounded HTTPS. */
export interface AcquireResult extends ValidateResult {
  /** The acquired skill content (descriptor + body) — untrusted, treated as data. */
  readonly content: SkillContent;
}

/** `hash-record` output: the record-only content hash (Req 8.2). */
export interface HashRecordResult extends AcquireResult {
  /** SHA-256 (interim) over the acquired bytes — record-only provenance. */
  readonly contentHash: string;
}

/** `admit` output: the validated-as-data, namespace-verified, claimed descriptor. */
export interface AdmitResult extends HashRecordResult {
  /** The acquired descriptor, validated as data and verified to fall under the namespace. */
  readonly admittedDescriptor: SkillDescriptor;
}

// =============================================================================
// Structural typed-error detection (no reverse dependency on providers).
// =============================================================================

/** A thrown error carrying an authoritative {@link SkillRuntimeError} (e.g. a provider's). */
interface CarriesRuntimeError {
  readonly runtimeError: SkillRuntimeError;
}

/**
 * Structurally detect a thrown error that carries a typed {@link SkillRuntimeError}.
 *
 * A provider (e.g. the HTTP provider) throws an error with a `runtimeError` field so the
 * `acquire` stage can surface the precise typed code (`content_too_large`, `provider_error`)
 * WITHOUT importing the provider class — the dependency direction stays providers → admission.
 */
function isTypedProviderError(err: unknown): err is CarriesRuntimeError {
  if (typeof err !== 'object' || err === null || !('runtimeError' in err)) return false;
  const candidate = (err as { runtimeError?: unknown }).runtimeError;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof (candidate as { code?: unknown }).code === 'string'
  );
}

/** Normalize any caught value into a typed `provider_error` for `providerId`. */
function toProviderError(providerId: string, err: unknown): SkillRuntimeError {
  if (isTypedProviderError(err)) return err.runtimeError;
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'provider_error', provider: providerId, message };
}

/**
 * A provider whose `read` accepts the OPTIONAL budget signal as an additive argument
 * (e.g. the HTTP provider). The contract {@link SkillProvider.read} is declared with a single
 * parameter; threading the signal is an additive seam, so the `acquire` stage narrows to this
 * shape to pass the budget signal without widening the contract or losing the `this` receiver.
 */
interface SignalAwareRead {
  read(resolved: ResolvedSkill, signal?: AbortSignal): Promise<SkillContent>;
}

// =============================================================================
// Stage 1: discover — resolve the blueprint and build the creation context.
// =============================================================================

/**
 * `discover` (Req 3.4): resolve the blueprint named by `descriptor.factoryId` and build the
 * admission-resolved {@link ProviderCreationContext}. An unknown `factoryId` yields a
 * `bad_request` the controller maps to `quarantine{ stage: 'discover' }`.
 */
export class DiscoverStage implements AdmissionStage<DiscoverInput, DiscoverResult> {
  readonly name = 'discover' as const;

  /**
   * @param blueprints - the registry resolving `factoryId` → blueprint (pure lookup).
   * @param credentials - the auth-reuse header adapter for the creation context
   *   (default: the no-credential adapter for public origins; Req 7.3).
   */
  constructor(
    private readonly blueprints: ProviderBlueprintRegistry,
    private readonly credentials: CredentialHeadersProvider = noCredentialHeaders,
  ) { }

  async run(ctx: DiscoverInput, _signal: AbortSignal): Promise<StageResult<DiscoverResult>> {
    const blueprint = this.blueprints.resolve(ctx.descriptor.factoryId);
    if (blueprint === undefined) {
      return {
        ok: false,
        error: {
          code: 'bad_request',
          issues: [`no provider blueprint registered for factoryId '${ctx.descriptor.factoryId}'`],
        },
      };
    }

    // Build the creation context from the normalized descriptor (trust already defaulted at
    // decode time) plus the injected credentials adapter (Req 7.3, 8.4).
    const creationContext: ProviderCreationContext = {
      namespace: ctx.descriptor.namespace,
      trust: ctx.descriptor.trust,
      credentials: this.credentials,
    };
    return { ok: true, value: { ...ctx, blueprint, creationContext } };
  }
}

// =============================================================================
// Stage 2: validate — per-factory config validation + (build) the candidate.
// =============================================================================

/**
 * `validate` (Req 4.1, 4.3): run the blueprint's `configSchema.parse` over the descriptor's
 * opaque `config`; a failure is a `bad_request` naming the issues. On success it then
 * CONSTRUCTS the provider (the `(build)` sub-step, design §"Data Flow") — a private admission
 * candidate that is not registered and not transport-reachable. A construction throw is
 * surfaced as a typed `provider_error` so the stage stays total.
 */
export class ValidateStage implements AdmissionStage<DiscoverResult, ValidateResult> {
  readonly name = 'validate' as const;

  async run(ctx: DiscoverResult, _signal: AbortSignal): Promise<StageResult<ValidateResult>> {
    const parsed = ctx.blueprint.configSchema.parse(ctx.descriptor.config);
    if (!parsed.ok) {
      return { ok: false, error: { code: 'bad_request', issues: parsed.issues } };
    }

    // (build) — construct the private admission candidate from the VALIDATED config only.
    try {
      const provider = ctx.blueprint.create(parsed.value, ctx.creationContext);
      return { ok: true, value: { ...ctx, config: parsed.value, provider } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: { code: 'provider_error', provider: ctx.descriptor.namespace, message },
      };
    }
  }
}

// =============================================================================
// Stage 3: acquire — bounded HTTPS fetch under the budget signal.
// =============================================================================

/**
 * `acquire` (Req 7, 8.1): fetch the candidate provider's content over bounded HTTPS under
 * the budget `signal`. An over-limit body surfaces as `content_too_large`; an unavailable
 * origin / abort / any other fault surfaces as `provider_error` — both via the provider's
 * own typed error, detected structurally so admission keeps no reverse dependency.
 */
export class AcquireStage implements AdmissionStage<ValidateResult, AcquireResult> {
  readonly name = 'acquire' as const;

  async run(ctx: ValidateResult, signal: AbortSignal): Promise<StageResult<AcquireResult>> {
    const provider = ctx.provider;
    if (typeof provider.list !== 'function' || typeof provider.read !== 'function') {
      return {
        ok: false,
        error: {
          code: 'provider_error',
          provider: provider.id,
          message: 'provider cannot acquire content (list/read unsupported)',
        },
      };
    }

    let resolvedSkills: ResolvedSkill[];
    try {
      resolvedSkills = await provider.list();
    } catch (err) {
      return { ok: false, error: toProviderError(provider.id, err) };
    }
    if (resolvedSkills.length === 0) {
      return {
        ok: false,
        error: {
          code: 'provider_error',
          provider: provider.id,
          message: 'provider returned no skills to acquire',
        },
      };
    }

    try {
      // Pass the budget signal so the fetch honors the deadline + external cancellation.
      // The contract `read` is single-arg; the signal is an additive seam (narrowed here).
      const content = await (provider as unknown as SignalAwareRead).read(resolvedSkills[0], signal);
      return { ok: true, value: { ...ctx, content } };
    } catch (err) {
      // Preserve the provider's authoritative typed code (e.g. content_too_large).
      return { ok: false, error: toProviderError(provider.id, err) };
    }
  }
}

// =============================================================================
// Stage 4: hash-record — record-only content hash (Req 8.2).
// =============================================================================

/**
 * `hash-record` (Req 8.2): compute the record-only hash over the acquired body. The hash is
 * provenance only — it never participates in equality, dedupe, or conflict detection.
 */
export class HashRecordStage implements AdmissionStage<AcquireResult, HashRecordResult> {
  readonly name = 'hash-record' as const;

  constructor(private readonly hasher: ContentHasher) { }

  async run(ctx: AcquireResult, _signal: AbortSignal): Promise<StageResult<HashRecordResult>> {
    const contentHash = this.hasher.hash(ctx.content.body);
    return { ok: true, value: { ...ctx, contentHash } };
  }
}

// =============================================================================
// Stage 5: admit — content-as-data validation → namespace verify → claim.
// =============================================================================

/**
 * `admit` (Req 5.3, 8.3): validate the acquired output **as data** (the descriptor identity
 * guard — content is never executed), verify the acquired descriptor's FQID falls under the
 * descriptor's `namespace`, then `namespaces.claim(namespace, provider.id)`. Any rejection
 * is a `bad_request` the controller maps to `quarantine{ stage: 'admit' }`. The FQID check
 * runs BEFORE the claim, so a rejected descriptor leaves the ownership table untouched.
 */
export class AdmitStage implements AdmissionStage<HashRecordResult, AdmitResult> {
  readonly name = 'admit' as const;

  constructor(private readonly namespaces: NamespaceOwnershipTable) { }

  async run(ctx: HashRecordResult, _signal: AbortSignal): Promise<StageResult<AdmitResult>> {
    const descriptor = ctx.content.descriptor;
    const namespace = ctx.descriptor.namespace;

    // 1. Validate the acquired output AS DATA — identity guard, never executes content (Req 8.3).
    const identityError = guardDescriptorIdentity(descriptor);
    if (identityError !== null) {
      return { ok: false, error: identityError };
    }

    // 2. Verify the acquired descriptor's FQID falls under the claimed namespace (Req 5.4).
    const parts = parseFqid(descriptor.fqid);
    if (parts === null || parts.provider !== namespace) {
      return {
        ok: false,
        error: {
          code: 'bad_request',
          issues: [
            `acquired fqid '${descriptor.fqid}' is not under the provider's namespace '${namespace}'`,
          ],
        },
      };
    }

    // 3. Claim the namespace (rejects reserved / already-owned; Req 5.3) — side effect last.
    const claim = this.namespaces.claim(namespace, ctx.provider.id);
    if (!claim.ok) {
      return claim;
    }

    return { ok: true, value: { ...ctx, admittedDescriptor: descriptor } };
  }
}

// =============================================================================
// Stage 6: register — copy-on-write add, only after the claim succeeds.
// =============================================================================

/**
 * `register` (Req 10.5): copy-on-write add the now-claimed provider to the mutable view, so
 * the NEXT operation's snapshot includes it. Runs only after `admit`'s namespace claim
 * succeeded; produces the public {@link AdmittedProvider} (identity + record-only hash).
 */
export class RegisterStage implements AdmissionStage<AdmitResult, AdmittedProvider> {
  readonly name = 'register' as const;

  constructor(private readonly view: MutableProviderView) { }

  async run(ctx: AdmitResult, _signal: AbortSignal): Promise<StageResult<AdmittedProvider>> {
    // Copy-on-write add (add-only; Req 10.5, 10.6). An in-flight operation keeps its snapshot.
    this.view.admit(ctx.provider);
    return {
      ok: true,
      value: { descriptor: ctx.admittedDescriptor, contentHash: ctx.contentHash },
    };
  }
}
