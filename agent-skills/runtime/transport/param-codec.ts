/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ParamCodec — the single schema-validation boundary point (Requirement 10; design §3c).
 *
 * This module is the ONE place where a typed capability input crosses the stdio Bus wire
 * and where schema validation happens, so that no provider ever receives unvalidated
 * input (Req 10.3). It is a transport-boundary component only: in-process the inputs are
 * already typed by the compiler and bypass the codec entirely (Req 6.2 forbids in-process
 * serialization), while over the bus the worker runs {@link ParamCodec.decode} at ingress
 * BEFORE dispatch invokes the runtime (the validation placement is wired in Task 7.2).
 *
 * Responsibilities:
 * - {@link ParamCodec.encode}: typed capability input → JSON-serializable params object
 *   (Req 10.1), normalizing explicit-`undefined` optionals to ABSENT (codec policy, Req 10.6).
 * - {@link ParamCodec.decode}: received params → validated typed input, or a RETURNED
 *   error (never thrown). Non-object params → `bad_request` (Req 10.5); unknown method →
 *   `unsupported` (design §3c); schema failure → `bad_request` naming the failing field(s)
 *   (Req 10.4). On any failure no provider is invoked and runtime state is unchanged.
 * - {@link ParamCodec.decodeResponse}: wire `SkillResponse` → typed `SkillResponse`,
 *   STRUCTURALLY VALIDATED at the untrusted-worker trust boundary (Req 6.3, 2.6; design
 *   §3c "Error Handling"). The response crossing the bus comes from an out-of-process /
 *   potentially remote worker, so it is NOT trusted structurally: it is validated the same
 *   way the request side is, rather than passed through with a raw cast.
 *
 * zod is the initial schema implementation (Req 10.3, allowed explicitly). The per-capability
 * input schemas are composed from a single {@link SkillRefSchema} so the identity grammar has
 * one schema definition shared by every capability that addresses a skill.
 *
 * ─── Response validation at the untrusted-worker boundary (Req 6.3, 2.6) ──────────────
 *
 * {@link ParamCodec.decodeResponse} treats the wire response as untrusted input and enforces,
 * BEFORE handing anything to the caller:
 *   (a) the `SkillResponse` discriminant — `ok: true` requires a present `data` plus a minimal
 *       {@link Provenance} core `{fqid, provider, source}`; `ok: false` requires a typed
 *       `error` carrying a KNOWN error code ({@link KNOWN_ERROR_CODES});
 *   (b) a max-payload bound ({@link MAX_WIRE_RESPONSE_BYTES}) on the serialized response, so a
 *       pathological/oversized worker payload is rejected rather than materialized onward;
 *   (c) a reserved-field policy — the response envelope is STRICT: only the discriminant's
 *       allowed top-level keys may appear, so an injected/reserved top-level field (a
 *       prototype-pollution vector or any unexpected key) is rejected.
 * A malformed/oversized/reserved-violating wire response is mapped to a RETURNED typed
 * `provider_error` carrying the transport origin marker (`bus:<pool>`, matching the dispatch
 * convention in `bus-runtime.ts`) — never thrown across the contract boundary, never a prompt
 * string, and the malformed object is never passed to the caller. A structurally VALID
 * `ok: false` response (e.g. a genuine `not_found` from the worker) passes through unchanged.
 *
 * NOTE — separation of concerns: unknown-CAPABILITY DISPATCH is the bus worker's concern
 * (Task 7.2), not the codec's. The codec still answers a `decode(method, ...)` for an
 * unknown method with an `unsupported` error per the design sketch, so the worker has a
 * single, total decode result to act on; it does not itself route to a provider.
 */

import { z } from 'zod';
import { SkillsCapabilities } from '../capabilities.js';
import { TRUSTED_MAX_CONTENT_BYTES } from '../trust.js';
import type { CapabilityRef, SkillResponse, SkillRuntimeError } from '../contract.js';

// ---------------------------------------------------------------------------
// Per-capability input schemas (zod — initial implementation, Req 10.3)
// ---------------------------------------------------------------------------

