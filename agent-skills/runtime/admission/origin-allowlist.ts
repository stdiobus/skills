/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Operator origin allowlist — the OPTIONAL deployment control that restricts which HTTPS
 * origins are admissible (Milestone-002, Task 13.2; design §"Components" 8; Req 16.5).
 *
 * ─── A RESTRICTION, NEVER A HIDDEN ON/OFF ──────────────────────────────────────────
 *
 * This is NOT a flag that conceals the `admit_skill` tool: the tool is ALWAYS registered
 * (Task 13.1). The allowlist only narrows WHICH origins an admission succeeds for. It is a
 * safe-by-default operator restriction sourced from deployment config / environment:
 *
 *   - WHERE the allowlist is UNSET (the documented default), {@link permits} returns `true`
 *     for every URL: public HTTPS origins are permitted, governed by the existing
 *     untrusted-by-default + bounded-acquisition + content-as-data + namespace-ownership
 *     controls (Req 5, 7, 8). Behaviour is byte-for-byte the pre-13.2 default.
 *   - WHERE the allowlist IS SET, ONLY the HTTPS origins it lists are admissible; any other
 *     origin is rejected. Composed into the HTTP blueprint's `configSchema`
 *     (`withOriginAllowlist`), a non-allowlisted `url` is quarantined at the admission
 *     `validate` stage with a typed `bad_request` — BEFORE the `acquire` stage performs any
 *     fetch (design §"Data Flow"; Req 16.5).
 *
 * ─── ORIGIN, NOT URL ───────────────────────────────────────────────────────────────
 *
 * Membership is decided on the URL's {@link URL.origin} (scheme + host + port), never the
 * full path — so an operator allows `https://raw.githubusercontent.com` once and every path
 * under it is admissible. Entries and candidates are both normalised to their `origin`, and
 * ONLY `https:` origins are ever retained or matched (a non-HTTPS entry is dropped; a
 * non-HTTPS candidate never matches). This is an OOP policy object (state + behaviour), not a
 * pure value helper — `normalizeHttpsOrigin` is the one pure helper it composes (architecture
 * standard §§5, 9).
 */

/** Environment variable carrying the comma/whitespace-separated HTTPS origin allowlist. */
export const ORIGIN_ALLOWLIST_ENV = 'STDIOBUS_SKILLS_ORIGIN_ALLOWLIST';

/**
 * Normalise a string to its canonical `https:` origin, or `undefined` when it is not a valid
 * absolute HTTPS URL/origin (pure value helper; architecture standard §5).
 *
 * `new URL(value).origin` canonicalises scheme + host + port (e.g.
 * `https://Raw.GitHubusercontent.com/git/git/COPYING` → `https://raw.githubusercontent.com`),
 * so an operator's allowlist entry and an admission candidate compare on the same key. A
 * non-`https:` scheme returns `undefined`: the allowlist admits HTTPS origins only (Req 16.5).
 */
function normalizeHttpsOrigin(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  return parsed.protocol === 'https:' ? parsed.origin : undefined;
}

/**
 * The operator origin allowlist (Req 16.5).
 *
 * Immutable once constructed. An UNSET allowlist (`origins === undefined`) permits every URL
 * (the documented default); a SET allowlist permits only the HTTPS origins it lists.
 * Constructed via the named factories — never `new` directly — so the unset/empty case is a
 * single, explicit decision.
 */
export class OriginAllowlist {
  private constructor(private readonly origins: ReadonlySet<string> | undefined) { }

  /** The default control: unset → every URL is permitted (public HTTPS, existing controls). */
  static unrestricted(): OriginAllowlist {
    return new OriginAllowlist(undefined);
  }

  /**
   * Build an allowlist from a set of operator-supplied origin strings.
   *
   * Each entry is normalised to its `https:` origin; non-HTTPS / unparseable entries are
   * dropped. If NO valid HTTPS origin remains, the result is {@link unrestricted} — an empty
   * allowlist is treated as "not configured" rather than "permit nothing", so a misconfigured
   * value never silently disables admission for every origin (it would be an undocumented
   * on/off, which Req 16.5 forbids).
   */
  static fromOrigins(entries: Iterable<string>): OriginAllowlist {
    const normalized = new Set<string>();
    for (const entry of entries) {
      const origin = normalizeHttpsOrigin(entry);
      if (origin !== undefined) normalized.add(origin);
    }
    return normalized.size > 0 ? new OriginAllowlist(normalized) : OriginAllowlist.unrestricted();
  }

  /**
   * Source the allowlist from the deployment environment (Req 16.5).
   *
   * Reads {@link ORIGIN_ALLOWLIST_ENV}; an unset variable yields {@link unrestricted} (the
   * documented default). A set variable is split on commas/whitespace and parsed via
   * {@link fromOrigins}.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): OriginAllowlist {
    const raw = env[ORIGIN_ALLOWLIST_ENV];
    if (raw === undefined) return OriginAllowlist.unrestricted();
    const entries = raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return OriginAllowlist.fromOrigins(entries);
  }

  /** Whether the operator configured a restricting allowlist (vs. the permit-all default). */
  get isConfigured(): boolean {
    return this.origins !== undefined;
  }

  /**
   * Whether `url`'s HTTPS origin is admissible (Req 16.5).
   *
   * - Unset allowlist → `true` for every URL (the documented default).
   * - Set allowlist → `true` only when `url` is a valid `https:` URL whose origin is listed;
   *   a non-HTTPS URL (already rejected upstream by the HTTPS-only `configSchema`) and any
   *   non-listed origin return `false`.
   */
  permits(url: string): boolean {
    if (this.origins === undefined) return true;
    const origin = normalizeHttpsOrigin(url);
    return origin !== undefined && this.origins.has(origin);
  }

  /** The permitted origins (empty when unset) — for operator-facing diagnostics only. */
  permittedOrigins(): ReadonlyArray<string> {
    return this.origins === undefined ? [] : [...this.origins];
  }
}
