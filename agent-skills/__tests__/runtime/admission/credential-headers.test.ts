/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Unit tests — credential-headers adapters (CredentialHeadersProvider impls)
// (Milestone-002, Task 7.2; design §"Components" 4 / companion fix 3; Req 7.3).
//
// Subjects under test:
//   - runtime/admission/credential-headers.ts
//       NoCredentialHeadersProvider / noCredentialHeaders   default public-origin adapter
//       RegistryCredentialHeadersProvider                   maps already-authorized result → headers
//
// Behavior verified:
//   - the no-credential adapter yields no headers
//   - the registry adapter maps a token → Authorization header and merges extra headers
//   - an absent authorization yields no headers
//   - a supplied adapter's headers reach the fetch call (asserted via HttpSkillProvider with
//     fetch stubbed — no network, exact header assertion)
//
// Validates: Requirements 7.3, 8.2
// =============================================================================

import {
  AuthorizedAccess,
  NoCredentialHeadersProvider,
  RegistryCredentialHeadersProvider,
  noCredentialHeaders,
} from '../../../runtime/admission/credential-headers.js';
import type {
  CredentialHeadersProvider,
  ProviderCreationContext,
} from '../../../runtime/admission/provider-blueprint.js';
import {
  HttpSkillProvider,
  type HttpProviderConfig,
} from '../../../runtime/providers/http-skill-provider.js';
import { UNTRUSTED_DEFAULT } from '../../../runtime/trust.js';

function makeCtx(
  namespace: string,
  credentials: CredentialHeadersProvider,
): ProviderCreationContext {
  return { namespace, trust: UNTRUSTED_DEFAULT, credentials };
}

function makeConfig(over: Partial<HttpProviderConfig> = {}): HttpProviderConfig {
  return {
    url: 'https://example.com/SKILL.md',
    maxContentBytes: 1_000_000,
    timeoutMs: 5_000,
    ...over,
  };
}

// -----------------------------------------------------------------------------
// No-credential adapter (default for public origins, Req 7.3)
// -----------------------------------------------------------------------------

describe('NoCredentialHeadersProvider — public-origin default yields no headers (Req 7.3)', () => {
  it('resolves to an empty object with no headers key', async () => {
    const result = await noCredentialHeaders.authorize('https://example.com/x');
    expect(result).toEqual({});
    expect(result.headers).toBeUndefined();
  });

  it('yields no headers regardless of the URL', async () => {
    const adapter = new NoCredentialHeadersProvider();
    expect(await adapter.authorize('https://a.example/one')).toEqual({});
    expect(await adapter.authorize('https://b.example/two?q=1')).toEqual({});
  });
});

// -----------------------------------------------------------------------------
// Registry adapter — maps already-authorized result → headers (Req 7.3)
// -----------------------------------------------------------------------------

describe('RegistryCredentialHeadersProvider — maps authorized result to headers (Req 7.3)', () => {
  it('maps a token into an Authorization header (default Bearer scheme)', async () => {
    const adapter = new RegistryCredentialHeadersProvider(async () => ({ token: 'abc123' }));
    const result = await adapter.authorize('https://api.example/skill');
    expect(result).toEqual({ headers: { Authorization: 'Bearer abc123' } });
  });

  it('honors an explicit auth scheme', async () => {
    const adapter = new RegistryCredentialHeadersProvider(async () => ({
      token: 'opaque',
      scheme: 'Token',
    }));
    const result = await adapter.authorize('https://api.example/skill');
    expect(result).toEqual({ headers: { Authorization: 'Token opaque' } });
  });

  it('merges extra already-resolved headers alongside the token', async () => {
    const access: AuthorizedAccess = { token: 't', headers: { 'x-api-key': 'k' } };
    const adapter = new RegistryCredentialHeadersProvider(async () => access);
    const result = await adapter.authorize('https://api.example/skill');
    expect(result).toEqual({ headers: { 'x-api-key': 'k', Authorization: 'Bearer t' } });
  });

  it('passes through header-only access with no token', async () => {
    const adapter = new RegistryCredentialHeadersProvider(async () => ({
      headers: { 'x-api-key': 'only' },
    }));
    expect(await adapter.authorize('https://api.example/skill')).toEqual({
      headers: { 'x-api-key': 'only' },
    });
  });

  it('yields no headers when the registry has no credentials for the URL', async () => {
    const adapter = new RegistryCredentialHeadersProvider(async () => undefined);
    expect(await adapter.authorize('https://public.example/x')).toEqual({});
  });

  it('yields no headers when the authorized result maps to nothing', async () => {
    const adapter = new RegistryCredentialHeadersProvider(async () => ({}));
    expect(await adapter.authorize('https://public.example/x')).toEqual({});
  });

  it('accepts a synchronous authorization source', async () => {
    const adapter = new RegistryCredentialHeadersProvider((url) =>
      url.includes('api') ? { token: 'sync' } : undefined,
    );
    expect(await adapter.authorize('https://api.example/x')).toEqual({
      headers: { Authorization: 'Bearer sync' },
    });
    expect(await adapter.authorize('https://public.example/x')).toEqual({});
  });
});

// -----------------------------------------------------------------------------
// A supplied adapter's headers reach the fetch call (Req 7.3 seam, no network)
// -----------------------------------------------------------------------------

describe("a supplied adapter's headers reach the fetch call (Req 7.3)", () => {
  const realFetch = globalThis.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn(async (_url: string, _init?: RequestInit) =>
      new Response('skill body bytes', { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('passes the registry adapter Authorization header to fetch', async () => {
    const credentials = new RegistryCredentialHeadersProvider(async () => ({ token: 'secret' }));
    const provider = new HttpSkillProvider(makeConfig(), makeCtx('acme', credentials));
    const [resolved] = await provider.list();

    const content = await provider.read(resolved);

    expect(content.body).toBe('skill body bytes');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe('https://example.com/SKILL.md');
    expect(init?.headers).toEqual({ Authorization: 'Bearer secret' });
  });

  it('passes arbitrary supplied headers verbatim to fetch', async () => {
    const credentials: CredentialHeadersProvider = {
      async authorize() {
        return { headers: { 'x-test-credential': 'present' } };
      },
    };
    const provider = new HttpSkillProvider(makeConfig(), makeCtx('acme', credentials));
    const [resolved] = await provider.list();

    await provider.read(resolved);

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toEqual({ 'x-test-credential': 'present' });
  });

  it('omits the headers init entirely for the no-credential default adapter', async () => {
    const provider = new HttpSkillProvider(makeConfig(), makeCtx('acme', noCredentialHeaders));
    const [resolved] = await provider.list();

    await provider.read(resolved);

    const [, init] = fetchMock.mock.calls[0];
    expect(init && 'headers' in init).toBe(false);
  });
});
