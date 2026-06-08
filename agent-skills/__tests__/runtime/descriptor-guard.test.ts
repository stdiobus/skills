/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Descriptor identity guard at provider ingress (Task 17)
//
// Subject: InProcessSkillsRuntime + guardDescriptorIdentity (runtime/fqid.ts).
//
// Proves the NARROW descriptor-identity guard (Req 5.7, 1.5) is actually enforced
// at the resolution boundary — not merely defined. A provider returning a
// partial / empty / oversized / inconsistent descriptor is rejected as a returned
// `bad_request` error (never thrown, never admitted), while a provider returning a
// valid, consistent descriptor passes through unchanged.
//
// Scope: identity only (provider/name presence, FQID length bound, declared-fqid
// consistency). The broader all-output content sanitizer is out of scope here.
//
// Validates: Requirements 5.7, 1.5
// =============================================================================

import { InProcessSkillsRuntime } from '../../runtime/in-process-runtime.js';
import { FQID_MAX_BYTES, guardDescriptorIdentity } from '../../runtime/fqid.js';
import type {
  ListSkillsInput,
  ResolvedSkill,
  SearchResult,
  SearchSkillsInput,
  SkillContent,
  SkillDescriptor,
  SkillProvider,
  SkillProviderCapabilities,
  SkillRef,
} from '../../runtime/contract.js';

// -----------------------------------------------------------------------------
// A provider that emits whatever descriptors the test supplies, so we can drive
// the runtime with the exact malformed identities Req 5.7 must reject. Descriptors
// are intentionally typed loosely (`as SkillDescriptor`) because the whole point is
// to model a provider that VIOLATES the descriptor identity contract at runtime.
// -----------------------------------------------------------------------------

interface RawProviderConfig {
  id: string;
  descriptors: SkillDescriptor[];
  /** Default false. When true, a native `search` method is exposed. */
  withSearch?: boolean;
}

function rawProvider(config: RawProviderConfig): SkillProvider {
  const capabilities: SkillProviderCapabilities = {
    read: true,
    list: true,
    search: config.withSearch ?? false,
    references: true,
  };

  const toResolved = (descriptor: SkillDescriptor): ResolvedSkill => ({
    descriptor,
    providerId: config.id,
    providerLocalRef: descriptor.name,
    provenanceSeed: { source: descriptor.source },
  });

  const provider: SkillProvider = {
    id: config.id,
    capabilities,
    async resolve(ref: SkillRef): Promise<ResolvedSkill[]> {
      // Resolve by name (open-world); a name match returns the raw descriptor verbatim.
      const wanted = ref.kind === 'name' ? ref.name : ref.kind === 'fqid' ? ref.fqid : ref.descriptor.name;
      return config.descriptors
        .filter((d) => d.name === wanted || d.fqid === wanted)
        .map(toResolved);
    },
    async read(resolved): Promise<SkillContent> {
      return { descriptor: resolved.descriptor, body: `# ${resolved.descriptor.name}` };
    },
    async list(_input?: ListSkillsInput): Promise<ResolvedSkill[]> {
      return config.descriptors.map(toResolved);
    },
  };

  if (config.withSearch) {
    provider.search = async (_input: SearchSkillsInput): Promise<SearchResult[]> =>
      config.descriptors.map((descriptor) => ({ descriptor, score: 1 }));
  }

  return provider;
}

const validDescriptor = (provider: string, name: string): SkillDescriptor => ({
  fqid: `${provider}:${name}`,
  name,
  provider,
  source: `fake://${provider}/${name}`,
});

// =============================================================================

describe('guardDescriptorIdentity — unit (Req 5.7, 1.5)', () => {
  it('accepts a valid, consistent descriptor (returns null)', () => {
    expect(guardDescriptorIdentity(validDescriptor('ext', 'alpha'))).toBeNull();
  });

  it('accepts a valid versioned descriptor whose fqid carries @version', () => {
    const d: SkillDescriptor = {
      fqid: 'npm:alpha@1.2.3',
      name: 'alpha',
      provider: 'npm',
      source: 'npm://alpha',
    };
    expect(guardDescriptorIdentity(d)).toBeNull();
  });

  it('rejects a descriptor missing provider with bad_request', () => {
    const d = { fqid: ':alpha', name: 'alpha', provider: '', source: 's' } as SkillDescriptor;
    const err = guardDescriptorIdentity(d);
    expect(err?.code).toBe('bad_request');
  });

  it('rejects a descriptor missing name with bad_request', () => {
    const d = { fqid: 'ext:', name: '', provider: 'ext', source: 's' } as SkillDescriptor;
    const err = guardDescriptorIdentity(d);
    expect(err?.code).toBe('bad_request');
  });

  it('rejects a descriptor with an empty fqid (Req 1.5: must carry an FQID)', () => {
    const d = { fqid: '', name: 'alpha', provider: 'ext', source: 's' } as SkillDescriptor;
    const err = guardDescriptorIdentity(d);
    expect(err?.code).toBe('bad_request');
  });

  it('accepts an opaque fqid that diverges from provider:name (federation key)', () => {
    // The runtime treats fqid as an opaque identity key; it need not equal provider:name.
    const d: SkillDescriptor = { fqid: 'dup:x', name: 'alpha', provider: 'ext', source: 's' };
    expect(guardDescriptorIdentity(d)).toBeNull();
  });

  it('rejects a descriptor whose declared fqid exceeds FQID_MAX_BYTES with bad_request', () => {
    const d: SkillDescriptor = {
      fqid: `ext:${'a'.repeat(FQID_MAX_BYTES + 16)}`,
      name: 'alpha',
      provider: 'ext',
      source: 's',
    };
    const err = guardDescriptorIdentity(d);
    expect(err?.code).toBe('bad_request');
  });
});

