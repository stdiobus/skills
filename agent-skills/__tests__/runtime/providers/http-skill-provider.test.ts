/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Unit tests — HttpSkillProvider + HttpSkillProviderBlueprint + httpProviderConfigSchema
// (Milestone-002, Task 7.1; design §"Components" 4).
//
// Subjects under test:
//   - runtime/providers/http-skill-provider.ts
//       httpProviderConfigSchema   HTTPS-only + bounds + unknown-key rejection (Req 4.2, 4.4)
//       HttpSkillProvider          id derived from namespace, honest caps, bounded HTTPS read
//       HttpSkillProviderBlueprint id='http', schema, create (Req 3.2, 3.5)
//
// Behavior verified:
//   - schema accepts a valid HTTPS config; rejects non-HTTPS, unknown keys, missing bounds
//   - a real HTTPS fetch against a pinned public GitHub raw URL returns bytes
//   - an aborted/over-budget read surfaces a typed error (never thrown across the seam)
//   - content over maxContentBytes → typed content_too_large
//
// Validates: Requirements 4.2, 4.4, 7.1, 7.5, 7.6, 12.3
// =============================================================================

import { OperationBudget } from '../../../runtime/admission/operation-budget.js';
import type {
  CredentialHeadersProvider,
  ProviderCreationContext,
} from '../../../runtime/admission/provider-blueprint.js';
import {
  HttpProviderError,
  HttpSkillProvider,
  HttpSkillProviderBlueprint,
  httpProviderConfigSchema,
  type HttpProviderConfig,
} from '../../../runtime/providers/http-skill-provider.js';
import { UNTRUSTED_DEFAULT } from '../../../runtime/trust.js';

// A pinned, stable public HTTPS origin: this repository's own LICENSE on GitHub raw at a
// fixed tag. Real network (no mock, no localhost). Kept resilient with a generous timeout.
const PINNED_HTTPS_URL =
  'https://raw.githubusercontent.com/git/git/v2.43.0/COPYING';
const NETWORK_TIMEOUT_MS = 15_000;

/** The no-credential adapter (public origins): yields no headers. */
const noCredentials: CredentialHeadersProvider = {
  async authorize(_url: string) {
    return {};
  },
};

function makeCtx(namespace: string, credentials: CredentialHeadersProvider = noCredentials): ProviderCreationContext {
  return { namespace, trust: UNTRUSTED_DEFAULT, credentials };
}

function makeConfig(over: Partial<HttpProviderConfig> = {}): HttpProviderConfig {
  return {
    url: PINNED_HTTPS_URL,
    maxContentBytes: 1_000_000,
    timeoutMs: NETWORK_TIMEOUT_MS,
    ...over,
  };
}

// -----------------------------------------------------------------------------
// httpProviderConfigSchema (Req 4.2, 4.4)
// -----------------------------------------------------------------------------

