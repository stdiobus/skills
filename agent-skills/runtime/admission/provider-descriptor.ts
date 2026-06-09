/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Provider placement record — descriptor shapes + decode-time normalization
 * (Milestone-002, Task 2.1; design §"Components" 1 / companion fix 1).
 *
 * A live `SkillProvider` never crosses a transport boundary; a serializable
 * {@link ProviderDescriptor} does, and the blueprint registry rebuilds the provider
 * in-process (Req 3.1). This module defines the two descriptor shapes and the single
 * pure transform between them:
 *
 *   - {@link RawProviderDescriptor} — the WIRE shape accepted by `skills.add.v1`. `trust`
 *     and `capabilityVersions` MAY be omitted (Req 1.2).
 *   - {@link ProviderDescriptor} — the NORMALIZED shape the `AdmissionController` operates
 *     on. `trust` and `capabilityVersions` are REQUIRED.
 *   - {@link normalizeDescriptor} — the pure free function that applies the decode-time
 *     defaults ONCE at the single decode boundary (the ParamCodec for the bus, the request
 *     handler in-process), so admission never sees a maybe-trust descriptor.
 *
 * ─── DEFAULTS (applied exactly once, at the boundary) ──────────────────────────────
 *
 *   - `trust` omitted → {@link UNTRUSTED_DEFAULT}: the least-privileged untrusted tier
 *     (Req 1.2, 8.4). External content is never promoted out of untrusted on the basis of
 *     anything it returns.
 *   - `capabilityVersions` omitted → `{}`: an explicit recorded default; M-002 scope is
 *     capability-version DECLARATION only, no negotiation (Req 13.1, 13.3).
 *
 * ─── AUTHORITY ─────────────────────────────────────────────────────────────────────
 *
 * The descriptor and its `config` grant NO authority by themselves (Req 3.6). Authority to
 * acquire or register is earned only after per-factory config validation, namespace-
 * ownership validation, bounded acquisition, and content-as-data all succeed downstream.
 * Normalization is a pure value transform; it performs no validation and no I/O.
 */

import type { TrustPolicy } from '../trust.js';
import { UNTRUSTED_DEFAULT } from '../trust.js';

/**
 * Wire shape accepted by `skills.add.v1` (Req 1.2, 3.1).
 *
 * Carries the fields needed to admit an external source. `trust` and `capabilityVersions`
 * are OPTIONAL on the wire: a client may omit them and the decode boundary supplies the
 * least-privileged defaults via {@link normalizeDescriptor}.
 */
export interface RawProviderDescriptor {
  /** Selects the blueprint in the `ProviderBlueprintRegistry` (Req 3.2). */
  readonly factoryId: string;
  /** Opaque until the blueprint's `configSchema` validates it (Req 4). */
  readonly config: unknown;
  /** The FQID-prefix the provider may mint; bound at admission (Req 5). */
  readonly namespace: string;
  /** Omitted → the untrusted default applied at decode time (Req 1.2, 8.4). */
  readonly trust?: TrustPolicy;
  /** Omitted → `{}` recorded explicitly; declaration only (Req 13.1, 13.3). */
  readonly capabilityVersions?: Record<string, string>;
}

/**
 * Normalized shape the `AdmissionController` operates on (Req 1.2, 8.4, 13.1).
 *
 * `trust` and `capabilityVersions` are REQUIRED: the decode-time normalizer applies the
 * defaults ONCE at the boundary, so admission never sees a maybe-trust descriptor (design
 * §"Components" 1 / companion fix 1).
 */
export interface ProviderDescriptor {
  readonly factoryId: string;
  readonly config: unknown;
  readonly namespace: string;
  /** REQUIRED post-normalization — least-privilege untrusted default when absent on wire. */
  readonly trust: TrustPolicy;
  /** REQUIRED post-normalization — explicit `{}` when absent on wire (declaration only). */
  readonly capabilityVersions: Record<string, string>;
}

/**
 * Apply the decode-time defaults to a raw wire descriptor, exactly once, at the single
 * decode boundary (Req 1.2, 8.4, 13.1).
 *
 * Pure value transform (architecture standard §5): no validation, no I/O, no mutation of
 * the input. A present `trust` / `capabilityVersions` passes through unchanged; an omitted
 * one is filled with the documented least-privilege default.
 *
 * @param raw - the wire descriptor decoded from `skills.add.v1` input.
 * @returns a fully-defined {@link ProviderDescriptor} the admission pipeline can rely on.
 */
export function normalizeDescriptor(raw: RawProviderDescriptor): ProviderDescriptor {
  return {
    factoryId: raw.factoryId,
    config: raw.config,
    namespace: raw.namespace,
    // trust omitted → least-privileged untrusted tier (Req 1.2, 8.4).
    trust: raw.trust ?? UNTRUSTED_DEFAULT,
    // capabilityVersions omitted → explicit recorded default (Req 13.1).
    capabilityVersions: raw.capabilityVersions ?? {},
  };
}
