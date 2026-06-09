/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ordered provider registry (Migration Step 2 — design §4a, §6; Req 1.1, 3.7).
 *
 * The runtime already accepts `ReadonlyArray<SkillProvider>` and recomputes addressable
 * skills per operation by iterating that array (PROVEN: `InProcessSkillsRuntime`). This
 * module names that ordered set a **registry**:
 *
 * - registration order === provider precedence (used by later federation/conflict policy,
 *   open-item C; not consumed here);
 * - {@link SkillRegistry.register} is **open-world**: it appends a participant without any
 *   package rebuild (Req 1.1). It does not rebuild the registry, recompute identity, or
 *   consult the `SkillName` enum — addressable skills are recomputed per operation from the
 *   registered providers by the runtime itself.
 *
 * The registry adds NO resolution logic of its own and requires NO change to the
 * {@link SkillsRuntime} / {@link SkillProvider} contract (Req 3.7).
 *
 * ─── TRUST SEAM — concrete policy type, enforcement owned by Task 9 ────────────────
 *
 * {@link ProviderRegistration.trust} carries the concrete {@link TrustPolicy}
 * (Task 9.1 — design §9, Req 11.1). It stays **optional**: callers that omit it resolve to
 * the least-privileged untrusted default via {@link resolveTrustPolicy} (Req 11.1). This
 * module only stores the policy and offers {@link effectiveTrustPolicy} to read it; the
 * enforcement of path/size/isolation limits is owned by **Task 9.2 / 9.3** and lives in
 * the security boundary, not here.
 */

import { createSkillsRuntime, type TransportConfig } from './transport/factory.js';
import { resolveTrustPolicy, UNTRUSTED_DEFAULT, type TrustPolicy } from './trust.js';
import type { SkillProvider, SkillsRuntime } from './contract.js';

// =============================================================================
// Per-operation provider snapshot — the stable provider VIEW (Migration Step 3,
// Task 4.1; design §"Components" 5, Req 10.1, 10.5, 10.6).
//
// The runtime reads its provider list from a stable {@link ProviderView} and
// captures exactly ONE snapshot at each operation's entry (the threading of that
// snapshot through every helper is Task 4.2 — NOT done here). This file adds only
// the view abstractions:
//
//   - {@link ProviderView}        — the read seam: `providers()` in precedence order.
//   - {@link ConstantProviderView} — the baseline wrapper for the proven array
//                                     constructor. It returns the fixed array EXACTLY
//                                     as given (same reference, same order, same
//                                     identities), so the pre-M-002 single-bundled-
//                                     provider path is byte-for-byte unchanged
//                                     (Req 10.1, design fix 9).
//   - {@link MutableProviderView}  — the admission target: COPY-ON-WRITE `admit`
//                                     (Req 10.5) that is ADD-ONLY — no remove, no
//                                     dispose, no evict (Req 10.6).
// =============================================================================

/**
 * The stable read seam the runtime obtains its provider list from (Req 10.1, 10.2).
 *
 * An operation captures exactly one snapshot via {@link providers} at entry and threads
 * that array through every helper (the threading is Task 4.2). A fixed provider array is a
 * {@link ConstantProviderView} (the proven baseline); an admission-capable registry is a
 * {@link MutableProviderView}.
 */
export interface ProviderView {
  /**
   * The current providers in precedence order (earliest = highest precedence).
   *
   * The returned array is a STABLE snapshot: a {@link MutableProviderView.admit} that runs
   * AFTER this call does not mutate an already-returned array (copy-on-write, Req 10.5), so
   * an in-flight operation that captured an earlier snapshot keeps its own provider set.
   */
  providers(): ReadonlyArray<SkillProvider>;
}

