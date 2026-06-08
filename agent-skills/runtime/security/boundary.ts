/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Security boundary — pure path-traversal and content-size guards (Migration Step 7,
 * Task 9.2; design §9; Req 11.4, 11.5).
 *
 * This module is the single, reusable place that decides whether a provider-supplied
 * source/reference path or a piece of provider content may cross into trusted runtime
 * state. It **generalizes the existing {@link FileResolver} `..` guard**
 * (`lib/file-resolver.ts`, which currently signals violations by THROWING) into PURE
 * functions that **RETURN a typed result and never throw** — so the no-throw boundary
 * guarantee of {@link SkillResponse} (Req 2.6) extends to the security checks too
 * (Req 11.3/11.4/11.5).
 *
 * ─── DESIGN NOTES ──────────────────────────────────────────────────────────────────
 *
 * - {@link checkWithinRoot} reproduces BOTH halves of the proven FileResolver guard:
 *   (1) reject any path containing a `..` traversal segment, and (2) verify the resolved
 *   absolute path is the permitted root itself or nested under `root + path.sep`
 *   (the exact `resolvedPath.startsWith(root + sep) || === root` containment rule). An
 *   absolute candidate path is handled too: `path.resolve(root, abs)` returns `abs`, which
 *   fails the containment check unless it is inside the root.
 *
 * - {@link checkContentSize} bounds the byte length against the provider's
 *   `maxContentBytes`. It accepts a `string`/`Buffer` (byte length measured with
 *   `Buffer.byteLength`/`.length`) OR a pre-computed byte count (`number`). The `number`
 *   overload is the **"not loaded in full" migration path** (Req 11.5): a caller that can
 *   obtain a size via `fs.stat` BEFORE reading passes that size and rejects oversize
 *   content without ever materializing it. The bundled filesystem path currently reads
 *   strings, so the INTERIM check measures the already-loaded content's byte length; the
 *   stat/stream-based pre-read check swaps in here without changing the call sites.
 *
 * - {@link checkIsolation} is the **untrusted-content admission predicate** (Task 9.3;
 *   design §9; Req 11.2, 11.3). It decides whether content from a provider whose policy
 *   REQUIRES isolation (`isolateFetch: true` — the untrusted default) may be admitted to
 *   trusted runtime state: admission is allowed ONLY when the configured isolation /
 *   content-safety boundary is satisfiable (`ctx.isolationAvailable === true`). Otherwise
 *   it returns `isolation_failed` and the caller MUST NOT admit the content. A trusted
 *   provider (or any policy with `isolateFetch: false`) needs no isolation gate. The
 *   concrete isolation MECHANISM is open (design "Open Items" item E / Milestone §10): the
 *   design notes the out-of-process stdio Bus worker MAY serve as the isolation boundary,
 *   so `isolationAvailable` models "that boundary is present and usable". This function is
 *   the interim admission predicate, not the sandbox itself.
 *
 * ─── UNTRUSTED-AS-DATA INVARIANT (Req 11.7) ────────────────────────────────────────
 *
 * All external provider content is treated as untrusted **data**, never as instructions or
 * code. This module — and the runtime read path it guards — only ever inspects content as
 * strings / byte lengths and RETURNS it; it NEVER `eval`s it, `require()`s it, spawns it, or
 * derives authority/permissions from anything embedded in skill content. There is
 * deliberately no code path in the runtime that executes provider content. Admission is
 * gated purely by the structural predicates here ({@link checkWithinRoot},
 * {@link checkContentSize}, {@link checkIsolation}); a classifier hint or any in-content
 * directive can never promote a provider's authority (see `mayPromoteClassification` in
 * `../trust.js` for the classification-promotion guard). This is an explicit, tested
 * invariant (Task 9.4 unit / 9.5 property), not merely incidental.
 *
 * Both functions take the `provider` id so the returned {@link SkillRuntimeError} can name
 * the offending provider, exactly as the `out_of_bounds` / `content_too_large` /
 * `isolation_failed` union members require (design §9 Error Handling).
 */

import * as path from 'path';
import type { SkillRuntimeError } from '../contract.js';
import type { TrustPolicy } from '../trust.js';

/** Result of {@link checkWithinRoot}: the resolved absolute path, or a returned error. */
export type WithinRootResult =
  | { ok: true; resolved: string }
  | { ok: false; error: SkillRuntimeError };

/**
 * Reject a source/reference path that escapes a provider's permitted root (Req 11.4).
 *
 * Generalizes the proven {@link FileResolver} `..` guard: returns an `out_of_bounds`
 * error (never throws) when `candidatePath` contains a `..` traversal segment OR when its
 * resolved absolute path falls outside `permittedRoot`. The caller MUST treat a non-`ok`
 * result as "do not read this location" (Req 11.4: the out-of-bounds location is not read).
 *
 * Containment rule mirrors `file-resolver.ts` verbatim: the resolved path must equal the
 * root or start with `root + path.sep`.
 *
 * @param permittedRoot - the provider's permitted source root (absolute or resolvable).
 * @param candidatePath - the source/reference path to admit (relative or absolute).
 * @param provider - the provider id, recorded on the returned error.
 * @returns `{ ok: true, resolved }` when contained, else `{ ok: false, error }`.
 */
