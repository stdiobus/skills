/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Unit tests — HttpSkillProvider.read bounded-retry resilience
// (Milestone-002 amendment, Task U4; R&D Inv 10 — "HTTPS acquisition uses standard
// resilience only": try/catch + bounded retry + clear typed error, nothing more).
//
// Subject under test:
//   - runtime/providers/http-skill-provider.ts → HttpSkillProvider.read
//
// Behavior verified:
//   - a TRANSIENT network failure is retried a bounded number of times, then succeeds
//   - a PERSISTENT transient failure exhausts the bounded budget and returns a clear typed
//     error with readable text (thrown, then caught by the runtime — never across the seam)
//   - a TERMINAL non-2xx (404) is NOT retried (one fetch), surfacing a typed provider_error
//   - a 5xx is classified transient and retried; a 429 likewise
//   - the single-fetch HAPPY PATH performs exactly one fetch (unchanged)
//
// These tests STUB global.fetch (no network, no localhost) so the retry classification and
// attempt count are asserted deterministically.
//
// Validates: Requirements 7.5, 8.1
// =============================================================================

import type {
  CredentialHeadersProvider,
  ProviderCreationContext,
} from '../../../runtime/admission/provider-blueprint.js';
import {
  HttpProviderError,
  HttpSkillProvider,
  type HttpProviderConfig,
} from '../../../runtime/providers/http-skill-provider.js';
import { UNTRUSTED_DEFAULT } from '../../../runtime/trust.js';

const TEST_URL = 'https://example.com/skills/widget';

/** The no-credential adapter (public origins): yields no headers, no network. */
const noCredentials: CredentialHeadersProvider = {
  async authorize(_url: string) {
    return {};
  },
};

function makeCtx(namespace = 'acme'): ProviderCreationContext {
  return { namespace, trust: UNTRUSTED_DEFAULT, credentials: noCredentials };
}

function makeConfig(over: Partial<HttpProviderConfig> = {}): HttpProviderConfig {
  return { url: TEST_URL, maxContentBytes: 1_000_000, timeoutMs: 5_000, ...over };
}

/**
 * A minimal `Response`-like object whose body is read via the `response.text()` backstop
 * (no `body` stream), with a `content-length`-free header bag. Sufficient for the provider's
 * `read` happy path under a stubbed `fetch`.
 */
function okResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (_name: string): string | null => null },
    body: undefined,
    text: async () => body,
  } as unknown as Response;
}

/** A non-2xx `Response`-like object with the given status. */
function statusResponse(status: number): Response {
  return {
    ok: false,
    status,
    headers: { get: (_name: string): string | null => null },
    body: undefined,
    text: async () => '',
  } as unknown as Response;
}

/** A transient network-level failure, as the platform `fetch` throws on a connection fault. */
function networkError(): Error {
  return new TypeError('fetch failed');
}

describe('HttpSkillProvider.read — bounded retry on transient faults (Task U4; Req 7.5, 8.1)', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('retries a transient network failure and then succeeds (bounded recovery)', async () => {
    // Two transient failures, then a success — within the 3-attempt budget.
    fetchSpy
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce(okResponse('GNU GENERAL PUBLIC LICENSE'));

    const provider = new HttpSkillProvider(makeConfig(), makeCtx());
    const [resolved] = await provider.list();

    const content = await provider.read(resolved);

    expect(content.body).toContain('GNU GENERAL PUBLIC LICENSE');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('exhausts the bounded budget on a persistent transient failure and returns a clear typed error', async () => {
    fetchSpy.mockRejectedValue(networkError());

    const provider = new HttpSkillProvider(makeConfig(), makeCtx());
    const [resolved] = await provider.list();

    try {
      await provider.read(resolved);
      throw new Error('expected read to reject after exhausting the retry budget');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpProviderError);
      const typed = err as HttpProviderError;
      expect(typed.runtimeError.code).toBe('provider_error');
      // Readable, origin-identifying text (Req 7.5).
      expect(typed.message).toContain(TEST_URL);
    }
    // Exactly the bounded attempt count — no unbounded looping.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a terminal non-2xx (404) — a definitive client error', async () => {
    fetchSpy.mockResolvedValue(statusResponse(404));

    const provider = new HttpSkillProvider(makeConfig(), makeCtx());
    const [resolved] = await provider.list();

    try {
      await provider.read(resolved);
      throw new Error('expected read to reject on 404');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpProviderError);
      expect((err as HttpProviderError).runtimeError.code).toBe('provider_error');
      expect((err as HttpProviderError).message).toContain('404');
    }
    // Terminal status → single attempt, no retry.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retries a transient 5xx server error and then succeeds', async () => {
    fetchSpy
      .mockResolvedValueOnce(statusResponse(503))
      .mockResolvedValueOnce(okResponse('recovered body'));

    const provider = new HttpSkillProvider(makeConfig(), makeCtx());
    const [resolved] = await provider.list();

    const content = await provider.read(resolved);

    expect(content.body).toBe('recovered body');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('retries a transient 429 (too many requests) and then succeeds', async () => {
    fetchSpy
      .mockResolvedValueOnce(statusResponse(429))
      .mockResolvedValueOnce(okResponse('after backoff'));

    const provider = new HttpSkillProvider(makeConfig(), makeCtx());
    const [resolved] = await provider.list();

    const content = await provider.read(resolved);

    expect(content.body).toBe('after backoff');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('leaves the single-fetch happy path unchanged: exactly one fetch on first success', async () => {
    fetchSpy.mockResolvedValueOnce(okResponse('first-try body'));

    const provider = new HttpSkillProvider(makeConfig(), makeCtx());
    const [resolved] = await provider.list();

    const content = await provider.read(resolved);

    expect(content.body).toBe('first-try body');
    expect(content.descriptor.fqid).toBe('acme:widget');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
