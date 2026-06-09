/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Provider-output ingress validation on EVERY operation (Task 6 — T26-minimum).
//
// Subject: InProcessSkillsRuntime wired with a NamespaceOwnershipTable + trustOf, so the
// ProviderOutputValidator is active at the provider-output boundary of every public op:
//   resolve (via read/getReferences/readReference), read, list, search.
//
// For EVERY op (not only admission), each of these provider outputs becomes a typed source
// error AT THAT OP'S BOUNDARY and is NOT exposed (Req 6.1, 6.2, 6.3):
//   1. a malformed descriptor (missing provider)
//   2. an out-of-namespace FQID (Req 5.4, 5.5)
//   3. an oversized payload (oversized body for read/readReference; oversized FQID for
//      list/search/getReferences — descriptors carry no body)
//
// And a well-formed SIBLING provider's output in the SAME aggregate operation (list/search)
// is unaffected by a failing sibling (partial-failure resilience, Req 6.2).
//
// Plus: the single-bundled-provider baseline is unchanged even when an ownership table is
// wired (the bundled provider owns no namespace → exempt; Req 15.2).
//
// Validates: Requirements 6.1, 6.2, 6.3, 5.4, 5.5
// =============================================================================

import fc from 'fast-check';

import { InProcessSkillsRuntime, type TrustLookup } from '../../../runtime/in-process-runtime.js';
import { NamespaceOwnershipTable } from '../../../runtime/admission/namespace-ownership.js';
import { FilesystemSkillProvider } from '../../../runtime/providers/filesystem-provider.js';
import { FQID_MAX_BYTES } from '../../../runtime/fqid.js';
import { UNTRUSTED_DEFAULT, type TrustPolicy } from '../../../runtime/trust.js';
import type {
  ReferenceContent,
  ReferenceDescriptor,
  ResolvedSkill,
  SearchResult,
  SkillContent,
  SkillDescriptor,
  SkillProvider,
  SkillRef,
} from '../../../runtime/contract.js';

// -----------------------------------------------------------------------------
// A configurable, real (non-mock) SkillProvider that returns whatever descriptor / body the
// test supplies, so we can drive the runtime with the exact output a misbehaving provider
// would emit. `resolve` matches a name/fqid ref against the single descriptor it carries.
// -----------------------------------------------------------------------------

interface OutProviderConfig {
  id: string;
  descriptor: SkillDescriptor;
  body?: string;
  references?: ReferenceDescriptor[];
  referenceBody?: string;
  /** Default false. When true, a native `search` method is exposed. */
  withSearch?: boolean;
}

function outProvider(config: OutProviderConfig): SkillProvider {
  const resolved: ResolvedSkill = {
    descriptor: config.descriptor,
    providerId: config.id,
    providerLocalRef: config.descriptor.name,
    provenanceSeed: { source: config.descriptor.source },
  };

  const matches = (ref: SkillRef): boolean => {
    const wanted = ref.kind === 'name' ? ref.name : ref.kind === 'fqid' ? ref.fqid : ref.descriptor.name;
    return config.descriptor.name === wanted || config.descriptor.fqid === wanted;
  };

  const provider: SkillProvider = {
    id: config.id,
    capabilities: { read: true, list: true, search: config.withSearch ?? false, references: true },
    async resolve(ref: SkillRef): Promise<ResolvedSkill[]> {
      return matches(ref) ? [resolved] : [];
    },
    async read(r: ResolvedSkill): Promise<SkillContent> {
      return { descriptor: r.descriptor, body: config.body ?? `# ${r.descriptor.name}` };
    },
    async list(): Promise<ResolvedSkill[]> {
      return [resolved];
    },
    async listReferences(): Promise<ReferenceDescriptor[]> {
      return config.references ?? [{ path: 'ref.md' }];
    },
    async readReference(_r: ResolvedSkill, reference: string): Promise<ReferenceContent> {
      return { path: reference, body: config.referenceBody ?? `# ${reference}` };
    },
  };

  if (config.withSearch) {
    provider.search = async (): Promise<SearchResult[]> => [{ descriptor: config.descriptor, score: 1 }];
  }

  return provider;
}

const valid = (provider: string, name: string, fqid = `${provider}:${name}`): SkillDescriptor => ({
  fqid,
  name,
  provider,
  source: `mem://${provider}/${name}`,
});

