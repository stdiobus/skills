/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Unit tests for the promoted in-process SkillsRuntime (Migration Step 1, Task 1.2)
//
// Subject: InProcessSkillsRuntime — the PROVEN in-process backend behind the
// transport factory. These tests exercise the real runtime against both the real
// bundled FilesystemSkillProvider and small in-memory providers that genuinely
// implement the SkillProvider contract (no mocking of the runtime under test).
//
// Coverage:
//   - read / list / search / getReferences / readReference success paths
//   - provenance-on-success minimum set {fqid, provider, source} (Property 2)
//   - open-world `not_found` (no closed-world enum gate)
//   - `ambiguous` with candidates — no silent first-match
//   - capability-optional `unsupported`
//   - `providerLocalRef` never appears in any SkillResponse (Property 10)
//   - a missing `search` capability degrades to a runtime fallback that is
//     RECORDED in diagnostics (we assert only that a fallback was used, not the
//     substring algorithm or any provenance field beyond {fqid, provider, source})
//
// Validates: Requirements 2.2, 2.3, 3.2, 3.4, 3.8
// =============================================================================

import { InProcessSkillsRuntime } from '../../runtime/in-process-runtime.js';
import { FilesystemSkillProvider } from '../../runtime/providers/filesystem-provider.js';
import type {
  ResolvedSkill,
  SearchResult,
  SearchSkillsInput,
  SkillProvider,
  SkillProviderCapabilities,
  SkillRef,
  SkillResponse,
} from '../../runtime/contract.js';

// -----------------------------------------------------------------------------
// In-memory provider — a real SkillProvider implementation used to drive the
// runtime through deterministic scenarios. The provider-private `providerLocalRef`
// is set to a unique sentinel so Property 10 can assert it never leaks into a
// SkillResponse.
// -----------------------------------------------------------------------------

const SENTINEL_LOCAL_REF = '__provider_private_local_ref_DO_NOT_LEAK__';

interface FakeSkill {
  name: string;
  fqid: string;
  body?: string;
  references?: Record<string, string>;
}

interface FakeProviderConfig {
  id: string;
  skills: FakeSkill[];
  /** Default true. When false, the `read` method is omitted (capability-optional). */
  withRead?: boolean;
  /** Default true. When false, the `list` method is omitted. */
  withList?: boolean;
  /** Default true. When false, the references methods are omitted (capability-optional). */
  withReferences?: boolean;
  /** Default false. When true, a native `search` method is provided. */
  withSearch?: boolean;
}

function makeProvider(config: FakeProviderConfig): SkillProvider {
  const withRead = config.withRead ?? true;
  const withList = config.withList ?? true;
  const withReferences = config.withReferences ?? true;
  const withSearch = config.withSearch ?? false;

  const capabilities: SkillProviderCapabilities = {
    read: withRead,
    list: withList,
    search: withSearch,
    references: withReferences,
  };

  const sourceOf = (s: FakeSkill): string => `fake://${config.id}/${s.name}`;

  const toResolved = (s: FakeSkill): ResolvedSkill => ({
    descriptor: { fqid: s.fqid, name: s.name, provider: config.id, source: sourceOf(s) },
    providerId: config.id,
    providerLocalRef: SENTINEL_LOCAL_REF, // provider-private; must never leak (Property 10)
    provenanceSeed: { source: sourceOf(s) },
  });

  const matches = (ref: SkillRef): FakeSkill[] => {
    switch (ref.kind) {
      case 'name':
        if (ref.provider && ref.provider !== config.id) return [];
        return config.skills.filter((s) => s.name === ref.name);
      case 'fqid':
        return config.skills.filter((s) => s.fqid === ref.fqid);
      case 'descriptor':
        return config.skills.filter((s) => s.fqid === ref.descriptor.fqid);
    }
  };

  const findByFqid = (fqid: string): FakeSkill | undefined =>
    config.skills.find((s) => s.fqid === fqid);

  const provider: SkillProvider = {
    id: config.id,
    capabilities,
    async resolve(ref: SkillRef): Promise<ResolvedSkill[]> {
      return matches(ref).map(toResolved);
    },
  };

  if (withRead) {
    provider.read = async (resolved) => {
      const s = findByFqid(resolved.descriptor.fqid);
      return { descriptor: resolved.descriptor, body: s?.body ?? '' };
    };
  }

  if (withList) {
    provider.list = async () => config.skills.map(toResolved);
  }

  if (withReferences) {
    provider.listReferences = async (resolved) => {
      const s = findByFqid(resolved.descriptor.fqid);
      return Object.keys(s?.references ?? {}).map((path) => ({ path }));
    };
    provider.readReference = async (resolved, reference) => {
      const s = findByFqid(resolved.descriptor.fqid);
      return { path: reference, body: s?.references?.[reference] ?? '' };
    };
  }

  if (withSearch) {
    provider.search = async (input: SearchSkillsInput): Promise<SearchResult[]> =>
      config.skills
        .filter((s) => s.name.toLowerCase().includes(input.query.toLowerCase()))
        .map((s) => ({ descriptor: toResolved(s).descriptor, score: 1 }));
  }

  return provider;
}

