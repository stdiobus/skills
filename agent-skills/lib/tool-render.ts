/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MCP tool-output rendering — pure, side-effect-free helpers.
 *
 * These translate a runtime {@link SkillResponse} into the MCP tool result shape. They are
 * deliberately split out of `mcp-server.ts` (which runs `main()` on import) so they can be
 * exercised deterministically by tests in BOTH the compatibility mode and the opt-in
 * staged-provenance mode without spawning a process.
 *
 * ─── Staged provenance exposure (Migration Step 9 — design §"Migration / Rollout
 *     Sequence" step 9, Req 9.7, 9.9) ──────────────────────────────────────────────────
 *
 * Provenance exposure at the MCP response level is an OPT-IN, DECLARED, VERSIONED staged
 * change governed by the single flag {@link AdapterRenderOptions.exposeProvenance}:
 *
 *   - OFF (default, Req 9.7): output is BYTE-IDENTICAL to the compatibility phase — raw
 *     body for `read_skill`/`read_reference`; a JSON string array for `list_references`.
 *   - ON (explicit opt-in, Req 9.9): the runtime-backed body/reference tools emit the
 *     declared {@link PROVENANCE_SHAPE_VERSION} envelope that ADDS provenance alongside
 *     the existing content.
 *
 * `list_skills` (manifest document) and `search_skills` (keyword index) are NOT rendered
 * here: neither is backed by a single runtime `SkillResponse` provenance envelope, so the
 * staged shape does not apply to them.
 */

import type {
  Provenance,
  ReferenceContent,
  ReferenceDescriptor,
  SkillContent,
  SkillRef,
  SkillResponse,
  SkillRuntimeError,
} from '../runtime/contract.js';

/** MCP tool result shape (unchanged from the pre-migration contract). */
export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

// ---------------------------------------------------------------------------
// Error rendering (provenance-independent)
// ---------------------------------------------------------------------------

/** Human-facing label for a {@link SkillRef} in a rendered error. */
function refLabel(ref: SkillRef): string {
  switch (ref.kind) {
    case 'name':
      return `"${ref.name}"`;
    case 'fqid':
      return `"${ref.fqid}"`;
    case 'descriptor':
      return `"${ref.descriptor.name}"`;
  }
}

/** Render a typed {@link SkillRuntimeError} into a single diagnostic line. */
export function describeError(error: SkillRuntimeError): string {
  switch (error.code) {
    case 'not_found':
      return `skill not found: ${refLabel(error.ref)}`;
    case 'ambiguous':
      return `ambiguous skill ${refLabel(error.ref)} resolves to ${error.candidates.length} candidates`;
    case 'unsupported':
      return error.provider
        ? `capability "${error.capability}" is not supported by provider "${error.provider}"`
        : `capability "${error.capability}" is not supported`;
    case 'provider_error':
      return error.message;
    case 'bad_request':
      return error.issues.join('; ');
    case 'out_of_bounds':
      return error.detail;
    case 'content_too_large':
      return `content exceeds the maximum size of ${error.limitBytes} bytes`;
    case 'isolation_failed':
      return error.reason;
    case 'aggregate_error':
      return error.failures.map((f) => `${f.provider}: ${describeError(f.error)}`).join('; ');
  }
}

/** Render a typed runtime error as an MCP tool error (`isError: true`). */
export function renderError(tool: string, error: SkillRuntimeError): ToolResult {
  return {
    content: [{ type: 'text', text: `${tool}: ${describeError(error)}` }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Staged provenance exposure (Task 11.1 — Migration Step 9, Req 9.7, 9.9)
// ---------------------------------------------------------------------------

/**
 * Declared, versioned marker for the opt-in staged provenance response shape.
 *
 * This is the DECLARED name of the staged MCP response shape introduced by Migration
 * Step 9 (Req 9.9). The staged shape is a deliberate, versioned envelope — never an
 * implicit mutation of the existing shape. A future staged shape is declared by
 * introducing a new version marker, not by editing the compatibility output in place.
 */
export const PROVENANCE_SHAPE_VERSION = 'provenance.v1';

/**
 * Declared opt-in environment variable for the standalone executable.
 *
 * DEFAULT OFF (Req 9.7): when unset — or set to anything other than the exact strings
 * `"1"` or `"true"` — the adapter renders compatibility-phase output that is
 * BYTE-IDENTICAL to the pre-staging contract. Setting it to `"1"`/`"true"` opts into the
 * declared {@link PROVENANCE_SHAPE_VERSION} staged shape (Req 9.9). Provenance exposure is
 * a deployment choice, never an implicit default.
 */
export const EXPOSE_PROVENANCE_ENV = 'STDIOBUS_SKILLS_EXPOSE_PROVENANCE';

/** Render options threaded through the pure render helpers. */
export interface AdapterRenderOptions {
  /**
   * Opt-in provenance exposure (Req 9.9). `false` (default) → compatibility output that is
   * byte-identical to the pre-staging contract (Req 9.7); `true` → the declared
   * {@link PROVENANCE_SHAPE_VERSION} staged shape.
   */
  exposeProvenance: boolean;
}

/** The declared compatibility default: provenance is NOT exposed (Req 9.7). */
export const COMPAT_RENDER_OPTIONS: AdapterRenderOptions = { exposeProvenance: false };

/**
 * Resolve the opt-in flag from the environment (the standalone executable's default
 * source). Only the exact strings `"1"` and `"true"` enable exposure; every other value
 * (including unset) stays OFF, preserving the compatibility phase by default.
 */
export function resolveExposeProvenance(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[EXPOSE_PROVENANCE_ENV];
  return v === '1' || v === 'true';
}

/** The declared `provenance.v1` provenance projection (minimum identity set + resolvedFrom). */
export interface StagedProvenanceV1 {
  fqid: string;
  provider: string;
  source: string;
  resolvedFrom?: SkillRef;
}

/**
 * Project a runtime {@link Provenance} envelope onto the declared `provenance.v1` field
 * set: the minimum identity set `{ fqid, provider, source }` plus the optional
 * `resolvedFrom`. Provider-private and ad-hoc index-signature fields are intentionally NOT
 * forwarded — the staged shape is a deliberate, declared projection, not a raw dump.
 */
function stagedProvenance(p: Provenance): StagedProvenanceV1 {
  const out: StagedProvenanceV1 = { fqid: p.fqid, provider: p.provider, source: p.source };
  if (p.resolvedFrom !== undefined) out.resolvedFrom = p.resolvedFrom;
  return out;
}

/**
 * Render a body-bearing response (`read_skill` / `read_reference`).
 *
 * OFF (default): the raw body, byte-identical to the compatibility phase.
 * ON: the declared `provenance.v1` envelope `{ version, body, provenance }` serialized as
 * JSON, adding provenance WITHOUT discarding the body.
 */
function renderBody(
  tool: string,
  resp: SkillResponse<{ body: string }>,
  opts: AdapterRenderOptions,
): ToolResult {
  if (!resp.ok) return renderError(tool, resp.error);
  if (!opts.exposeProvenance) {
    return { content: [{ type: 'text', text: resp.data.body }] };
  }
  const envelope = {
    version: PROVENANCE_SHAPE_VERSION,
    body: resp.data.body,
    provenance: stagedProvenance(resp.provenance),
  };
  return { content: [{ type: 'text', text: JSON.stringify(envelope) }] };
}

/**
 * Render a `read_skill` response. OFF → raw SKILL.md body (compat); ON → declared
 * `provenance.v1` `{ version, body, provenance }` envelope.
 */
export function renderReadSkill(
  resp: SkillResponse<SkillContent>,
  opts: AdapterRenderOptions = COMPAT_RENDER_OPTIONS,
): ToolResult {
  return renderBody('read_skill', resp, opts);
}

/**
 * Render a `read_reference` response. OFF → raw reference body (compat); ON → declared
 * `provenance.v1` `{ version, body, provenance }` envelope.
 */
export function renderReadReference(
  resp: SkillResponse<ReferenceContent>,
  opts: AdapterRenderOptions = COMPAT_RENDER_OPTIONS,
): ToolResult {
  return renderBody('read_reference', resp, opts);
}

/**
 * Render a `list_references` response. OFF → the plain JSON string array of paths
 * (compat); ON → declared `provenance.v1` `{ version, references, provenance }` envelope.
 */
export function renderListReferences(
  resp: SkillResponse<ReferenceDescriptor[]>,
  opts: AdapterRenderOptions = COMPAT_RENDER_OPTIONS,
): ToolResult {
  if (!resp.ok) return renderError('list_references', resp.error);
  const paths = resp.data.map((d) => d.path);
  if (!opts.exposeProvenance) {
    return { content: [{ type: 'text', text: JSON.stringify(paths) }] };
  }
  const envelope = {
    version: PROVENANCE_SHAPE_VERSION,
    references: paths,
    provenance: stagedProvenance(resp.provenance),
  };
  return { content: [{ type: 'text', text: JSON.stringify(envelope) }] };
}