/** A descriptor missing its `provider` — a malformed identity the boundary must reject. */
const malformed = (name: string): SkillDescriptor =>
  ({ fqid: `:${name}`, name, provider: '', source: 's' }) as SkillDescriptor;

/** A descriptor whose declared FQID exceeds the interim byte bound (oversized identity). */
const oversizedFqid = (provider: string, name: string): SkillDescriptor =>
  valid(provider, name, `${provider}:${'a'.repeat(FQID_MAX_BYTES + 16)}`);

// A namespace table that grants `acme` to provider `acme`. An out-of-namespace FQID from
// `acme` must be rejected; the bundled / non-admitted providers own nothing → exempt.
function acmeTable(): NamespaceOwnershipTable {
  const table = new NamespaceOwnershipTable();
  table.claim('acme', 'acme');
  return table;
}

// A trust lookup giving `acme` a tiny content budget so oversize bodies trip the size guard,
// and the untrusted default to everyone else.
const tinyBudget: TrustPolicy = { tier: 'untrusted', maxContentBytes: 16, isolateFetch: true };
const trustOf: TrustLookup = (id) => (id === 'acme' ? tinyBudget : UNTRUSTED_DEFAULT);

function runtimeFor(providers: SkillProvider[]): InProcessSkillsRuntime {
  return new InProcessSkillsRuntime(providers, trustOf, acmeTable());
}

// =============================================================================
// resolve / read boundary (single-resolution op)
// =============================================================================

describe('read boundary — every disqualifying output is a typed error, never exposed (Req 6.1)', () => {
  it('malformed descriptor → bad_request, body never read', async () => {
    const rt = runtimeFor([outProvider({ id: 'acme', descriptor: malformed('bad'), body: 'SECRET' })]);
    const resp = await rt.read({ ref: { kind: 'name', name: 'bad' } });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('bad_request');
  });

  it('out-of-namespace FQID → bad_request (Req 5.4, 5.5)', async () => {
    const rt = runtimeFor([outProvider({ id: 'acme', descriptor: valid('acme', 'x', 'evil:x') })]);
    const resp = await rt.read({ ref: { kind: 'name', name: 'x' } });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('bad_request');
  });

  it('oversized body → content_too_large at the content boundary', async () => {
    const rt = runtimeFor([
      outProvider({ id: 'acme', descriptor: valid('acme', 'big'), body: 'x'.repeat(1024) }),
    ]);
    const resp = await rt.read({ ref: { kind: 'name', name: 'big' } });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('content_too_large');
  });

  it('well-formed in-namespace output passes through unchanged', async () => {
    const rt = runtimeFor([outProvider({ id: 'acme', descriptor: valid('acme', 'ok'), body: 'hi' })]);
    const resp = await rt.read({ ref: { kind: 'name', name: 'ok' } });
    expect(resp.ok).toBe(true);
    if (resp.ok) expect(resp.data.body).toBe('hi');
  });
});

// =============================================================================
// getReferences boundary (single-resolution op — descriptor validated at resolve)
// =============================================================================

describe('getReferences boundary — descriptor validated before references exposed (Req 6.3)', () => {
  it('malformed descriptor → bad_request', async () => {
    const rt = runtimeFor([outProvider({ id: 'acme', descriptor: malformed('bad') })]);
    const resp = await rt.getReferences({ ref: { kind: 'name', name: 'bad' } });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('bad_request');
  });

  it('out-of-namespace FQID → bad_request', async () => {
    const rt = runtimeFor([outProvider({ id: 'acme', descriptor: valid('acme', 'x', 'evil:x') })]);
    const resp = await rt.getReferences({ ref: { kind: 'name', name: 'x' } });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('bad_request');
  });

  it('oversized FQID → bad_request (descriptors carry no body)', async () => {
    const rt = runtimeFor([outProvider({ id: 'acme', descriptor: oversizedFqid('acme', 'x') })]);
    const resp = await rt.getReferences({ ref: { kind: 'name', name: 'x' } });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('bad_request');
  });

  it('well-formed in-namespace output exposes references', async () => {
    const rt = runtimeFor([
      outProvider({ id: 'acme', descriptor: valid('acme', 'ok'), references: [{ path: 'a.md' }] }),
    ]);
    const resp = await rt.getReferences({ ref: { kind: 'name', name: 'ok' } });
    expect(resp.ok).toBe(true);
    if (resp.ok) expect(resp.data).toEqual([{ path: 'a.md' }]);
  });
});