describe('InProcessSkillsRuntime — single-skill ingress guard (Req 5.7, 1.5)', () => {
  it('read() of a partial descriptor (missing provider) is rejected as bad_request, never thrown', async () => {
    const runtime = new InProcessSkillsRuntime([
      rawProvider({
        id: 'ext',
        descriptors: [{ fqid: ':alpha', name: 'alpha', provider: '', source: 's' } as SkillDescriptor],
      }),
    ]);
    const resp = await runtime.read({ ref: { kind: 'name', name: 'alpha' } });
    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error.code).toBe('bad_request');
  });

  it('read() of an empty-fqid descriptor is rejected as bad_request and not admitted', async () => {
    const runtime = new InProcessSkillsRuntime([
      rawProvider({
        id: 'ext',
        descriptors: [{ fqid: '', name: 'alpha', provider: 'ext', source: 's' } as SkillDescriptor],
      }),
    ]);
    const resp = await runtime.read({ ref: { kind: 'name', name: 'alpha' } });
    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error.code).toBe('bad_request');
    // The invalid descriptor was never admitted: no content escaped the boundary.
    expect((resp as { data?: unknown }).data).toBeUndefined();
  });

  it('read() of an oversized descriptor is rejected as bad_request', async () => {
    const hugeName = 'a'.repeat(FQID_MAX_BYTES + 16);
    const runtime = new InProcessSkillsRuntime([
      rawProvider({
        id: 'ext',
        descriptors: [{ fqid: `ext:${hugeName}`, name: hugeName, provider: 'ext', source: 's' }],
      }),
    ]);
    const resp = await runtime.read({ ref: { kind: 'name', name: hugeName } });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('bad_request');
  });

  it('read() of a valid descriptor passes through unchanged', async () => {
    const runtime = new InProcessSkillsRuntime([
      rawProvider({ id: 'ext', descriptors: [validDescriptor('ext', 'alpha')] }),
    ]);
    const resp = await runtime.read({ ref: { kind: 'name', name: 'alpha' } });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data.body).toBe('# alpha');
    expect(resp.data.descriptor.fqid).toBe('ext:alpha');
    expect(resp.provenance.fqid).toBe('ext:alpha');
  });
});

describe('InProcessSkillsRuntime — aggregate ingress guard preserves partial-failure resilience', () => {
  it('list() records the invalid provider as a bad_request source and still returns the valid provider', async () => {
    const runtime = new InProcessSkillsRuntime([
      rawProvider({ id: 'good', descriptors: [validDescriptor('good', 'alpha')] }),
      rawProvider({
        id: 'bad',
        // Missing provider identity → Req 5.7 rejection, never admitted.
        descriptors: [{ fqid: 'bad:beta', name: 'beta', provider: '', source: 's' } as SkillDescriptor],
      }),
    ]);
    const resp = await runtime.list();
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;

    // The valid provider's descriptor is admitted; the invalid one is not.
    expect(resp.data.map((d) => d.fqid)).toEqual(['good:alpha']);

    const diagnostics = resp.provenance.aggregateDiagnostics as
      | { sources: Array<{ provider: string; ok: boolean; error?: { code: string } }> }
      | undefined;
    expect(diagnostics).toBeDefined();
    const badSource = diagnostics!.sources.find((s) => s.provider === 'bad');
    expect(badSource?.ok).toBe(false);
    expect(badSource?.error?.code).toBe('bad_request');
  });

  it('list() of a sole invalid provider yields aggregate_error preserving the bad_request code', async () => {
    const runtime = new InProcessSkillsRuntime([
      rawProvider({
        id: 'bad',
        descriptors: [{ fqid: '', name: 'beta', provider: 'bad', source: 's' } as SkillDescriptor],
      }),
    ]);
    const resp = await runtime.list();
    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error.code).toBe('aggregate_error');
    if (resp.error.code !== 'aggregate_error') return;
    expect(resp.error.failures.map((f) => f.error.code)).toContain('bad_request');
  });

  it('search() (native) rejects an invalid descriptor as a bad_request source and admits the valid one', async () => {
    const runtime = new InProcessSkillsRuntime([
      rawProvider({ id: 'good', withSearch: true, descriptors: [validDescriptor('good', 'alpha')] }),
      rawProvider({
        id: 'bad',
        withSearch: true,
        // Missing name → Req 5.7 rejection.
        descriptors: [{ fqid: 'bad:alpha', name: '', provider: 'bad', source: 's' } as SkillDescriptor],
      }),
    ]);
    const resp = await runtime.search({ query: 'alpha' });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data.map((r) => r.descriptor.fqid)).toEqual(['good:alpha']);

    const diagnostics = resp.provenance.aggregateDiagnostics as
      | { sources: Array<{ provider: string; ok: boolean; error?: { code: string } }> }
      | undefined;
    const badSource = diagnostics?.sources.find((s) => s.provider === 'bad');
    expect(badSource?.ok).toBe(false);
    expect(badSource?.error?.code).toBe('bad_request');
  });
});
