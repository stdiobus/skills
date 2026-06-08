/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Unit tests — provider federation aggregate envelope for `list` / `search`
// (Migration Step 6, Task 8.4; design §4b).
//
// Subjects under test (already implemented — NOT redefined here):
//   - InProcessSkillsRuntime.list / .search  (runtime/in-process-runtime.ts)
//       implementing the 8.2 aggregation algorithm + 8.3 result polarity.
//   - readAggregateDiagnostics / AGGREGATE_DIAGNOSTICS_KEY (runtime/federation.ts)
// driven through the REAL InProcessSkillsRuntime over small in-memory
// SkillProviders (no mocking of the runtime under test).
//
// Cases validated (design §4b step 4 polarity + diagnostics):
//   1. Partial failure → `ok: true`; `aggregateDiagnostics.sources` records the
//      failing provider's identity + error code AND the succeeding provider's
//      ok + count; data carries only the succeeding provider's descriptors
//      (Req 4.3, 4.6).
//   2. Every supporting provider failed → `ok: false` `aggregate_error` whose
//      `failures` preserves each provider's identity + error code (Req 4.8).
//   3. Supported but zero results → `ok: true` empty, with sources recording
//      ok:true count:0 (Req 4.7).
//   4. Same FQID, differing content → `ok: true`; deduped data keeps ONE entry
//      (first occurrence, no silent pick); `aggregateDiagnostics.conflicts`
//      names the shared FQID and both providers (Req 4.2, 4.4).
//   5. Zero supporting providers (none declare `capabilities.list`) → `ok: false`
//      `unsupported` naming capability `list` (Req 3.4).
//   6. (bonus) search with no native provider degrades to the list+substring
//      fallback and records `fallbacksApplied` (Req 3.3) — diagnostics check.
//
// Validates: Requirements 4.3, 4.4, 4.6, 4.7, 4.8
// =============================================================================

import { InProcessSkillsRuntime } from '../../runtime/in-process-runtime.js';
import { readAggregateDiagnostics } from '../../runtime/federation.js';
import type {
  ResolvedSkill,
  SkillDescriptor,
  SkillProvider,
  SkillRef,
} from '../../runtime/contract.js';

// -----------------------------------------------------------------------------
// In-memory provider helpers.
//
// `makeResolved` mints a ResolvedSkill from a descriptor; `listProvider` builds a
// real SkillProvider whose `list` either returns a fixed ResolvedSkill[] or throws
// (the only way a list provider surfaces failure — caught by the runtime and
// recorded as a `provider_error` source). `capList` toggles the declared
// capability so the "zero supporting providers" branch can be exercised.
// -----------------------------------------------------------------------------

function desc(provider: string, name: string, extra: Partial<SkillDescriptor> = {}): SkillDescriptor {
  return {
    fqid: `${provider}:${name}`,
    name,
    provider,
    source: `fake://${provider}/${name}`,
    ...extra,
  };
}

function makeResolved(providerId: string, descriptor: SkillDescriptor): ResolvedSkill {
  return {
    descriptor,
    providerId,
    providerLocalRef: '__private__',
    provenanceSeed: { source: descriptor.source },
  };
}

interface ListProviderOpts {
  /** Fixed list result, or 'throw' to make `list()` throw (→ provider_error source). */
  list: ResolvedSkill[] | 'throw';
  /** Whether the provider DECLARES `capabilities.list` (and exposes a `list` method). */
  capList?: boolean;
}

function listProvider(id: string, opts: ListProviderOpts): SkillProvider {
  const capList = opts.capList ?? true;
  const backing = opts.list === 'throw' ? [] : opts.list;

  const provider: SkillProvider = {
    id,
    capabilities: { read: false, list: capList, search: false, references: false },
    async resolve(ref: SkillRef): Promise<ResolvedSkill[]> {
      switch (ref.kind) {
        case 'name':
          if (ref.provider && ref.provider !== id) return [];
          return backing.filter((r) => r.descriptor.name === ref.name);
        case 'fqid':
          return backing.filter((r) => r.descriptor.fqid === ref.fqid);
        case 'descriptor':
          return backing.filter((r) => r.descriptor.fqid === ref.descriptor.fqid);
      }
    },
  };

  if (capList) {
    provider.list = async (): Promise<ResolvedSkill[]> => {
      if (opts.list === 'throw') throw new Error(`${id}.list intentionally threw`);
      return opts.list;
    };
  }

  return provider;
}

// =============================================================================
// Case 1 — partial failure → ok:true, failing source recorded, partial data
// (Req 4.3, 4.6)
// =============================================================================

describe('list aggregation — partial failure resilience (Req 4.3, 4.6)', () => {
  it('returns ok:true with the surviving provider data and records the failing source', async () => {
    const okSkill = desc('ok', 'alpha');
    const runtime = new InProcessSkillsRuntime([
      listProvider('ok', { list: [makeResolved('ok', okSkill)] }),
      listProvider('boom', { list: 'throw' }),
    ]);

    const resp = await runtime.list();

    // One provider failed, one succeeded → partial success, not a collapse.
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;

    // Data carries ONLY the succeeding provider's descriptor.
    expect(resp.data.map((d) => d.fqid)).toEqual(['ok:alpha']);

    const diag = readAggregateDiagnostics(resp.provenance);
    expect(diag).toBeDefined();
    if (!diag) return;

    // Failing provider's identity + error code are recorded in sources.
    const failing = diag.sources.find((s) => s.provider === 'boom');
    expect(failing).toBeDefined();
    expect(failing!.ok).toBe(false);
    expect(failing!.error?.code).toBe('provider_error');
    if (failing!.error?.code === 'provider_error') {
      expect(failing!.error.provider).toBe('boom');
    }

    // Succeeding provider's outcome is recorded with its count.
    const succeeding = diag.sources.find((s) => s.provider === 'ok');
    expect(succeeding).toBeDefined();
    expect(succeeding!.ok).toBe(true);
    expect(succeeding!.count).toBe(1);

    expect(diag.conflicts).toEqual([]);
  });
});