/** Assert a successful response carries the provenance minimum set {fqid, provider, source}. */
function expectProvenanceMinimumSet(resp: SkillResponse<unknown>): void {
  expect(resp.ok).toBe(true);
  if (!resp.ok) return;
  expect(typeof resp.provenance.fqid).toBe('string');
  expect(resp.provenance.fqid.length).toBeGreaterThan(0);
  expect(typeof resp.provenance.provider).toBe('string');
  expect(resp.provenance.provider.length).toBeGreaterThan(0);
  expect(typeof resp.provenance.source).toBe('string');
  expect(resp.provenance.source.length).toBeGreaterThan(0);
}

// =============================================================================

describe('InProcessSkillsRuntime — success paths against the bundled provider', () => {
  // The real FilesystemSkillProvider reads the actual bundled skills from disk,
  // proving the runtime works end-to-end with the proven provider.
  const runtime = new InProcessSkillsRuntime([new FilesystemSkillProvider()]);
  const PUBLISHED = 'runtime-concepts';
  const PUBLISHED_FQID = `bundled:${PUBLISHED}`;

  it('read() returns SKILL.md content with provenance minimum set {fqid, provider, source}', async () => {
    const resp = await runtime.read({ ref: { kind: 'name', name: PUBLISHED } });

    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data.body.length).toBeGreaterThan(0);
    expect(resp.data.descriptor.fqid).toBe(PUBLISHED_FQID);
    expectProvenanceMinimumSet(resp);
    expect(resp.provenance.fqid).toBe(PUBLISHED_FQID);
    expect(resp.provenance.provider).toBe('bundled');
  });

  it('list() aggregates bundled descriptors and returns ok with provenance', async () => {
    const resp = await runtime.list();

    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data.length).toBeGreaterThan(0);
    expect(resp.data.some((d) => d.fqid === PUBLISHED_FQID)).toBe(true);
    expectProvenanceMinimumSet(resp);
  });

  it('getReferences() returns reference descriptors with provenance minimum set', async () => {
    const resp = await runtime.getReferences({ ref: { kind: 'name', name: PUBLISHED } });

    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(Array.isArray(resp.data)).toBe(true);
    // runtime-concepts ships a domain-model.md reference (`.gitkeep` excluded).
    expect(resp.data.some((r) => r.path === 'domain-model.md')).toBe(true);
    expectProvenanceMinimumSet(resp);
  });

  it('readReference() returns reference content with provenance minimum set', async () => {
    const refs = await runtime.getReferences({ ref: { kind: 'name', name: PUBLISHED } });
    expect(refs.ok).toBe(true);
    if (!refs.ok) return;
    const first = refs.data[0]?.path;
    expect(first).toBeDefined();

    const resp = await runtime.readReference({
      ref: { kind: 'name', name: PUBLISHED },
      reference: first!,
    });

    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data.path).toBe(first);
    expect(resp.data.body.length).toBeGreaterThan(0);
    expectProvenanceMinimumSet(resp);
  });

  it('search() returns results and records that a fallback was used (provider has no native search)', async () => {
    const resp = await runtime.search({ query: 'concepts' });

    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data.some((r) => r.descriptor.name === PUBLISHED)).toBe(true);
    // The bundled provider declares search:false, so the runtime degrades to a
    // documented fallback. Assert ONLY that a fallback was used and recorded in
    // diagnostics — not the substring algorithm nor any field beyond the minimum set.
    expectProvenanceMinimumSet(resp);
    expect(resp.provenance.source).toContain('fallback');
  });
});