/**
 * Schema for {@link SkillDescriptor}. Mirrors the contract shape: `fqid`, `name`,
 * `provider`, and `source` are required non-empty strings; `layer`/`category`/`pinned`
 * are optional. Used only by the `descriptor` arm of {@link SkillRefSchema}.
 */
const SkillDescriptorSchema = z.object({
  fqid: z.string().min(1),
  name: z.string().min(1),
  provider: z.string().min(1),
  source: z.string().min(1),
  layer: z.number().optional(),
  category: z.string().optional(),
  pinned: z.boolean().optional(),
});

/**
 * Schema for {@link SkillRef} — the open-world addressing union. Discriminated on `kind`
 * so a malformed or unknown arm fails validation with a precise, field-identifying issue
 * rather than silently matching the wrong shape.
 */
export const SkillRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fqid'), fqid: z.string().min(1) }),
  z.object({
    kind: z.literal('name'),
    name: z.string().min(1),
    provider: z.string().optional(),
  }),
  z.object({ kind: z.literal('descriptor'), descriptor: SkillDescriptorSchema }),
]);

/** `read` / `getReferences` share the `{ ref }` input shape. */
export const ReadSkillSchema = z.object({ ref: SkillRefSchema });
export const GetReferencesSchema = z.object({ ref: SkillRefSchema });

/** `list` input — provider scoping is optional. */
export const ListSkillsSchema = z.object({ provider: z.string().optional() });

/** `search` input — `query` required, `limit` optional. */
export const SearchSkillsSchema = z.object({
  query: z.string(),
  limit: z.number().optional(),
});

/** `readReference` input — a `ref` plus the reference path. */
export const ReadReferenceSchema = z.object({
  ref: SkillRefSchema,
  reference: z.string().min(1),
});

/** Validation rule set for one capability method. */
export interface CapabilitySchemas {
  /** Validates decoded params before any provider is invoked. */
  input: z.ZodTypeAny;
}

/**
 * One schema per known capability input, keyed by the SAME wire `method` string used on
 * the bus (`skills.read.v1`, ...). This is the lookup table {@link ParamCodec.decode}
 * consults; an absent key means the method is not a known capability.
 */
export const CAPABILITY_SCHEMAS: Record<string, CapabilitySchemas> = {
  [SkillsCapabilities.read.method]: { input: ReadSkillSchema },
  [SkillsCapabilities.list.method]: { input: ListSkillsSchema },
  [SkillsCapabilities.search.method]: { input: SearchSkillsSchema },
  [SkillsCapabilities.listReferences.method]: { input: GetReferencesSchema },
  [SkillsCapabilities.readReference.method]: { input: ReadReferenceSchema },
};

// ---------------------------------------------------------------------------
// Decode result
// ---------------------------------------------------------------------------

/**
 * Result of {@link ParamCodec.decode}: either the validated input (typed `unknown` because
 * the capability is selected by a runtime `method` string) or a typed, RETURNED error.
 * Never a thrown exception — the boundary stays total (Req 10.4, 10.5).
 */
export type DecodeResult =
  | { ok: true; input: unknown }
  | { ok: false; error: SkillRuntimeError };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render a single zod issue into a stable, field-identifying string for the
 * `bad_request.issues` array (Req 10.4). Uses the dotted JSON path to the failing field
 * (e.g. `ref.name: Required`); a top-level issue with no path falls back to the message
 * alone.
 */
function formatIssue(issue: z.ZodIssue): string {
  const fieldPath = issue.path.join('.');
  return fieldPath ? `${fieldPath}: ${issue.message}` : issue.message;
}

/**
 * Normalize a typed input to a JSON-serializable params object, dropping explicit-
 * `undefined` optional fields so they become ABSENT (codec policy, Req 10.6). The JSON
 * round-trip is a pure operation over the plain-data capability inputs: `JSON.stringify`
 * omits properties whose value is `undefined` at any depth (e.g. a `name` ref with
 * `provider: undefined`), and the result is exactly the wire shape the bus carries.
 */
function toJsonParams(input: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input ?? {})) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Wire response validation (untrusted-worker trust boundary — Req 6.3, 2.6)
// ---------------------------------------------------------------------------

