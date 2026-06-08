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
 * - {@link ParamCodec.decodeResponse}: wire `SkillResponse` → typed `SkillResponse`
 *   (structural; the response is already a discriminated union over the wire, Req 6.3).
 *
 * zod is the initial schema implementation (Req 10.3, allowed explicitly). The per-capability
 * input schemas are composed from a single {@link SkillRefSchema} so the identity grammar has
 * one schema definition shared by every capability that addresses a skill.
 *
 * NOTE — separation of concerns: unknown-CAPABILITY DISPATCH is the bus worker's concern
 * (Task 7.2), not the codec's. The codec still answers a `decode(method, ...)` for an
 * unknown method with an `unsupported` error per the design sketch, so the worker has a
 * single, total decode result to act on; it does not itself route to a provider.
 */

import { z } from 'zod';
import { SkillsCapabilities } from '../capabilities.js';
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
   * Decode a wire response into a typed {@link SkillResponse}. The raw value already
   * conforms to the `SkillResponse` discriminated union over the wire (Req 6.3, proven by
   * Milestone §11 fact 6), so this is a structural cast rather than a re-validation: the
   * returned-error model and provenance ride the union unchanged across the boundary.
   */
  decodeResponse<TInput, TOutput>(
    _cap: CapabilityRef<TInput, TOutput>,
    raw: unknown,
  ): SkillResponse<TOutput> {
    return raw as SkillResponse<TOutput>;
  },
};