// =============================================================================
// readReference boundary (single-resolution op + content boundary)
// =============================================================================

describe('readReference boundary — descriptor + content validated (Req 6.1, 6.3)', () => {
  it('malformed descriptor → bad_request', async () => {
    const rt = runtimeFor([outProvider({ id: 'acme', descriptor: malformed('bad') })]);
    const resp = await rt.readReference({ ref: { kind: 'name', name: 'bad' }, reference: 'r.md' });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('bad_request');
  });

  it('out-of-namespace FQID → bad_request', async () => {
    const rt = runtimeFor([outProvider({ id: 'acme', descriptor: valid('acme', 'x', 'evil:x') })]);
    const resp = await rt.readReference({ ref: { kind: 'name', name: 'x' }, reference: 'r.md' });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('bad_request');
  });

  it('oversized reference body → content_too_large', async () => {
    const rt = runtimeFor([
      outProvider({ id: 'acme', descriptor: valid('acme', 'big'), referenceBody: 'x'.repeat(1024) }),
    ]);
    const resp = await rt.readReference({ ref: { kind: 'name', name: 'big' }, reference: 'r.md' });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('content_too_large');
  });
});

// =============================================================================
// list / search boundary (aggregate ops) — partial-failure resilience (Req 6.2)
// =============================================================================

describe('list boundary — failing source recorded, well-formed sibling unaffected (Req 6.2)', () => {
  it('a malformed sibling is a source error; the well-formed sibling still returns', async () => {
    const good = outProvider({ id: 'acme', descriptor: valid('acme', 'alpha') });
    const bad = outProvider({ id: 'acme', descriptor: malformed('beta') });
    // Two distinct provider objects sharing the `acme` namespace owner; only the malformed
    // one is rejected. (Both are `acme` so the namespace owner gate applies to both.)
    const rt = runtimeFor([good, bad]);
    const resp = await rt.list();
    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const fqids = resp.data.map((d) => d.fqid);
      expect(fqids).toContain('acme:alpha');
      // The malformed descriptor was never admitted.
      expect(fqids).not.toContain(':beta');
    }
  });

  it('an out-of-namespace sibling is a source error; the well-formed sibling still returns', async () => {
    const good = outProvider({ id: 'acme', descriptor: valid('acme', 'alpha') });
    const spoof = outProvider({ id: 'acme', descriptor: valid('acme', 'beta', 'evil:beta') });
    const rt = runtimeFor([good, spoof]);
    const resp = await rt.list();
    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const fqids = resp.data.map((d) => d.fqid);
      expect(fqids).toContain('acme:alpha');
      expect(fqids).not.toContain('evil:beta');
    }
  });

  it('an oversized-FQID sibling is a source error; the well-formed sibling still returns', async () => {
    const good = outProvider({ id: 'acme', descriptor: valid('acme', 'alpha') });
    const big = outProvider({ id: 'acme', descriptor: oversizedFqid('acme', 'beta') });
    const rt = runtimeFor([good, big]);
    const resp = await rt.list();
    expect(resp.ok).toBe(true);
    if (resp.ok) expect(resp.data.map((d) => d.fqid)).toContain('acme:alpha');
  });
});

describe('search boundary — failing source recorded, well-formed sibling unaffected (Req 6.2)', () => {
  it('a malformed native-search sibling is a source error; the well-formed sibling still returns', async () => {
    const good = outProvider({ id: 'acme', descriptor: valid('acme', 'alpha'), withSearch: true });
    const bad = outProvider({ id: 'acme', descriptor: malformed('alpha'), withSearch: true });
    const rt = runtimeFor([good, bad]);
    const resp = await rt.search({ query: 'alpha' });
    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const fqids = resp.data.map((r) => r.descriptor.fqid);
      expect(fqids).toContain('acme:alpha');
      expect(fqids).not.toContain(':alpha');
    }
  });

  it('an out-of-namespace native-search sibling is a source error; the sibling still returns', async () => {
    const good = outProvider({ id: 'acme', descriptor: valid('acme', 'alpha'), withSearch: true });
    const spoof = outProvider({ id: 'acme', descriptor: valid('acme', 'alpha', 'evil:alpha'), withSearch: true });
    const rt = runtimeFor([good, spoof]);
    const resp = await rt.search({ query: 'alpha' });
    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const fqids = resp.data.map((r) => r.descriptor.fqid);
      expect(fqids).toContain('acme:alpha');
      expect(fqids).not.toContain('evil:alpha');
    }
  });
});