/**
 * Baseline wrapper for the proven array-constructed runtime (Req 10.1, design fix 9).
 *
 * Wrapping an array in a {@link ConstantProviderView} is a pure structural adapter: it
 * introduces NO new ordering, equality, trust-resolution, or federation behavior.
 * {@link providers} returns the fixed array EXACTLY as given (same reference), so provider
 * **order**, provider **identity** (same object references and `id`s), the `trustOf` /
 * provenance lookup keyed off those `id`s, and the exact inputs handed to
 * `dedupeWithConflicts` are all byte-for-byte identical to the pre-M-002 array constructor.
 * This view is NOT mutable — it has no `admit`.
 */
export class ConstantProviderView implements ProviderView {
  /**
   * @param fixed - the immutable provider array in precedence order, returned verbatim.
   */
  constructor(private readonly fixed: ReadonlyArray<SkillProvider>) { }

  /** The fixed providers, returned EXACTLY as given (same reference, order, identities). */
  providers(): ReadonlyArray<SkillProvider> {
    return this.fixed;
  }
}

/**
 * The admission target: a {@link ProviderView} whose set grows by COPY-ON-WRITE (Req 10.5)
 * and is ADD-ONLY (Req 10.6).
 *
 * {@link admit} replaces the internal reference with a freshly-allocated array
 * (`[...current, provider]`) rather than mutating in place. Any array a caller already
 * obtained from {@link providers} is therefore frozen at the moment it was captured: an
 * `admit` interleaved with an in-flight operation cannot change that operation's provider
 * set (per-operation snapshot consistency, design Property 3). There is deliberately NO
 * `remove`, `dispose`, or `evict` method — M-002 is add-only (Req 10.6, 12.4).
 */
export class MutableProviderView implements ProviderView {
  /** The current providers in precedence order; replaced wholesale on each {@link admit}. */
  private current: ReadonlyArray<SkillProvider>;

  /**
   * @param initial - optional seed providers in precedence order (default: empty).
   */
  constructor(initial: ReadonlyArray<SkillProvider> = []) {
    // Copy the seed so a later mutation of the caller's array cannot reach into this view.
    this.current = [...initial];
  }

  /** The current providers snapshot in precedence order. */
  providers(): ReadonlyArray<SkillProvider> {
    return this.current;
  }

  /**
   * Add a provider to the END of the precedence order, COPY-ON-WRITE (Req 10.5).
   *
   * Allocates a new array and swaps the reference; any previously-returned snapshot is
   * untouched. Add-only: there is no inverse operation in M-002 (Req 10.6).
   *
   * @param provider - the newly-admitted provider to append (lowest precedence).
   */
  admit(provider: SkillProvider): void {
    this.current = [...this.current, provider];
  }
}

/**
 * A provider together with its (optional) trust policy.
 *
 * `trust` is omitted by all current callers and stays optional for backward compatibility;
 * an absent policy resolves to the untrusted default (Req 11.1). The bundled provider may
 * attach a `trusted` policy (see `bundledTrustPolicy` in {@link ./trust.js}).
 */
export interface ProviderRegistration {
  /** The participating provider (existing contract type — not redefined). */
  provider: SkillProvider;
  /**
   * Concrete trust policy (Task 9.1). Optional — absent resolves to the least-privileged
   * untrusted default via {@link resolveTrustPolicy} (Req 11.1). Enforcement of the policy's
   * limits is owned by Task 9.2 / 9.3.
   */
  trust?: TrustPolicy;
}

/**
 * An ordered registry of provider registrations. Registration order is precedence.
 */
export interface SkillRegistry {
  /** Registrations in precedence order (earliest registered = highest precedence). */
  readonly registrations: ReadonlyArray<ProviderRegistration>;
  /** Append a registration. Open-world; no rebuild, no recompute, no enum gate (Req 1.1). */
  register(reg: ProviderRegistration): void;
  /** The registered providers in precedence order — what feeds {@link createSkillsRuntime}. */
  providers(): ReadonlyArray<SkillProvider>;
}

