/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HttpSkillProvider — the second REAL provider: acquires skill content over real HTTPS
 * (Milestone-002, Task 7.1; design §"Components" 4; Req 4.2, 4.4, 7.1, 7.5, 7.6, 12.3).
 *
 * A class implementing the existing capability-optional {@link SkillProvider} contract that
 * fetches a single skill body from a configured **HTTPS** URL using the platform's standard
 * TLS as-is. It is materialized in-process from a {@link ProviderDescriptor} through its
 * {@link HttpSkillProviderBlueprint}; once admitted it is reachable over both live transports
 * with nothing new spawned (Req 7.1, 7.2).
 *
 * ─── NO CERTIFICATE / TLS / ORIGIN-TRUST FEATURE (Req 4.4, 7.4) ─────────────────────
 *
 * {@link httpProviderConfigSchema} requires HTTPS-only URLs and the acquisition bounds
 * (`maxContentBytes`, finite `timeoutMs`) and defines **no** certificate pinning, custom CA,
 * or origin-trust policy. The fetch uses the runtime's standard HTTPS/TLS trust unchanged.
 *
 * ─── AUTH IS CONSUMED, NEVER IMPLEMENTED (Req 7.3) ─────────────────────────────────
 *
 * Request headers come from the injected {@link CredentialHeadersProvider} on the creation
 * context — a thin adapter over an ALREADY-AUTHORIZED `@stdiobus/workers-registry` result.
 * The M-002 default is the no-credential adapter (public origins). This provider implements
 * no OAuth, token storage, or refresh.
 *
 * ─── BOUNDED + CANCELLABLE, TYPED ERRORS (Req 7.5, 8.1, 12.3) ──────────────────────
 *
 * {@link HttpSkillProvider.read} arms its OWN finite timeout from `config.timeoutMs` (a
 * finite default applies even when no caller signal is supplied — Req 12.3) and links an
 * OPTIONAL caller-supplied {@link AbortSignal} so an in-flight fetch honors both the deadline
 * and external cancellation. It enforces `config.maxContentBytes` BOTH from a declared
 * `Content-Length` (rejecting before materialization where the origin declares its size —
 * Req 8.1) AND while streaming the body (so a missing/incorrect header cannot smuggle an
 * over-limit payload). On an unavailable origin, a non-2xx status, an over-budget abort, or
 * an over-limit body it throws a typed {@link HttpProviderError} carrying a
 * {@link SkillRuntimeError}; the runtime's per-operation boundary (and the admission
 * `acquire` stage / {@link OperationBudget} seam) catches it and returns the typed error,
 * so nothing is thrown across the contract boundary (Req 7.5).
 */

import { formatFqid, parseFqid } from '../fqid.js';
import type {
  CredentialHeadersProvider,
  ProviderBlueprint,
  ProviderCreationContext,
} from '../admission/provider-blueprint.js';
import type { Schema, SchemaResult } from '../admission/schema.js';
import type {
  ListSkillsInput,
  ResolvedSkill,
  SkillContent,
  SkillContentMetadata,
  SkillDescriptor,
  SkillProvider,
  SkillProviderCapabilities,
  SkillRef,
  SkillRuntimeError,
} from '../contract.js';

/**
 * The validated config for the `http` blueprint (the binding `TConfig`, §6).
 *
 * - `url` — the HTTPS origin the provider fetches its single skill body from
 *   ({@link httpProviderConfigSchema} requires `https:`; Req 4.4).
 * - `maxContentBytes` — the acquisition size bound; an over-limit body is rejected with a
 *   typed `content_too_large` (Req 8.1).
 * - `timeoutMs` — the finite per-fetch timeout; a finite default always applies (Req 12.3).
 */
export interface HttpProviderConfig {
  readonly url: string;
  readonly maxContentBytes: number;
  readonly timeoutMs: number;
}

/**
 * Typed error thrown by {@link HttpSkillProvider.read} when acquisition fails.
 *
 * Carries the authoritative {@link SkillRuntimeError} so the admission `acquire` stage
 * (Task 8) and the runtime's provider-output boundary can surface the precise typed code
 * (`content_too_large` for an over-limit body, `provider_error` for an unavailable origin /
 * non-2xx / abort) WITHOUT re-deriving it. Throwing — not returning — keeps the
 * {@link SkillProvider.read} signature unchanged; the runtime catches it (Req 7.5).
 */
