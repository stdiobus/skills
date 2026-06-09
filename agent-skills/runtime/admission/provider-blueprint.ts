/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The one sanctioned Abstract Factory boundary — `ProviderBlueprint<TConfig>`
 * (Milestone-002, Task 2.2; design §"Components" 1; architecture standard §7; Req 3.2).
 *
 * A live {@link SkillProvider} never crosses a transport boundary; a serializable
 * {@link ProviderDescriptor} does, and a {@link ProviderBlueprint} rebuilds the provider
 * IN-PROCESS from that descriptor's validated `config` (Req 3.1, 3.3). The blueprint is the
 * single place where a `factoryId` maps to a concrete provider construction — the architecture
 * standard's one permitted Abstract Factory (everything else is OOP-first / pure functions).
 *
 * ─── THE BINDING GENERIC (`TConfig`, §6) ───────────────────────────────────────────
 *
 * `TConfig` binds three things into one type so they cannot diverge:
 *   1. {@link ProviderBlueprint.configSchema} — the validator whose output IS `TConfig`,
 *   2. {@link ProviderBlueprint.create}'s `config` parameter — the validated `TConfig`,
 *   3. the provider that `create` constructs from that `TConfig`.
 * A factory therefore cannot construct a provider from a config its own schema never
 * validated: the only way to obtain a `TConfig` is a successful `configSchema.parse`.
 *
 * ─── AUTHORITY IS EARNED, NOT GRANTED ──────────────────────────────────────────────
 *
 * Holding a blueprint confers no authority (Req 3.6). The admission pipeline (Task 8) calls
 * `create` only AFTER `configSchema.parse` succeeds; the constructed provider is a PRIVATE
 * admission candidate — not registered, not transport-reachable — until namespace ownership
 * and registration both succeed downstream. Construction performs no I/O and no registry
 * mutation.
 */

import type { SkillProvider } from '../contract.js';
import type { TrustPolicy } from '../trust.js';
import type { Schema } from './schema.js';

/**
 * Auth-reuse adapter — CONSUMED by a provider, never implemented in M-002 (Req 7.3, 7.4).
 *
 * Maps an ALREADY-AUTHORIZED `@stdiobus/workers-registry` result into the request headers a
 * provider attaches to its HTTPS fetch. M-002 implements NO OAuth, NO token storage, NO
 * refresh, NO credential lifecycle of its own (design §"Components" 4 / companion fix 3).
 *
 * The interface lives in the admission layer (not the providers layer) so the
 * {@link ProviderCreationContext} can reference it without `admission` depending on
 * `providers` — the dependency runs providers → admission, never the reverse. Task 7.2
 * supplies the concrete adapters (the no-credential default for public origins, and the
 * workers-registry binding plugged in over the bus where authentication is required) by
 * implementing THIS interface.
 */
export interface CredentialHeadersProvider {
  /**
   * Resolve request headers for an already-authorized request.
   *
   * @param url - the target URL the provider is about to fetch.
   * @returns headers to attach, or `{}`/absent `headers` for a public (no-credential) origin.
   *   M-002's default adapter returns no headers; it performs no authorization itself.
   */
  authorize(url: string): Promise<{ headers?: Record<string, string> }>;
}

/**
 * The execution context handed to {@link ProviderBlueprint.create} (design §"Components" 1).
 *
 * Carries the admission-resolved environment a provider needs to construct itself:
 *   - `namespace` — the FQID-prefix the provider may mint; the provider derives its `id`
 *     from this so descriptor namespace and live identity cannot diverge (Req 3.5, 5.1).
 *   - `trust` — the normalized {@link TrustPolicy} from the descriptor (untrusted default
 *     when omitted on the wire); the provider's content stays untrusted-as-data (Req 8.4).
 *   - `credentials` — the {@link CredentialHeadersProvider} auth-reuse adapter (Req 7.3).
 */
export interface ProviderCreationContext {
  /** FQID-prefix the provider may mint; source of the provider's derived `id` (Req 3.5). */
  readonly namespace: string;
  /** Normalized trust policy from the descriptor (least-privilege default) (Req 8.4). */
  readonly trust: TrustPolicy;
  /** Auth-reuse header adapter — consumed, never implemented here (Req 7.3). */
  readonly credentials: CredentialHeadersProvider;
}

/**
 * A typed provider factory keyed by {@link ProviderBlueprint.id} (Req 3.2).
 *
 * `id` MUST equal the {@link ProviderDescriptor.factoryId} that selects this blueprint in the
 * {@link ProviderBlueprintRegistry}. `configSchema` is where per-factory config validation
 * lives (Req 4); `create` constructs the in-process provider from the validated `TConfig` and
 * the admission-resolved {@link ProviderCreationContext}.
 *
 * @typeParam TConfig - the validated config type that binds schema, `create` input, and the
 *   constructed provider together (§6).
 */
export interface ProviderBlueprint<TConfig> {
  /** Factory id; selects this blueprint by `factoryId` (=== {@link ProviderDescriptor.factoryId}). */
  readonly id: string;
  /** Per-factory config validation (Req 4); its parsed output IS `TConfig`. */
  readonly configSchema: Schema<TConfig>;
  /**
   * Construct the in-process provider from a VALIDATED config (Req 3.2).
   *
   * Called by the admission pipeline only after {@link configSchema}`.parse` succeeds. The
   * result is a private admission candidate until registration; construction mutates no
   * registry and performs no I/O.
   *
   * @param config - the validated `TConfig` (never the raw wire `config`).
   * @param ctx - the admission-resolved creation context.
   * @returns a live {@link SkillProvider} (not yet registered or transport-reachable).
   */
  create(config: TConfig, ctx: ProviderCreationContext): SkillProvider;
}
