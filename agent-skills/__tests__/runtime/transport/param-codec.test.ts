/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Unit tests for ParamCodec — the single transport-boundary validation point
// (Migration Step 5, Task 7.4).
//
// Subject: ParamCodec.decode — the ONE place where params crossing the stdio Bus
// wire are validated before any provider is invoked (Req 10.2, 10.3). These tests
// exercise the real codec (no mocking of the subject) plus a small harness that
// mirrors the PROVEN bus-worker ingress flow (decode → if ok dispatch to runtime,
// else return the typed error) to prove the no-provider-invoked / single-invocation
// guarantees end-to-end.
//
// Coverage:
//   - malformed / non-object params → `bad_request` at decode, NO provider invoked
//     (null, string, number directly fail the non-object guard; an array fails the
//     capability schema — both surface as `bad_request`) (Req 10.5)
//   - schema-invalid input → `bad_request` identifying the failing field(s), with
//     runtime/provider state unchanged (Req 10.4)
//   - valid input decodes and passes through to exactly one provider invocation
//
// Validates: Requirements 10.4, 10.5
// =============================================================================

import { ParamCodec } from '../../../runtime/transport/param-codec.js';
import { InProcessSkillsRuntime } from '../../../runtime/in-process-runtime.js';
import { SkillsCapabilities } from '../../../runtime/capabilities.js';
import type {
  GetReferencesInput,
  ListSkillsInput,
  ReadReferenceInput,
  ReadSkillInput,
  ResolvedSkill,
  SearchResult,
  SearchSkillsInput,
  SkillProvider,
  SkillRef,
  SkillResponse,
} from '../../../runtime/contract.js';

// -----------------------------------------------------------------------------
// Counting provider — a real SkillProvider whose every operation increments a
// per-method counter. It is the instrument that proves:
//   (a) on a decode failure NO provider operation runs (all counters stay 0), and
//   (b) on a valid decoded input the dispatched operation runs exactly once.
// -----------------------------------------------------------------------------

interface ProviderCalls {
  resolve: number;
  read: number;
  list: number;
  search: number;
  listReferences: number;
  readReference: number;
}

function makeCountingProvider(): { provider: SkillProvider; calls: ProviderCalls } {
  const calls: ProviderCalls = {
    resolve: 0,
    read: 0,
    list: 0,
    search: 0,
    listReferences: 0,
    readReference: 0,
  };

  const SKILL = { name: 'alpha', fqid: 'spy:alpha' };
  const source = `spy://${SKILL.name}`;

  const toResolved = (): ResolvedSkill => ({
    descriptor: { fqid: SKILL.fqid, name: SKILL.name, provider: 'spy', source },
    providerId: 'spy',
    provenanceSeed: { source },
  });

  const matches = (ref: SkillRef): boolean => {
    switch (ref.kind) {
      case 'name':
        return (!ref.provider || ref.provider === 'spy') && ref.name === SKILL.name;
      case 'fqid':
        return ref.fqid === SKILL.fqid;
      case 'descriptor':
        return ref.descriptor.fqid === SKILL.fqid;
    }
  };

  const provider: SkillProvider = {
    id: 'spy',
    capabilities: { read: true, list: true, search: true, references: true },
    async resolve(ref: SkillRef): Promise<ResolvedSkill[]> {
      calls.resolve += 1;
      return matches(ref) ? [toResolved()] : [];
    },
    async read(resolved): Promise<{ descriptor: ResolvedSkill['descriptor']; body: string }> {
      calls.read += 1;
      return { descriptor: resolved.descriptor, body: '# Alpha body' };
    },
    async list(): Promise<ResolvedSkill[]> {
      calls.list += 1;
      return [toResolved()];
    },
    async search(input: SearchSkillsInput): Promise<SearchResult[]> {
      calls.search += 1;
      return SKILL.name.includes(input.query)
        ? [{ descriptor: toResolved().descriptor, score: 1 }]
        : [];
    },
    async listReferences(): Promise<{ path: string }[]> {
      calls.listReferences += 1;
      return [{ path: 'notes.md' }];
    },
    async readReference(_resolved, reference): Promise<{ path: string; body: string }> {
      calls.readReference += 1;
      return { path: reference, body: 'reference body' };
    },
  };

  return { provider, calls };
}

const totalCalls = (c: ProviderCalls): number =>
  c.resolve + c.read + c.list + c.search + c.listReferences + c.readReference;

// -----------------------------------------------------------------------------
// Worker-like harness — mirrors agent-skills/runtime/transport/bus-worker.ts
// exactly: run ParamCodec.decode at ingress; on failure return the typed error and
// invoke NO runtime/provider; on success dispatch the decoded input to the runtime.
// This is the production ingress flow with the transport (NDJSON/stdio) stripped.
// -----------------------------------------------------------------------------

function makeHarness(runtime: InProcessSkillsRuntime) {
  const dispatch: Record<string, (input: unknown) => Promise<SkillResponse<unknown>>> = {
    [SkillsCapabilities.read.method]: (i) => runtime.read(i as ReadSkillInput),
    [SkillsCapabilities.list.method]: (i) => runtime.list(i as ListSkillsInput),
    [SkillsCapabilities.search.method]: (i) => runtime.search(i as SearchSkillsInput),
    [SkillsCapabilities.listReferences.method]: (i) =>
      runtime.getReferences(i as GetReferencesInput),
    [SkillsCapabilities.readReference.method]: (i) =>
      runtime.readReference(i as ReadReferenceInput),
  };

  return async (method: string, params: unknown): Promise<SkillResponse<unknown>> => {
    const decoded = ParamCodec.decode(method, params);
    if (!decoded.ok) {
      return { ok: false, error: decoded.error };
    }
    const handler = dispatch[method];
    if (!handler) {
      return { ok: false, error: { code: 'unsupported', capability: method } };
    }
    return handler(decoded.input);
  };
}