/**
 * Known {@link SkillRuntimeError} codes, kept in lockstep with the `SkillRuntimeError`
 * union in `../contract.ts`. An `ok: false` wire response MUST carry one of these codes;
 * an unknown code is a malformed response from the worker and is rejected. When a code is
 * added to the contract union, add it here too (a single, intentional sync point).
 */
export const KNOWN_ERROR_CODES = [
  'not_found',
  'ambiguous',
  'unsupported',
  'provider_error',
  'bad_request',
  'out_of_bounds',
  'content_too_large',
  'isolation_failed',
  'aggregate_error',
] as const;

/**
 * Max serialized size, in bytes, accepted for a single wire `SkillResponse` (Req 6.3 DoS
 * guard). Derived from the trusted content bound ({@link TRUSTED_MAX_CONTENT_BYTES}) plus a
 * 1 MB envelope/provenance headroom, so a legitimate trusted skill body (already bounded by
 * the content-size policy at the read boundary) always fits, while an unbounded/pathological
 * worker payload is rejected. INTERIM/policy value, not a frozen decision.
 */
export const MAX_WIRE_RESPONSE_BYTES = TRUSTED_MAX_CONTENT_BYTES + 1_000_000;

/**
 * Minimal {@link Provenance} core required on every successful wire response (Req 2.3):
 * non-empty `fqid`, `provider`, and `source`. `passthrough()` admits the open index-
 * signature fields the contract allows (`resolvedFrom`, `aggregateDiagnostics`, ...) — the
 * reserved-field policy is enforced on the ENVELOPE, not on provenance, which is open by
 * contract.
 */
const WireProvenanceSchema = z
  .object({
    fqid: z.string().min(1),
    provider: z.string().min(1),
    source: z.string().min(1),
  })
  .passthrough();

/**
 * A wire error object must carry a KNOWN error code (the discriminant of the typed error
 * model). Other error fields are validated structurally-lightly via `passthrough()` — the
 * code is the trust-critical discriminant a caller switches on.
 */
const WireErrorSchema = z
  .object({ code: z.enum(KNOWN_ERROR_CODES) })
  .passthrough();

/**
 * The wire `SkillResponse` envelope, STRICT on top-level keys (the reserved-field policy):
 * - `ok: true`  → exactly `{ ok, data, provenance }` with a minimal provenance core;
 * - `ok: false` → exactly `{ ok, error, provenance? }` with a known-code error.
 * Any other / reserved top-level key (e.g. an injected field or a prototype-pollution
 * vector surfaced as an own key by `JSON.parse`) fails `.strict()` and is rejected. `data`
 * is typed `unknown` here (the payload type is the capability's `TOutput`); its REQUIRED
 * PRESENCE is enforced separately in {@link validateWireResponse} because a `z.unknown()`
 * key is treated as optional by zod.
 */
const WireResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({ ok: z.literal(true), data: z.unknown(), provenance: WireProvenanceSchema })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: WireErrorSchema,
      provenance: WireProvenanceSchema.optional(),
    })
    .strict(),
]);

/** Structural validation outcome for a wire response: admitted, or a human-readable reason. */
type WireValidation = { ok: true } | { ok: false; reason: string };

/**
 * Validate an untrusted wire `SkillResponse` (Req 6.3, 2.6). Total — never throws. Enforces,
 * in order: (b) the max-payload bound, then (a)+(c) the strict discriminated envelope +
 * minimal provenance / known error code, then the `data`-presence requirement for `ok: true`.
 */