export class HttpProviderError extends Error {
  constructor(readonly runtimeError: SkillRuntimeError, message: string) {
    super(message);
    this.name = 'HttpProviderError';
  }
}

/** Allowed config keys — anything else is an unknown key the schema rejects (Req 4.2). */
const ALLOWED_CONFIG_KEYS: ReadonlySet<string> = new Set(['url', 'maxContentBytes', 'timeoutMs']);

/**
 * HTTPS-only config schema for the `http` blueprint (Req 4.2, 4.4).
 *
 * Total + returned (never throws): an invalid input is the `{ ok: false; issues }` branch.
 * Requires a valid `https:` URL, a positive finite integer `maxContentBytes`, and a positive
 * finite `timeoutMs`; rejects unknown keys; defines NO certificate / TLS / origin-trust
 * policy. The `validate` admission stage maps `{ ok: false }` to a `bad_request` quarantine.
 */
export const httpProviderConfigSchema: Schema<HttpProviderConfig> = {
  parse(input: unknown): SchemaResult<HttpProviderConfig> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return { ok: false, issues: ['config must be an object'] };
    }
    const obj = input as Record<string, unknown>;
    const issues: string[] = [];

    // Reject unknown/unexpected keys unless explicitly allowed (Req 4.2).
    for (const key of Object.keys(obj)) {
      if (!ALLOWED_CONFIG_KEYS.has(key)) {
        issues.push(`unknown config key: ${key}`);
      }
    }

    // url: required, a valid URL, HTTPS-only (Req 4.4).
    const url = obj.url;
    if (typeof url !== 'string' || url.length === 0) {
      issues.push('url is required and must be a non-empty string');
    } else {
      let parsed: URL | undefined;
      try {
        parsed = new URL(url);
      } catch {
        issues.push(`url must be a valid absolute URL (got ${JSON.stringify(url)})`);
      }
      if (parsed !== undefined && parsed.protocol !== 'https:') {
        issues.push(`url must use the https: scheme (got ${parsed.protocol})`);
      }
    }

    // maxContentBytes: required positive finite integer (the acquisition bound, Req 8.1).
    const maxContentBytes = obj.maxContentBytes;
    if (
      typeof maxContentBytes !== 'number' ||
      !Number.isFinite(maxContentBytes) ||
      !Number.isInteger(maxContentBytes) ||
      maxContentBytes <= 0
    ) {
      issues.push('maxContentBytes is required and must be a positive finite integer');
    }

    // timeoutMs: required positive finite number (the finite default timeout, Req 4.4, 12.3).
    const timeoutMs = obj.timeoutMs;
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      issues.push('timeoutMs is required and must be a positive finite number');
    }

    if (issues.length > 0) {
      return { ok: false, issues };
    }
    return {
      ok: true,
      value: {
        url: url as string,
        maxContentBytes: maxContentBytes as number,
        timeoutMs: timeoutMs as number,
      },
    };
  },
};

/**
 * Derive a stable, kebab-case skill name from an HTTPS URL's last path segment.
 *
 * Pure value helper (architecture standard §5). The provider serves a SINGLE skill whose
 * name is the URL basename with any extension stripped (e.g. `.../LICENSE` → `license`,
 * `.../SKILL.md` → `skill`). Falls back to `skill` for an empty/unparseable path so the
 * provider always has a non-empty name to mint an FQID from.
 */
function deriveSkillName(url: string): string {
  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  const segments = pathname.split('/').filter((s) => s.length > 0);
  const last = segments.length > 0 ? segments[segments.length - 1] : '';
  const withoutExt = last.replace(/\.[^.]+$/, '');
  const kebab = (withoutExt || last)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return kebab.length > 0 ? kebab : 'skill';
}

/**
 * A provider that acquires a single skill body over real HTTPS (design §"Components" 4).
 *
 * `id` is derived from the admitted `namespace` (Req 3.5) so the descriptor's namespace and
 * the live provider's identity cannot diverge. Capabilities are declared honestly (Req 7.6):
 * it can `read` and `list` its one skill; it does not implement native `search` or
 * `references`, so the runtime applies its documented fallback rather than invoking them.
 */