const READ = SkillsCapabilities.read.method;
const LIST = SkillsCapabilities.list.method;
const SEARCH = SkillsCapabilities.search.method;

// =============================================================================
// 1) Malformed / non-object params → bad_request at decode, no provider invoked
// =============================================================================

describe('ParamCodec.decode — malformed / non-object params (Req 10.5)', () => {
  it('null params → bad_request from the non-object guard', () => {
    const result = ParamCodec.decode(READ, null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('bad_request');
    if (result.error.code === 'bad_request') {
      expect(result.error.issues).toEqual(['params must be a non-null object']);
    }
  });

  it.each([
    ['string', 'not-an-object'],
    ['number', 42],
    ['boolean', true],
    ['undefined', undefined],
  ])('%s params → bad_request from the non-object guard', (_label, value) => {
    const result = ParamCodec.decode(READ, value as unknown);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('bad_request');
    if (result.error.code === 'bad_request') {
      expect(result.error.issues).toEqual(['params must be a non-null object']);
    }
  });

  it('array params (an object in JS) → bad_request from the capability schema', () => {
    // typeof [] === 'object', so the non-object guard does NOT catch it; the
    // capability schema must reject it because a `{ ref }` object is required.
    const result = ParamCodec.decode(READ, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('bad_request');
    if (result.error.code === 'bad_request') {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('unknown capability method → unsupported (not bad_request)', () => {
    const result = ParamCodec.decode('skills.bogus.v1', { ref: { kind: 'name', name: 'x' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unsupported');
    if (result.error.code === 'unsupported') {
      expect(result.error.capability).toBe('skills.bogus.v1');
    }
  });

  it('through the worker harness, a non-object params decode failure invokes NO provider', async () => {
    const { provider, calls } = makeCountingProvider();
    const harness = makeHarness(new InProcessSkillsRuntime([provider]));

    for (const bad of [null, 'str', 7, [] as unknown]) {
      const resp = await harness(READ, bad);
      expect(resp.ok).toBe(false);
      if (!resp.ok) expect(resp.error.code).toBe('bad_request');
    }

    expect(totalCalls(calls)).toBe(0);
  });
});

// =============================================================================
// 2) Schema-invalid input → bad_request identifying failing fields, state unchanged
// =============================================================================

describe('ParamCodec.decode — schema-invalid input (Req 10.4)', () => {
  it('read with a name ref missing `name` → bad_request naming the failing field', () => {
    const result = ParamCodec.decode(READ, { ref: { kind: 'name' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('bad_request');
    if (result.error.code === 'bad_request') {
      expect(result.error.issues.some((i) => i.includes('ref.name'))).toBe(true);
    }
  });

  it('read with an unknown ref discriminator → bad_request naming the ref discriminator', () => {
    const result = ParamCodec.decode(READ, { ref: { kind: 'bogus' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('bad_request');
    if (result.error.code === 'bad_request') {
      expect(result.error.issues.some((i) => i.includes('ref'))).toBe(true);
    }
  });

  it('search missing the required `query` → bad_request naming `query`', () => {
    const result = ParamCodec.decode(SEARCH, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('bad_request');
    if (result.error.code === 'bad_request') {
      expect(result.error.issues.some((i) => i.includes('query'))).toBe(true);
    }
  });

  it('search with a wrong-typed `query` → bad_request naming `query`', () => {
    const result = ParamCodec.decode(SEARCH, { query: 123 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('bad_request');
    if (result.error.code === 'bad_request') {
      expect(result.error.issues.some((i) => i.includes('query'))).toBe(true);
    }
  });

  it('through the worker harness, a schema-invalid decode invokes NO provider (state unchanged)', async () => {
    const { provider, calls } = makeCountingProvider();
    const harness = makeHarness(new InProcessSkillsRuntime([provider]));

    const resp = await harness(READ, { ref: { kind: 'name' } });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('bad_request');

    // No provider operation ran: the runtime never advanced past the boundary.
    expect(totalCalls(calls)).toBe(0);
  });
});

// =============================================================================
// 3) Valid input decodes and passes through to a single provider invocation
// =============================================================================

describe('ParamCodec.decode — valid input passes through (Req 10.4 happy path)', () => {
  it('valid read params decode to the typed input', () => {
    const input = { ref: { kind: 'name', name: 'alpha' } };
    const result = ParamCodec.decode(READ, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input).toEqual(input);
  });

  it('a valid read flows through the harness and invokes the provider read exactly once', async () => {
    const { provider, calls } = makeCountingProvider();
    const harness = makeHarness(new InProcessSkillsRuntime([provider]));

    const resp = await harness(READ, { ref: { kind: 'name', name: 'alpha' } });

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect((resp.data as { body: string }).body).toBe('# Alpha body');
    }
    // The dispatched capability reached the provider's read exactly once...
    expect(calls.read).toBe(1);
    // ...and no other readable provider operation was invoked as a side effect.
    expect(calls.list).toBe(0);
    expect(calls.search).toBe(0);
    expect(calls.listReferences).toBe(0);
    expect(calls.readReference).toBe(0);
  });

  it('a valid list flows through the harness and invokes the provider list exactly once', async () => {
    const { provider, calls } = makeCountingProvider();
    const harness = makeHarness(new InProcessSkillsRuntime([provider]));

    const resp = await harness(LIST, {});

    expect(resp.ok).toBe(true);
    expect(calls.list).toBe(1);
    expect(calls.resolve).toBe(0);
    expect(calls.read).toBe(0);
  });
});