function validateWireResponse(raw: unknown): WireValidation {
  // (b) Max-payload bound — measure the serialized response before structural work, so a
  // pathological/oversized payload is rejected rather than processed onward.
  let serialized: string;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    return { ok: false, reason: 'wire response is not JSON-serializable' };
  }
  if (serialized === undefined) {
    return { ok: false, reason: 'wire response is undefined' };
  }
  const byteLength = Buffer.byteLength(serialized, 'utf8');
  if (byteLength > MAX_WIRE_RESPONSE_BYTES) {
    return {
      ok: false,
      reason: `wire response exceeds the max payload bound (${byteLength} > ${MAX_WIRE_RESPONSE_BYTES} bytes)`,
    };
  }

  // (a)+(c) Strict discriminated envelope + minimal provenance / known error code.
  const parsed = WireResponseSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join('.');
    return {
      ok: false,
      reason: `malformed wire response: ${where ? `${where}: ` : ''}${first?.message ?? 'invalid'}`,
    };
  }

  // `ok: true` requires a PRESENT, non-null `data` (a `z.unknown()` key is optional in zod,
  // and JSON cannot transmit `undefined`, so an absent `data` arrives as `undefined`).
  if (parsed.data.ok === true) {
    const data = (parsed.data as { data?: unknown }).data;
    if (data === undefined || data === null) {
      return { ok: false, reason: 'malformed wire response: ok:true requires a present `data`' };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// ParamCodec
// ---------------------------------------------------------------------------

export const ParamCodec = {
  /**
   * Encode a typed capability input to a JSON-serializable params object for
   * `bus.request(method, params)` (Req 10.1). Pure: it never mutates `input`. Explicit-
   * `undefined` optionals are normalized to absent so {@link decode}∘{@link encode} is
   * semantically identity-preserving for valid inputs (Req 10.6).
   */
  encode<TInput, TOutput>(
    _cap: CapabilityRef<TInput, TOutput>,
    input: TInput,
  ): Record<string, unknown> {
    return toJsonParams(input);
  },

  /**
   * Decode and validate received params at the single transport-boundary validation
   * point (Req 10.2, 10.3). Returns a typed error and invokes NO provider when:
   * - `params` is null or not an object → `bad_request` (Req 10.5);
   * - `method` has no registered schema → `unsupported` (design §3c);
   * - the decoded params fail the capability schema → `bad_request` with the failing
   *   field(s) (Req 10.4).
   * On success returns the parsed, typed input. Runtime state is never mutated here.
   */
  decode(method: string, params: unknown): DecodeResult {
    if (params === null || typeof params !== 'object') {
      return {
        ok: false,
        error: { code: 'bad_request', issues: ['params must be a non-null object'] },
      };
    }

    const schema = CAPABILITY_SCHEMAS[method]?.input;
    if (!schema) {
      return { ok: false, error: { code: 'unsupported', capability: method } };
    }

    const parsed = schema.safeParse(params);
    if (!parsed.success) {
      return {
        ok: false,
        error: { code: 'bad_request', issues: parsed.error.issues.map(formatIssue) },
      };
    }

    return { ok: true, input: parsed.data };
  },

  /**
   * Decode and structurally VALIDATE a wire response into a typed {@link SkillResponse} at
   * the untrusted-worker trust boundary (Req 6.3, 2.6). The response crossing the bus comes
   * from an out-of-process / potentially remote worker, so — unlike the proven in-process
   * path, which bypasses the codec entirely (Req 6.2) — it is NOT trusted structurally and
   * is validated here the same way {@link decode} validates the request side:
   *   (a) the discriminant: `ok: true` requires a present `data` + a minimal provenance
   *       `{fqid, provider, source}`; `ok: false` requires a typed `error` with a KNOWN code;
   *   (b) the max-payload bound ({@link MAX_WIRE_RESPONSE_BYTES});
   *   (c) the reserved-field policy: a strict envelope rejecting injected/reserved top-level
   *       keys.
   * A malformed/oversized/reserved-violating response is mapped to a RETURNED typed
   * `provider_error` carrying the transport `origin` marker (`bus:<pool>`, matching the
   * `bus-runtime.ts` dispatch convention) — never thrown, never a prompt string, and the
   * malformed object is never passed to the caller. A structurally VALID response (including
   * a genuine `ok: false` such as `not_found`) is returned unchanged.
   *
   * @param origin - transport-origin marker recorded on the `provider_error` for a malformed
   *   response (the caller passes `bus:<pool>`); defaults to `'bus'` when unspecified.
   */
  decodeResponse<TInput, TOutput>(
    _cap: CapabilityRef<TInput, TOutput>,
    raw: unknown,
    origin = 'bus',
  ): SkillResponse<TOutput> {
    const validation = validateWireResponse(raw);
    if (!validation.ok) {
      return {
        ok: false,
        error: { code: 'provider_error', provider: origin, message: validation.reason },
      };
    }
    return raw as SkillResponse<TOutput>;
  },
};
