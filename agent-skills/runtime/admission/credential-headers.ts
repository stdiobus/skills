/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Credential-headers adapters — the concrete {@link CredentialHeadersProvider} implementations
 * (Milestone-002, Task 7.2; design §"Components" 4 / companion fix 3; Req 7.3).
 *
 * The {@link CredentialHeadersProvider} INTERFACE (declared in `provider-blueprint.ts`,
 * Task 2.2) is the auth-reuse seam a provider consumes to obtain request headers. This module
 * supplies the two concrete adapters M-002 ships:
 *
 *   1. {@link NoCredentialHeadersProvider} — the DEFAULT for public origins: yields no
 *      headers. The bundled HTTPS examples (e.g. a public GitHub raw URL) need no credentials,
 *      so this is the provider boundary's least-privilege default.
 *   2. {@link RegistryCredentialHeadersProvider} — maps an ALREADY-AUTHORIZED
 *      `@stdiobus/workers-registry` result into request headers.
 *
 * ─── M-002 IMPLEMENTS NO AUTH OF ITS OWN (Req 7.3, companion fix 3) ─────────────────
 *
 * Neither adapter performs authorization. M-002 implements **no** OAuth, **no** token
 * storage, **no** refresh, and **no** credential lifecycle. {@link RegistryCredentialHeadersProvider}
 * is a thin, pure MAPPING from an authorization result the registry already produced (an
 * {@link AuthorizedAccess}) into the `Authorization` / extra headers a fetch attaches. The
 * `@stdiobus/workers-registry` package is not a build-time dependency of this package; the
 * registry binding is supplied at the boundary as an {@link AuthorizationSource} (a function
 * that returns the already-resolved access for a URL) and plugged in over the bus where a
 * provider requires authentication. This keeps the adapter a transport-agnostic value
 * transform and the dependency direction `providers → admission` intact.
 */

import type { CredentialHeadersProvider } from './provider-blueprint.js';

/**
 * The no-credential adapter for public origins (the M-002 default; Req 7.3).
 *
 * `authorize` always resolves to `{}` (no `headers`): a fetch against a public origin carries
 * no credential headers. Stateless and side-effect-free.
 */
export class NoCredentialHeadersProvider implements CredentialHeadersProvider {
  async authorize(_url: string): Promise<{ headers?: Record<string, string> }> {
    return {};
  }
}

/**
 * The shared default no-credential adapter instance. Use this wherever a public-origin
 * provider is constructed and no authentication is required.
 */
export const noCredentialHeaders: CredentialHeadersProvider = new NoCredentialHeadersProvider();

/**
 * An ALREADY-AUTHORIZED access result this adapter CONSUMES (a structural subset of what
 * `@stdiobus/workers-registry` yields). M-002 maps it to headers; it never produces it.
 *
 * All fields are optional so the shape is forward-compatible with whatever the registry
 * attaches: a ready-to-use `token` (+ optional `scheme`), and/or a bag of already-resolved
 * `headers`. An empty/absent result means "no credentials for this URL".
 */
export interface AuthorizedAccess {
  /** A ready-to-use token already issued by the registry (e.g. a bearer/opaque token). */
  readonly token?: string;
  /** Auth scheme for the `Authorization` header when `token` is present (default `Bearer`). */
  readonly scheme?: string;
  /** Extra already-resolved headers the registry attached (e.g. an API-key header). */
  readonly headers?: Record<string, string>;
}

/**
 * A bound lookup that yields the already-authorized {@link AuthorizedAccess} for a URL, or
 * `undefined` when the registry has no credentials for it. This is the seam the
 * `@stdiobus/workers-registry` binding plugs into; it performs the authorization, the adapter
 * only maps its result.
 */
export type AuthorizationSource = (
  url: string,
) => Promise<AuthorizedAccess | undefined> | AuthorizedAccess | undefined;

/**
 * Maps an already-authorized `@stdiobus/workers-registry` result into request headers
 * (Req 7.3). A thin, pure adapter — it performs **no** authorization, storage, or refresh.
 *
 * Resolution rules (all additive, deterministic):
 *   - a `token` becomes `Authorization: <scheme> <token>` (scheme defaults to `Bearer`);
 *   - any `headers` on the access are merged in (an explicit `Authorization` among them is
 *     preserved unless overridden by a `token`);
 *   - an absent access, or one that maps to no headers, yields `{}` (no headers) — identical
 *     in shape to the {@link NoCredentialHeadersProvider} default.
 */
export class RegistryCredentialHeadersProvider implements CredentialHeadersProvider {
  constructor(private readonly source: AuthorizationSource) { }

  async authorize(url: string): Promise<{ headers?: Record<string, string> }> {
    const access = await this.source(url);
    if (access === undefined) {
      return {};
    }

    const headers: Record<string, string> = { ...(access.headers ?? {}) };
    if (access.token !== undefined) {
      const scheme = access.scheme ?? 'Bearer';
      headers.Authorization = `${scheme} ${access.token}`;
    }

    return Object.keys(headers).length > 0 ? { headers } : {};
  }
}
