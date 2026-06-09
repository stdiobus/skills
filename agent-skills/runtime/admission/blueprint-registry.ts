/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Provider blueprint registry — `factoryId` → `ProviderBlueprint<TConfig>`
 * (Milestone-002, Task 2.2; design §"Components" 1; Req 3.2, 3.4).
 *
 * Maps a {@link ProviderDescriptor.factoryId} to the typed {@link ProviderBlueprint} that
 * can materialize the provider in-process. The `discover` admission stage (Task 8) resolves
 * a blueprint here; a `factoryId` with no registered blueprint resolves to `undefined`, which
 * `discover` maps to a quarantine outcome (Req 3.4) — this class itself stays a pure lookup
 * and makes no admission decision.
 *
 * ─── NO NEW SINGLETON (design §Conventions) ────────────────────────────────────────
 *
 * The registry is an ordinary instantiated object OWNED BY COMPOSITION — the `createX()`
 * wiring instantiates one and hands it to the {@link AdmissionController}. It is NOT a module
 * singleton, NOT global mutable state, and exposes no static accessor. Multiple independent
 * registries can coexist (e.g. per test, per runtime instance) without interfering.
 *
 * ─── TYPE ERASURE AT THE BOUNDARY ──────────────────────────────────────────────────
 *
 * {@link register} is generic over each blueprint's own `TConfig` (preserving the binding at
 * the call site), but the store erases to `ProviderBlueprint<unknown>`: a heterogeneous
 * registry cannot retain distinct `TConfig`s in one map. Re-binding the concrete `TConfig`
 * happens where the descriptor's `config` is validated — `configSchema.parse(config)` narrows
 * the `unknown` config back to `TConfig` inside the owning blueprint before `create` runs
 * (Req 4.1) — so type safety is restored exactly at the validation boundary, not lost.
 */

import type { ProviderBlueprint } from './provider-blueprint.js';

export class ProviderBlueprintRegistry {
  /**
   * `factoryId` → blueprint. Erased to `ProviderBlueprint<unknown>`: the per-blueprint
   * `TConfig` is re-bound at config-validation time, not stored here.
   */
  private readonly byId = new Map<string, ProviderBlueprint<unknown>>();

  /**
   * Register a blueprint under its own `id` (Req 3.2).
   *
   * Generic over the blueprint's `TConfig` so the binding is checked at the call site; the
   * stored value is erased to `ProviderBlueprint<unknown>`. Re-registering the same `id`
   * replaces the prior blueprint (last-registration-wins, the plain map semantic).
   *
   * @param blueprint - the typed factory; keyed by `blueprint.id`.
   */
  register<TConfig>(blueprint: ProviderBlueprint<TConfig>): void {
    this.byId.set(blueprint.id, blueprint as ProviderBlueprint<unknown>);
  }

  /**
   * Resolve the blueprint registered for a `factoryId` (Req 3.2, 3.4).
   *
   * @param factoryId - the descriptor's `factoryId`.
   * @returns the registered blueprint, or `undefined` when none is registered (the
   *   `discover` stage maps `undefined` to a quarantine; Req 3.4).
   */
  resolve(factoryId: string): ProviderBlueprint<unknown> | undefined {
    return this.byId.get(factoryId);
  }
}