export class HttpSkillProvider implements SkillProvider {
  readonly id: string;
  readonly capabilities: SkillProviderCapabilities;

  /** The single skill name this provider mints under its namespace. */
  private readonly skillName: string;
  private readonly credentials: CredentialHeadersProvider;

  constructor(
    private readonly config: HttpProviderConfig,
    ctx: ProviderCreationContext,
  ) {
    // id derived from the admitted namespace (Req 3.5).
    this.id = ctx.namespace;
    this.credentials = ctx.credentials;
    this.skillName = deriveSkillName(config.url);
    // Honest capabilities (Req 7.6): a single-document HTTPS source can read and list its
    // one skill; it offers no keyword index and no reference tree.
    this.capabilities = {
      read: true,
      list: true,
      search: false,
      references: false,
    };
  }

  /** Build the single {@link ResolvedSkill} this provider owns. */
  private resolvedSkill(): ResolvedSkill {
    const source = this.config.url;
    const descriptor: SkillDescriptor = {
      fqid: formatFqid({ provider: this.id, name: this.skillName }),
      name: this.skillName,
      provider: this.id,
      source,
    };
    return {
      descriptor,
      providerId: this.id,
      providerLocalRef: this.config.url, // provider-private fetch target
      provenanceSeed: { source },
    };
  }

  /** Whether `ref` addresses this provider's single skill. */
  private refMatches(ref: SkillRef): boolean {
    switch (ref.kind) {
      case 'name':
        if (ref.provider !== undefined && ref.provider !== this.id) return false;
        return ref.name === this.skillName;
      case 'fqid': {
        const parts = parseFqid(ref.fqid);
        return parts !== null && parts.provider === this.id && parts.name === this.skillName;
      }
      case 'descriptor':
        return ref.descriptor.provider === this.id && ref.descriptor.name === this.skillName;
    }
  }

  async resolve(ref: SkillRef): Promise<ResolvedSkill[]> {
    return this.refMatches(ref) ? [this.resolvedSkill()] : [];
  }

  async list(_input?: ListSkillsInput): Promise<ResolvedSkill[]> {
    return [this.resolvedSkill()];
  }