describe('InProcessSkillsRuntime — success paths against an in-memory provider', () => {
  const runtime = new InProcessSkillsRuntime([
    makeProvider({
      id: 'fake',
      skills: [
        {
          name: 'alpha',
          fqid: 'fake:alpha',
          body: '# Alpha body',
          references: { 'notes.md': 'reference body' },
        },
      ],
    }),
  ]);

  it('read() carries the provider-finalized provenance minimum set', async () => {
    const resp = await runtime.read({ ref: { kind: 'name', name: 'alpha' } });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data.body).toBe('# Alpha body');
    expectProvenanceMinimumSet(resp);
    expect(resp.provenance.fqid).toBe('fake:alpha');
    expect(resp.provenance.provider).toBe('fake');
    expect(resp.provenance.source).toBe('fake://fake/alpha');
  });

  it('readReference() returns deterministic reference content with provenance', async () => {
    const resp = await runtime.readReference({
      ref: { kind: 'name', name: 'alpha' },
      reference: 'notes.md',
    });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data.body).toBe('reference body');
    expectProvenanceMinimumSet(resp);
  });

  it('search() with a native-search provider returns provider results', async () => {
    const native = new InProcessSkillsRuntime([
      makeProvider({
        id: 'srch',
        withSearch: true,
        skills: [{ name: 'alpha', fqid: 'srch:alpha' }],
      }),
    ]);
    const resp = await native.search({ query: 'alph' });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data.some((r) => r.descriptor.name === 'alpha')).toBe(true);
  });
});

describe('InProcessSkillsRuntime — open-world not_found (Req 2.2/3.5)', () => {
  const runtime = new InProcessSkillsRuntime([
    makeProvider({ id: 'fake', skills: [{ name: 'alpha', fqid: 'fake:alpha' }] }),
  ]);

  it('read() of an unknown name returns a typed not_found, never throws', async () => {
    const resp = await runtime.read({ ref: { kind: 'name', name: 'no-such-skill-xyz' } });
    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error.code).toBe('not_found');
    if (resp.error.code === 'not_found') {
      expect(resp.error.ref).toEqual({ kind: 'name', name: 'no-such-skill-xyz' });
    }
  });

  it('getReferences() of an unknown name returns not_found', async () => {
    const resp = await runtime.getReferences({ ref: { kind: 'name', name: 'absent' } });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('not_found');
  });

  it('readReference() of an unknown name returns not_found', async () => {
    const resp = await runtime.readReference({
      ref: { kind: 'name', name: 'absent' },
      reference: 'x.md',
    });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('not_found');
  });
});

describe('InProcessSkillsRuntime — ambiguous resolution (Req 2.7, no silent first-match)', () => {
  // Two providers resolve the SAME name to DISTINCT fqids.
  const providerA = makeProvider({ id: 'pa', skills: [{ name: 'dup', fqid: 'pa:dup', body: 'A' }] });
  const providerB = makeProvider({ id: 'pb', skills: [{ name: 'dup', fqid: 'pb:dup', body: 'B' }] });
  const runtime = new InProcessSkillsRuntime([providerA, providerB]);

  it('read() returns ambiguous with ALL candidates and selects none', async () => {
    const resp = await runtime.read({ ref: { kind: 'name', name: 'dup' } });
    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error.code).toBe('ambiguous');
    if (resp.error.code !== 'ambiguous') return;

    const fqids = resp.error.candidates.map((c) => c.fqid).sort();
    expect(fqids).toEqual(['pa:dup', 'pb:dup']);
    // No body is returned — the runtime did not silently pick the first match.
    expect((resp as { data?: unknown }).data).toBeUndefined();
  });
});