export function checkWithinRoot(
  permittedRoot: string,
  candidatePath: string,
  provider: string,
): WithinRootResult {
  // Guard 1 — reject directory traversal tokens up front (mirrors FileResolver's
  // `referencePath.includes('..')` rejection).
  if (candidatePath.includes('..')) {
    return {
      ok: false,
      error: {
        code: 'out_of_bounds',
        provider,
        detail: `path "${candidatePath}" contains a directory-traversal segment ("..")`,
      },
    };
  }

  const root = path.resolve(permittedRoot);
  // For an absolute `candidatePath`, `path.resolve` discards `root` and returns the
  // absolute path itself — which then fails the containment check below unless it is
  // genuinely inside the root.
  const resolved = path.resolve(root, candidatePath);

  // Guard 2 — belt-and-suspenders containment (mirrors FileResolver's
  // `startsWith(refsDir + path.sep) || === refsDir`).
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return {
      ok: false,
      error: {
        code: 'out_of_bounds',
        provider,
        detail: `path "${candidatePath}" resolves outside the permitted root`,
      },
    };
  }

  return { ok: true, resolved };
}

/** Result of {@link checkContentSize}: admitted, or a returned size error. */
export type ContentSizeResult =
  | { ok: true }
  | { ok: false; error: SkillRuntimeError };

/**
 * Reject provider content that exceeds the configured `maxContentBytes` (Req 11.5).
 *
 * Returns a `content_too_large` error (never throws) when the content's byte length
 * exceeds `limitBytes`. Byte length is measured as:
 * - `number` → used directly (a pre-computed size, e.g. from `fs.stat`) — the
 *   "not loaded in full" path: oversize content is rejected before being materialized;
 * - `string` → `Buffer.byteLength(content, 'utf8')`;
 * - `Buffer` → `content.length`.
 *
 * @param content - the content, or its pre-computed byte length.
 * @param limitBytes - the provider's `maxContentBytes` ceiling.
 * @param provider - the provider id, recorded on the returned error.
 * @returns `{ ok: true }` when within the limit, else `{ ok: false, error }`.
 */
export function checkContentSize(
  content: string | Buffer | number,
  limitBytes: number,
  provider: string,
): ContentSizeResult {
  const byteLength =
    typeof content === 'number'
      ? content
      : typeof content === 'string'
        ? Buffer.byteLength(content, 'utf8')
        : content.length;

  if (byteLength > limitBytes) {
    return { ok: false, error: { code: 'content_too_large', provider, limitBytes } };
  }

  return { ok: true };
}

/** Result of {@link checkIsolation}: admission allowed, or a returned isolation error. */
export type IsolationResult =
  | { ok: true }
  | { ok: false; error: SkillRuntimeError };

/**
 * Untrusted-content admission predicate (Req 11.2, 11.3).
 *
 * Decides whether content from `ctx.provider` may be admitted to trusted runtime state
 * (the `fetch`/`add` import path — forward-looking; see Req 7.1). The rule is keyed on the
 * provider's policy, never on the content itself (untrusted-as-data, Req 11.7):
 *
 * - WHEN the policy requires isolation (`policy.isolateFetch === true` — the untrusted
 *   default), admission is allowed ONLY when the configured isolation / content-safety
 *   boundary is satisfiable (`ctx.isolationAvailable === true`). If it cannot be satisfied,
 *   this returns an `isolation_failed` error and the caller MUST NOT admit the content
 *   (Req 11.2, 11.3).
 * - OTHERWISE (a trusted provider, or any policy with `isolateFetch: false`) no isolation
 *   gate applies and admission is allowed.
 *
 * Pure and returned-never-thrown, exactly like {@link checkWithinRoot} /
 * {@link checkContentSize}, so the no-throw boundary guarantee (Req 2.6) extends to the
 * isolation check too (Req 11.3 totality case). The concrete isolation MECHANISM remains
 * open (design "Open Items" item E / Milestone §10): the out-of-process stdio Bus worker
 * MAY serve as the isolation boundary, and `isolationAvailable` models "that boundary is
 * present and usable". This is the interim admission predicate, not the sandbox.
 *
 * @param policy - the (effective) trust policy of the admitting provider.
 * @param ctx.provider - the provider id, recorded on the returned error.
 * @param ctx.isolationAvailable - whether the configured isolation boundary is satisfiable.
 * @returns `{ ok: true }` when admission is allowed, else `{ ok: false, error }`.
 */
export function checkIsolation(
  policy: TrustPolicy,
  ctx: { provider: string; isolationAvailable: boolean },
): IsolationResult {
  // No isolation required (trusted provider, or policy explicitly opts out): admit.
  if (!policy.isolateFetch) return { ok: true };

  // Isolation is required but the configured boundary cannot be satisfied → reject and do
  // NOT admit the content (Req 11.3). The reason is a typed-but-human-readable string.
  if (!ctx.isolationAvailable) {
    return {
      ok: false,
      error: {
        code: 'isolation_failed',
        provider: ctx.provider,
        reason:
          `provider "${ctx.provider}" requires isolation for fetch/import, but the ` +
          'configured isolation/content-safety boundary is unavailable; content not admitted',
      },
    };
  }

  // Isolation required AND satisfiable → admission allowed under the isolation boundary.
  return { ok: true };
}