// =============================================================================
// Baseline preservation — bundled provider unchanged even with a table wired (Req 15.2)
// =============================================================================

describe('bundled baseline is unchanged even when an ownership table is wired (Req 15.2)', () => {
  const SKILL = 'runtime-concepts';

  it('read/list/search over the bundled provider are identical with vs without a table', async () => {
    const baseline = new InProcessSkillsRuntime([new FilesystemSkillProvider()]);
    const withTable = new InProcessSkillsRuntime(
      [new FilesystemSkillProvider()],
      undefined,
      acmeTable(), // owns `acme`, NOT `bundled` → the bundled provider is exempt
    );

    const [rA, rB] = await Promise.all([
      baseline.read({ ref: { kind: 'name', name: SKILL } }),
      withTable.read({ ref: { kind: 'name', name: SKILL } }),
    ]);
    expect(rA).toEqual(rB);
    expect(rA.ok).toBe(true);

    const [lA, lB] = await Promise.all([baseline.list(), withTable.list()]);
    expect(lA).toEqual(lB);

    const [sA, sB] = await Promise.all([
      baseline.search({ query: 'runtime' }),
      withTable.search({ query: 'runtime' }),
    ]);
    expect(sA).toEqual(sB);
  });
});

// =============================================================================
// PROPERTY — for any op, an out-of-namespace FQID is rejected and an in-namespace one
// is admitted, on the child id, never masked by aggregation (design Property 4 / Req 5.4).
// =============================================================================

const arbName: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
  { minLength: 1, maxLength: 16 },
);
const arbForeign: fc.Arbitrary<string> = arbName.filter((s) => s !== 'acme');

describe('PROPERTY — namespace boundary holds on every op (Req 5.4, 5.5; Property 4)', () => {
  // Generous content budget so the size guard never interferes — this property isolates the
  // NAMESPACE boundary. The namespace table still grants `acme` only the `acme` namespace.
  const generousTrust: TrustLookup = () => UNTRUSTED_DEFAULT;
  const nsRuntime = (providers: SkillProvider[]): InProcessSkillsRuntime =>
    new InProcessSkillsRuntime(providers, generousTrust, acmeTable());

  it('an admitted provider may expose only FQIDs under its own namespace', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbName,
        arbForeign,
        fc.constantFrom<'read' | 'getReferences' | 'list' | 'search'>(
          'read',
          'getReferences',
          'list',
          'search',
        ),
        async (name, foreignPrefix, op) => {
          // In-namespace output: always admitted.
          const inNs = nsRuntime([
            outProvider({ id: 'acme', descriptor: valid('acme', name), withSearch: true }),
          ]);
          // Out-of-namespace output (foreign prefix): always rejected at the boundary.
          const outNs = nsRuntime([
            outProvider({
              id: 'acme',
              descriptor: valid('acme', name, `${foreignPrefix}:${name}`),
              withSearch: true,
            }),
          ]);

          if (op === 'read') {
            const a = await inNs.read({ ref: { kind: 'name', name } });
            const b = await outNs.read({ ref: { kind: 'name', name } });
            expect(a.ok).toBe(true);
            expect(b.ok).toBe(false);
          } else if (op === 'getReferences') {
            const a = await inNs.getReferences({ ref: { kind: 'name', name } });
            const b = await outNs.getReferences({ ref: { kind: 'name', name } });
            expect(a.ok).toBe(true);
            expect(b.ok).toBe(false);
          } else if (op === 'list') {
            const a = await inNs.list();
            const b = await outNs.list();
            // list aggregates: in-namespace fqid present; out-of-namespace fqid never present.
            expect(a.ok && a.data.some((d) => d.fqid === `acme:${name}`)).toBe(true);
            expect(b.ok && b.data.some((d) => d.fqid === `${foreignPrefix}:${name}`)).toBe(false);
          } else {
            const a = await inNs.search({ query: name });
            const b = await outNs.search({ query: name });
            expect(a.ok && a.data.some((r) => r.descriptor.fqid === `acme:${name}`)).toBe(true);
            expect(b.ok && b.data.some((r) => r.descriptor.fqid === `${foreignPrefix}:${name}`)).toBe(false);
          }
        },
      ),
      { numRuns: 80 },
    );
  });
});