/**
 * Default {@link SkillRegistry}: an insertion-ordered list of registrations.
 *
 * Insertion order is preserved as precedence. `register` simply appends, so adding a new
 * skill source is an open-world runtime operation — no package rebuild (Req 1.1). The
 * runtime recomputes addressable skills per operation from {@link providers}, so the
 * registry holds NO resolution logic and never consults the `SkillName` enum.
 */
export class SkillProviderRegistry implements SkillRegistry {
  /** Backing store, ordered by registration (precedence). */
  private readonly _registrations: ProviderRegistration[] = [];

  /**
   * @param initial - optional seed registrations applied in order (precedence preserved).
   */
  constructor(initial: ReadonlyArray<ProviderRegistration> = []) {
    for (const reg of initial) this.register(reg);
  }

  /** A defensive snapshot of registrations in precedence order. */
  get registrations(): ReadonlyArray<ProviderRegistration> {
    return [...this._registrations];
  }

  /**
   * Append a registration in precedence order.
   *
   * Open-world and rebuild-free: no identity is recomputed, no enum is consulted, and the
   * existing registrations are untouched (Req 1.1). The optional `trust` policy is stored
   * verbatim and is NOT enforced here — its limits are enforced by Task 9.2 / 9.3.
   */
  register(reg: ProviderRegistration): void {
    this._registrations.push(reg);
  }

  /**
   * The registered providers, in precedence order — the value passed to
   * {@link createSkillsRuntime}. Returns a fresh snapshot so callers cannot mutate the
   * registry through the returned array.
   */
  providers(): ReadonlyArray<SkillProvider> {
    return this._registrations.map((reg) => reg.provider);
  }
}

/**
 * Resolve a registration's effective {@link TrustPolicy} (design §9, Req 11.1).
 *
 * A registration that omits `trust` resolves to the least-privileged untrusted default;
 * a supplied policy is returned as-is. This is a read-only convenience over
 * {@link resolveTrustPolicy} — it applies NO enforcement (owned by Task 9.2 / 9.3).
 *
 * @param reg - the provider registration to inspect.
 * @returns the effective trust policy (never `undefined`).
 */
export function effectiveTrustPolicy(reg: ProviderRegistration): TrustPolicy {
  return resolveTrustPolicy(reg.trust);
}

/**
 * Wire a {@link SkillRegistry} to the transport factory (design §3a, §4a).
 *
 * This is the documented registry → factory seam. It keeps the proven
 * {@link createSkillsRuntime} signature untouched (it still takes a plain provider array)
 * and call sites transport-blind: callers hold a registry and a {@link TransportConfig},
 * never branch on transport. Equivalent to `createSkillsRuntime(cfg, registry.providers())`.
 *
 * The runtime is built over the registry's providers as of this call. Because `register`
 * is open-world (no package rebuild), new sources can be added to the registry and a fresh
 * runtime obtained without recompiling the package (Req 1.1).
 *
 * @param cfg - transport selection (in-process default; stdio-bus reserved for Task 7).
 * @param registry - the ordered provider registry to feed the runtime.
 * @returns a {@link SkillsRuntime} over the registry's providers in precedence order.
 */
export function createRuntimeFromRegistry(
  cfg: TransportConfig,
  registry: SkillRegistry,
): SkillsRuntime {
  // Security boundary wiring (Task 9.2; design §9, Req 11.1/11.4/11.5): index each
  // registration's EFFECTIVE trust policy by provider id (absent `trust` → least-privileged
  // untrusted default via `effectiveTrustPolicy`), then hand the runtime a lookup so it can
  // enforce `permittedRoot` / `maxContentBytes` at the read boundary. Unknown ids resolve to
  // the untrusted default — a provider is never silently treated as more privileged than
  // declared.
  const policyById = new Map<string, TrustPolicy>();
  for (const reg of registry.registrations) {
    policyById.set(reg.provider.id, effectiveTrustPolicy(reg));
  }
  const trustOf = (providerId: string): TrustPolicy => policyById.get(providerId) ?? UNTRUSTED_DEFAULT;

  return createSkillsRuntime(cfg, registry.providers(), trustOf);
}