// =============================================================================
// Case 2 — every supporting provider failed → aggregate_error preserving codes
// (Req 4.8)
// =============================================================================

describe('list aggregation — all supporting providers failed (Req 4.8)', () => {
  it('returns ok:false aggregate_error preserving each provider identity + code', async () => {
    const runtime = new InProcessSkillsRuntime([
      listProvider('boom-a', { list: 'throw' }),
      listProvider('boom-b', { list: 'throw' }),
    ]);

    const resp = await runtime.list();

    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error.code).toBe('aggregate_error');
    if (resp.error.code !== 'aggregate_error') return;

    // Each failed provider's identity + error code is preserved in `failures`.
    expect(resp.error.failures).toHaveLength(2);
    const byProvider = new Map(resp.error.failures.map((f) => [f.provider, f]));
    expect([...byProvider.keys()].sort()).toEqual(['boom-a', 'boom-b']);
    for (const provider of ['boom-a', 'boom-b']) {
      expect(byProvider.get(provider)!.error.code).toBe('provider_error');
    }
  });
});

// =============================================================================
// Case 3 — supported but zero results → ok:true empty (Req 4.7)
// =============================================================================

describe('list aggregation — supported but zero results (Req 4.7)', () => {
  it('returns ok:true with an empty collection and a count:0 source', async () => {
    const runtime = new InProcessSkillsRuntime([listProvider('empty', { list: [] })]);

    const resp = await runtime.list();

    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data).toEqual([]);

    const diag = readAggregateDiagnostics(resp.provenance);
    expect(diag).toBeDefined();
    if (!diag) return;
    const source = diag.sources.find((s) => s.provider === 'empty');
    expect(source).toBeDefined();
    expect(source!.ok).toBe(true);
    expect(source!.count).toBe(0);
    expect(diag.conflicts).toEqual([]);
  });
});

// =============================================================================
// Case 4 — same FQID, differing content → conflict surfaced, no silent pick
// (Req 4.2, 4.4)
// =============================================================================

describe('list aggregation — same FQID differing content (Req 4.2, 4.4)', () => {
  it('keeps the first occurrence and surfaces a conflict naming both providers', async () => {
    const SHARED = 'shared:dup';
    // Two providers each emit a descriptor with the SAME fqid but differing
    // content (distinct provider identity + layer), so dedupe must surface a
    // conflict rather than silently collapse to one.
    const first = makeResolved('p1', {
      fqid: SHARED,
      name: 'dup',
      provider: 'p1',
      source: 'fake://p1/dup',
      layer: 1,
    });
    const second = makeResolved('p2', {
      fqid: SHARED,
      name: 'dup',
      provider: 'p2',
      source: 'fake://p2/dup',
      layer: 2,
    });

    const runtime = new InProcessSkillsRuntime([
      listProvider('p1', { list: [first] }),
      listProvider('p2', { list: [second] }),
    ]);

    const resp = await runtime.list();

    expect(resp.ok).toBe(true);
    if (!resp.ok) return;

    // Deduped data has exactly ONE entry for the shared FQID, and it is the
    // FIRST occurrence (p1) — no silent pick of the other.
    expect(resp.data).toHaveLength(1);
    expect(resp.data[0].fqid).toBe(SHARED);
    expect(resp.data[0].provider).toBe('p1');
    expect(resp.data[0].layer).toBe(1);

    const diag = readAggregateDiagnostics(resp.provenance);
    expect(diag).toBeDefined();
    if (!diag) return;

    // The conflict is surfaced for the shared FQID, naming BOTH providers.
    expect(diag.conflicts).toHaveLength(1);
    expect(diag.conflicts[0].fqid).toBe(SHARED);
    expect(diag.conflicts[0].providers.slice().sort()).toEqual(['p1', 'p2']);
  });
});

// =============================================================================
// Case 5 — zero supporting providers → unsupported (Req 3.4)
// =============================================================================

describe('list aggregation — no provider supports the operation (Req 3.4)', () => {
  it('returns ok:false unsupported naming capability list when none declare it', async () => {
    const runtime = new InProcessSkillsRuntime([
      listProvider('no-list', { list: [], capList: false }),
    ]);

    const resp = await runtime.list();

    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error.code).toBe('unsupported');
    if (resp.error.code === 'unsupported') {
      expect(resp.error.capability).toBe('list');
    }
  });
});

// =============================================================================
// Case 6 (bonus) — search fallback diagnostics (Req 3.3)
// =============================================================================

describe('search aggregation — list+substring fallback diagnostics (Req 3.3)', () => {
  it('degrades to the documented fallback and records fallbacksApplied', async () => {
    const alpha = desc('only-list', 'alpha-skill');
    const beta = desc('only-list', 'beta-skill');
    const runtime = new InProcessSkillsRuntime([
      listProvider('only-list', { list: [makeResolved('only-list', alpha), makeResolved('only-list', beta)] }),
    ]);

    const resp = await runtime.search({ query: 'alpha' });

    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    // Substring filter selected only the matching skill.
    expect(resp.data.map((r) => r.descriptor.name)).toEqual(['alpha-skill']);

    const diag = readAggregateDiagnostics(resp.provenance);
    expect(diag).toBeDefined();
    if (!diag) return;
    expect(diag.fallbacksApplied).toBeDefined();
    expect(diag.fallbacksApplied).toContain('search:fallback(list+substring)');
  });
});