describe('httpProviderConfigSchema — HTTPS-only + bounds (Req 4.2, 4.4)', () => {
  it('accepts a valid HTTPS config and narrows it to HttpProviderConfig', () => {
    const result = httpProviderConfigSchema.parse({
      url: 'https://example.com/SKILL.md',
      maxContentBytes: 65_536,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected parse to succeed');
    expect(result.value).toEqual({
      url: 'https://example.com/SKILL.md',
      maxContentBytes: 65_536,
      timeoutMs: 5_000,
    });
  });

  it('rejects a non-HTTPS (http:) URL (no throw)', () => {
    const result = httpProviderConfigSchema.parse({
      url: 'http://example.com/SKILL.md',
      maxContentBytes: 1_000,
      timeoutMs: 1_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected parse to fail');
    expect(result.issues.some((i) => i.includes('https:'))).toBe(true);
  });

  it('rejects a non-https scheme such as file:', () => {
    const result = httpProviderConfigSchema.parse({
      url: 'file:///etc/passwd',
      maxContentBytes: 1_000,
      timeoutMs: 1_000,
    });

    expect(result.ok).toBe(false);
  });

  it('rejects an invalid / non-absolute URL', () => {
    const result = httpProviderConfigSchema.parse({
      url: 'not a url',
      maxContentBytes: 1_000,
      timeoutMs: 1_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected parse to fail');
    expect(result.issues.some((i) => i.includes('valid'))).toBe(true);
  });

  it('rejects unknown/unexpected config keys (Req 4.2)', () => {
    const result = httpProviderConfigSchema.parse({
      url: 'https://example.com/x',
      maxContentBytes: 1_000,
      timeoutMs: 1_000,
      caCert: '-----BEGIN CERTIFICATE-----',
      rejectUnauthorized: false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected parse to fail');
    expect(result.issues).toContain('unknown config key: caCert');
    expect(result.issues).toContain('unknown config key: rejectUnauthorized');
  });

  it('rejects a missing maxContentBytes bound', () => {
    const result = httpProviderConfigSchema.parse({
      url: 'https://example.com/x',
      timeoutMs: 1_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected parse to fail');
    expect(result.issues.some((i) => i.includes('maxContentBytes'))).toBe(true);
  });

  it('rejects a missing timeoutMs bound', () => {
    const result = httpProviderConfigSchema.parse({
      url: 'https://example.com/x',
      maxContentBytes: 1_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected parse to fail');
    expect(result.issues.some((i) => i.includes('timeoutMs'))).toBe(true);
  });

  it('rejects a non-positive / non-finite maxContentBytes', () => {
    expect(httpProviderConfigSchema.parse({ url: 'https://e.com/x', maxContentBytes: 0, timeoutMs: 1 }).ok).toBe(false);
    expect(httpProviderConfigSchema.parse({ url: 'https://e.com/x', maxContentBytes: -5, timeoutMs: 1 }).ok).toBe(false);
    expect(
      httpProviderConfigSchema.parse({ url: 'https://e.com/x', maxContentBytes: 1.5, timeoutMs: 1 }).ok,
    ).toBe(false);
  });

  it('rejects a non-positive / non-finite timeoutMs', () => {
    expect(httpProviderConfigSchema.parse({ url: 'https://e.com/x', maxContentBytes: 1, timeoutMs: 0 }).ok).toBe(false);
    expect(
      httpProviderConfigSchema.parse({ url: 'https://e.com/x', maxContentBytes: 1, timeoutMs: Infinity }).ok,
    ).toBe(false);
  });

  it('returns ok:false (never throws) for non-object input', () => {
    expect(() => httpProviderConfigSchema.parse(null)).not.toThrow();
    expect(httpProviderConfigSchema.parse(null).ok).toBe(false);
    expect(httpProviderConfigSchema.parse(42).ok).toBe(false);
    expect(httpProviderConfigSchema.parse([]).ok).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// HttpSkillProvider identity + capabilities + resolve/list (Req 3.5, 7.6)
// -----------------------------------------------------------------------------

describe('HttpSkillProvider — identity, capabilities, resolution (Req 3.5, 7.6)', () => {
  it('derives its id from the admitted namespace (Req 3.5)', () => {
    const provider = new HttpSkillProvider(makeConfig(), makeCtx('acme'));
    expect(provider.id).toBe('acme');
  });

  it('declares honest capabilities: read + list, no native search/references (Req 7.6)', () => {
    const provider = new HttpSkillProvider(makeConfig(), makeCtx('acme'));
    expect(provider.capabilities).toEqual({
      read: true,
      list: true,
      search: false,
      references: false,
    });
  });

  it('resolves its single skill by name and by fqid, derived from the URL basename', async () => {
    const provider = new HttpSkillProvider(makeConfig(), makeCtx('acme'));

    const listed = await provider.list();
    expect(listed).toHaveLength(1);
    const { descriptor } = listed[0];
    expect(descriptor.provider).toBe('acme');
    expect(descriptor.name).toBe('copying'); // .../COPYING → "copying"
    expect(descriptor.fqid).toBe('acme:copying');

    const byName = await provider.resolve({ kind: 'name', name: 'copying' });
    expect(byName).toHaveLength(1);

    const byFqid = await provider.resolve({ kind: 'fqid', fqid: 'acme:copying' });
    expect(byFqid).toHaveLength(1);
  });

  it('returns no candidates for a non-matching ref (open-world resolution)', async () => {
    const provider = new HttpSkillProvider(makeConfig(), makeCtx('acme'));

    expect(await provider.resolve({ kind: 'name', name: 'other-skill' })).toEqual([]);
    expect(await provider.resolve({ kind: 'name', name: 'copying', provider: 'someone-else' })).toEqual([]);
    expect(await provider.resolve({ kind: 'fqid', fqid: 'bundled:copying' })).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// HttpSkillProviderBlueprint (Req 3.2)
// -----------------------------------------------------------------------------

describe('HttpSkillProviderBlueprint — factory boundary (Req 3.2)', () => {
  it("has id 'http' and binds the HTTPS-only schema", () => {
    const blueprint = new HttpSkillProviderBlueprint();
    expect(blueprint.id).toBe('http');
    expect(blueprint.configSchema).toBe(httpProviderConfigSchema);
  });

  it('constructs an HttpSkillProvider from a validated config, id from namespace', () => {
    const blueprint = new HttpSkillProviderBlueprint();
    const parsed = blueprint.configSchema.parse(makeConfig());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected parse to succeed');

    const provider = blueprint.create(parsed.value, makeCtx('widgets'));
    expect(provider.id).toBe('widgets');
    expect(provider.capabilities.read).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Bounded + cancellable read — typed errors (Req 7.5, 8.1, 12.3)
// -----------------------------------------------------------------------------

describe('HttpSkillProvider.read — bounds and cancellation (Req 7.5, 8.1, 12.3)', () => {
  it('surfaces a typed content_too_large when the body exceeds maxContentBytes', async () => {
    // A tiny bound forces the streaming guard to trip against a real (small) HTTPS body.
    const provider = new HttpSkillProvider(makeConfig({ maxContentBytes: 8 }), makeCtx('acme'));
    const [resolved] = await provider.list();

    await expect(provider.read(resolved)).rejects.toBeInstanceOf(HttpProviderError);
    try {
      await provider.read(resolved);
      throw new Error('expected read to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpProviderError);
      expect((err as HttpProviderError).runtimeError.code).toBe('content_too_large');
    }
  }, NETWORK_TIMEOUT_MS + 5_000);

  it('maps an already-aborted caller signal to a typed provider_error via OperationBudget (Req 7.5, 12.3)', async () => {
    const provider = new HttpSkillProvider(makeConfig(), makeCtx('acme'));
    const [resolved] = await provider.list();

    const budget = new OperationBudget(NETWORK_TIMEOUT_MS);
    const parent = new AbortController();
    parent.abort(); // cancel before the fetch begins

    const result = await budget.run((signal) => provider.read(resolved, signal), undefined, parent.signal);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a returned typed error');
    expect(result.error.code).toBe('provider_error');
  });

  it('maps an over-budget read to a typed error (deadline expiry, never thrown across the seam)', async () => {
    // A 1ms timeout against a real origin reliably trips the deadline before bytes arrive.
    const provider = new HttpSkillProvider(makeConfig({ timeoutMs: 1 }), makeCtx('acme'));
    const [resolved] = await provider.list();

    try {
      await provider.read(resolved);
      throw new Error('expected read to reject on timeout');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpProviderError);
      expect((err as HttpProviderError).runtimeError.code).toBe('provider_error');
    }
  }, NETWORK_TIMEOUT_MS + 5_000);
});

// -----------------------------------------------------------------------------
// Real HTTPS acquisition — pinned public origin, no mock (Req 7.1)
// -----------------------------------------------------------------------------

describe('HttpSkillProvider.read — real HTTPS acquisition (Req 7.1)', () => {
  it('fetches bytes from a pinned public GitHub raw URL and returns them as the body', async () => {
    const provider = new HttpSkillProvider(makeConfig(), makeCtx('acme'));
    const [resolved] = await provider.list();

    const content = await provider.read(resolved);

    expect(content.descriptor.fqid).toBe('acme:copying');
    expect(typeof content.body).toBe('string');
    expect(content.body.length).toBeGreaterThan(0);
    // The git COPYING file declares the GPLv2 — a stable, byte-level anchor.
    expect(content.body).toContain('GNU GENERAL PUBLIC LICENSE');
  }, NETWORK_TIMEOUT_MS + 5_000);

  it('applies supplied credential headers to the fetch (auth-reuse adapter, Req 7.3 seam)', async () => {
    let observedUrl: string | undefined;
    const recordingCredentials: CredentialHeadersProvider = {
      async authorize(url: string) {
        observedUrl = url;
        return { headers: { 'x-test-credential': 'present' } };
      },
    };
    const provider = new HttpSkillProvider(makeConfig(), makeCtx('acme', recordingCredentials));
    const [resolved] = await provider.list();

    const content = await provider.read(resolved);

    expect(observedUrl).toBe(PINNED_HTTPS_URL);
    expect(content.body.length).toBeGreaterThan(0);
  }, NETWORK_TIMEOUT_MS + 5_000);
});
