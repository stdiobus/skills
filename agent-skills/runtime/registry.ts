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
