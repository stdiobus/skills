/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-factory config validator seam — `Schema<TConfig>`
 * (Milestone-002, Task 2.2; design §"Components" 1; Req 3.2, 4).
 *
 * A {@link Schema} is the authority boundary for a provider factory's `config`: it parses an
 * untrusted, opaque `unknown` (the wire `config` of a {@link RawProviderDescriptor}) into a
 * fully-typed `TConfig`, or returns the list of issues that made it invalid. The generic
 * `TConfig` is the binding type parameter (architecture standard §6): the SAME `TConfig`
 * names a blueprint's `configSchema` output, its `create(config, ...)` input, and the
 * provider it constructs — so a factory cannot build a provider from a config its own schema
 * never validated.
 *
 * ─── RETURNED, NEVER THROWN ────────────────────────────────────────────────────────
 *
 * {@link Schema.parse} mirrors the runtime's returned-error discipline: a validation failure
 * is the data-carrying `{ ok: false; issues }` branch, never a thrown exception. The
 * `validate` admission stage (Task 8) maps `{ ok: false }` to a typed `bad_request`
 * quarantine naming the failing field(s) (Req 4.3) without a try/catch around the schema.
 *
 * ─── AUTHORITY ─────────────────────────────────────────────────────────────────────
 *
 * ParamCodec transport-shape validation alone is NOT sufficient authority (Req 4.1): the
 * descriptor and its `config` grant no authority by themselves (Req 3.6). Only a successful
 * `configSchema.parse` — alongside namespace ownership and bounded acquisition downstream —
 * earns the authority to construct and register a provider.
 *
 * This module declares the seam only; concrete schemas (e.g. the HTTPS-only
 * `httpProviderConfigSchema`) are implemented by their factories in Task 7.1.
 */

/**
 * Result of parsing an untrusted `config` against a factory's schema.
 *
 * - `{ ok: true; value }` — `input` is a valid `TConfig`; `value` is the typed config.
 * - `{ ok: false; issues }` — `input` is invalid; `issues` names what failed (e.g. a missing
 *   bound, an unknown key, a non-HTTPS URL), suitable for a `bad_request` quarantine.
 */
export type SchemaResult<TConfig> =
  | { ok: true; value: TConfig }
  | { ok: false; issues: string[] };

/**
 * A validator whose parsed output type IS `TConfig` (the binding generic, §6).
 *
 * Total and pure: `parse` returns a {@link SchemaResult} for any input and never throws —
 * a malformed config is the `{ ok: false }` branch, not an exception. Implementations MUST
 * reject unknown/unexpected keys unless explicitly allowed (Req 4.2).
 */
export interface Schema<TConfig> {
  /**
   * Validate and narrow an opaque input to `TConfig`.
   *
   * @param input - the untrusted, opaque `config` from the wire descriptor.
   * @returns `{ ok: true; value }` with the typed config, or `{ ok: false; issues }` naming
   *   the validation failures. Never throws.
   */
  parse(input: unknown): SchemaResult<TConfig>;
}