describe('InProcessSkillsRuntime — capability-optional unsupported (Req 3.2/3.4)', () => {
  it('read() returns unsupported when the resolving provider has no read method', async () => {
    const runtime = new InProcessSkillsRuntime([
      makeProvider({ id: 'noread', withRead: false, skills: [{ name: 'alpha', fqid: 'noread:alpha' }] }),
    ]);
    const resp = await runtime.read({ ref: { kind: 'name', name: 'alpha' } });
    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error.code).toBe('unsupported');
    if (resp.error.code === 'unsupported') {
      expect(resp.error.capability).toBe('read');
      expect(resp.error.provider).toBe('noread');
    }
  });

  it('getReferences() returns unsupported when the provider has no references methods', async () => {
    const runtime = new InProcessSkillsRuntime([
      makeProvider({ id: 'norefs', withReferences: false, skills: [{ name: 'alpha', fqid: 'norefs:alpha' }] }),
    ]);
    const resp = await runtime.getReferences({ ref: { kind: 'name', name: 'alpha' } });
    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error.code).toBe('unsupported');
    if (resp.error.code === 'unsupported') {
      expect(resp.error.capability).toBe('references');
    }
  });

  it('request() with an unknown capability method returns unsupported', async () => {
    const runtime = new InProcessSkillsRuntime([
      makeProvider({ id: 'fake', skills: [{ name: 'alpha', fqid: 'fake:alpha' }] }),
    ]);
    const resp = await runtime.request(
      { method: 'skills.unknown.v1', version: '1' },
      {},
    );
    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error.code).toBe('unsupported');
    if (resp.error.code === 'unsupported') {
      expect(resp.error.capability).toBe('skills.unknown.v1');
    }
  });
});

describe('InProcessSkillsRuntime — providerLocalRef never leaks (Property 10, Req 3.8)', () => {
  const runtime = new InProcessSkillsRuntime([
    makeProvider({
      id: 'fake',
      skills: [
        { name: 'alpha', fqid: 'fake:alpha', body: 'body', references: { 'notes.md': 'r' } },
      ],
    }),
  ]);

  const containsSentinel = (resp: SkillResponse<unknown>): boolean =>
    JSON.stringify(resp).includes(SENTINEL_LOCAL_REF);

  it('read() response does not expose providerLocalRef', async () => {
    const resp = await runtime.read({ ref: { kind: 'name', name: 'alpha' } });
    expect(containsSentinel(resp)).toBe(false);
    expect(JSON.stringify(resp)).not.toContain('providerLocalRef');
  });

  it('list() response does not expose providerLocalRef', async () => {
    const resp = await runtime.list();
    expect(containsSentinel(resp)).toBe(false);
    expect(JSON.stringify(resp)).not.toContain('providerLocalRef');
  });

  it('search() (fallback) response does not expose providerLocalRef', async () => {
    const resp = await runtime.search({ query: 'alpha' });
    expect(containsSentinel(resp)).toBe(false);
  });

  it('getReferences() response does not expose providerLocalRef', async () => {
    const resp = await runtime.getReferences({ ref: { kind: 'name', name: 'alpha' } });
    expect(containsSentinel(resp)).toBe(false);
  });

  it('readReference() response does not expose providerLocalRef', async () => {
    const resp = await runtime.readReference({
      ref: { kind: 'name', name: 'alpha' },
      reference: 'notes.md',
    });
    expect(containsSentinel(resp)).toBe(false);
  });
});