  /**
   * Acquire the skill body over real HTTPS, bounded and cancellable (Req 7.1, 7.5, 8.1, 12.3).
   *
   * Arms a finite timeout from `config.timeoutMs` and links the OPTIONAL caller `signal`, so
   * the fetch aborts on the first of the deadline or external cancellation. Throws a typed
   * {@link HttpProviderError} on an unavailable origin, a non-2xx status, an over-budget
   * abort, or an over-limit body; the runtime catches it and returns the typed error.
   *
   * The `signal` parameter is an additive optional argument (structurally assignable to the
   * {@link SkillProvider.read} contract signature) used by the runtime / admission seam to
   * thread a parent cancellation; callers that omit it still get the finite default timeout.
   */
  async read(resolved: ResolvedSkill, signal?: AbortSignal): Promise<SkillContent> {
    const controller = new AbortController();
    const onParentAbort = (): void => controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (signal !== undefined) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onParentAbort, { once: true });
    }
    if (!controller.signal.aborted) {
      timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      // Do not keep the event loop alive purely for this timer.
      timer.unref?.();
    }

    try {
      const { headers } = await this.credentials.authorize(this.config.url);
      const response = await fetch(this.config.url, {
        signal: controller.signal,
        ...(headers !== undefined ? { headers } : {}),
      });

      if (!response.ok) {
        throw new HttpProviderError(
          { code: 'provider_error', provider: this.id, message: `HTTPS origin returned status ${response.status}` },
          `HTTPS origin returned status ${response.status} for ${this.config.url}`,
        );
      }

      // Reject before materialization when the origin declares an over-limit size (Req 8.1).
      this.enforceDeclaredSize(response);
      const text = await this.readBounded(response);
      return { descriptor: resolved.descriptor, body: text };
    } catch (err) {
      throw this.toTypedError(err);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener('abort', onParentAbort);
    }
  }

  /**
   * OPTIONAL pre-read size probe (Req 8.1; contract §`readMetadata`).
   *
   * Reports the body size declared at source via `Content-Length` when present, so the
   * runtime can reject an oversize body via the byte-count path BEFORE materialization. A
   * `HEAD`-free probe: it performs a bounded `GET` only to read the declared header, then
   * abandons the body. When the origin declares no size it returns `{ sizeBytes: undefined }`
   * and the runtime falls back to the post-read backstop.
   */
  async readMetadata(_resolved: ResolvedSkill, _reference?: string): Promise<SkillContentMetadata> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    timer.unref?.();
    try {
      const { headers } = await this.credentials.authorize(this.config.url);
      const response = await fetch(this.config.url, {
        method: 'HEAD',
        signal: controller.signal,
        ...(headers !== undefined ? { headers } : {}),
      });
      const declared = response.headers.get('content-length');
      const sizeBytes = declared !== null && Number.isFinite(Number(declared)) ? Number(declared) : undefined;
      return sizeBytes !== undefined ? { sizeBytes } : {};
    } catch {
      // Probe is best-effort: a failure simply opts out and the backstop in read applies.
      return {};
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Reject before materialization when the origin declares an over-limit `Content-Length`
   * (Req 8.1). Returns a sentinel so the caller can proceed to the streaming backstop.
   */
  private enforceDeclaredSize(response: Response): void {
    const declared = response.headers.get('content-length');
    if (declared !== null) {
      const size = Number(declared);
      if (Number.isFinite(size) && size > this.config.maxContentBytes) {
        throw new HttpProviderError(
          { code: 'content_too_large', provider: this.id, limitBytes: this.config.maxContentBytes },
          `declared content length ${size} exceeds maxContentBytes ${this.config.maxContentBytes}`,
        );
      }
    }
  }

  /**
   * Stream-accumulate the response body, enforcing `maxContentBytes` as bytes arrive so a
   * missing/incorrect `Content-Length` cannot smuggle an over-limit payload (Req 8.1).
   */
  private async readBounded(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (reader === undefined) {
      // No readable stream (unusual for fetch): fall back to a bounded text read.
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > this.config.maxContentBytes) {
        throw new HttpProviderError(
          { code: 'content_too_large', provider: this.id, limitBytes: this.config.maxContentBytes },
          `content exceeds maxContentBytes ${this.config.maxContentBytes}`,
        );
      }
      return text;
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    for (; ;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        total += value.byteLength;
        if (total > this.config.maxContentBytes) {
          await reader.cancel();
          throw new HttpProviderError(
            { code: 'content_too_large', provider: this.id, limitBytes: this.config.maxContentBytes },
            `content exceeds maxContentBytes ${this.config.maxContentBytes}`,
          );
        }
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /**
   * Normalize a caught error into a typed {@link HttpProviderError} (Req 7.5). An abort
   * (deadline expiry or external cancellation) and any other fetch fault both map to a
   * `provider_error`; an already-typed {@link HttpProviderError} passes through unchanged.
   */
  private toTypedError(err: unknown): HttpProviderError {
    if (err instanceof HttpProviderError) return err;
    const isAbort =
      err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
    const message = isAbort
      ? `HTTPS fetch aborted (timeout ${this.config.timeoutMs}ms or cancellation) for ${this.config.url}`
      : `HTTPS fetch failed for ${this.config.url}: ${err instanceof Error ? err.message : String(err)}`;
    return new HttpProviderError({ code: 'provider_error', provider: this.id, message }, message);
  }
}

/**
 * The one sanctioned Abstract Factory for the `http` provider (Req 3.2; architecture §7).
 *
 * `id === 'http'` is the {@link ProviderDescriptor.factoryId} that selects this blueprint.
 * `configSchema` is the HTTPS-only {@link httpProviderConfigSchema}; `create` constructs an
 * in-process {@link HttpSkillProvider} from a VALIDATED config and the admission-resolved
 * {@link ProviderCreationContext} (never the raw wire config).
 */
export class HttpSkillProviderBlueprint implements ProviderBlueprint<HttpProviderConfig> {
  readonly id = 'http';
  readonly configSchema: Schema<HttpProviderConfig> = httpProviderConfigSchema;

  create(config: HttpProviderConfig, ctx: ProviderCreationContext): SkillProvider {
    return new HttpSkillProvider(config, ctx);
  }
}
