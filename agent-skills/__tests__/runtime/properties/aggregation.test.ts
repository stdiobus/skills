/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Property tests — Aggregation polarity & capability-optional fallback — Task 8.5
//
// Property 8 (design.md §"Correctness Properties" — Aggregation polarity & resilience):
//   For any mix of provider outcomes in `list`/`search`: >=1 success -> `ok: true`
//   with the partial/empty collection plus aggregate diagnostics; supported but zero
//   results -> `ok: true` empty; every supporting provider failed -> `ok: false`
//   `aggregate_error` preserving each provider's code; no provider supports the
//   operation -> `ok: false` `unsupported`. The single-skill `SkillResponse` shape is
//   never altered (aggregate diagnostics ride provenance, not new top-level fields).
//   **Validates: Requirements 4.5, 4.6, 4.7, 4.8**
//
// Property 9 (design.md §"Correctness Properties" — Capability-optional invariance):
//   The runtime never invokes an operation a provider declares unsupported; a missing
//   `search` degrades to the documented fallback recorded in diagnostics.
//   **Validates: Requirements 3.2, 3.3**
//
// These tests drive the REAL `InProcessSkillsRuntime` over arbitrary in-memory
// `SkillProvider`s (no mocking of the runtime under test). Providers are instrumented
// so that an operation they declare UNSUPPORTED throws if the runtime ever calls it —
// the throw-guard is how "never invoked" is proven (Req 3.2). The properties assert
// aggregation SEMANTICS (polarity, diagnostics content, fallback recorded), never the
// `Promise.all` fan-out scheduling detail.
//
// Validates: Requirements 3.2, 3.3, 4.5, 4.6, 4.7, 4.8
// =============================================================================

import * as fc from 'fast-check';

import { InProcessSkillsRuntime } from '../../../runtime/in-process-runtime.js';
import { readAggregateDiagnostics } from '../../../runtime/federation.js';
import type {
  ResolvedSkill,
  SearchResult,
  SkillDescriptor,
  SkillProvider,
  SkillResponse,
} from '../../../runtime/contract.js';

// -----------------------------------------------------------------------------
// In-memory provider helpers.
// -----------------------------------------------------------------------------

function desc(provider: string, name: string): SkillDescriptor {
  return { fqid: `${provider}:${name}`, name, provider, source: `fake://${provider}/${name}` };
}

function makeResolved(providerId: string, descriptor: SkillDescriptor): ResolvedSkill {
  return {
    descriptor,
    providerId,
    providerLocalRef: '__private__',
    provenanceSeed: { source: descriptor.source },
  };
}

/**
 * Call instrumentation shared across a single runtime invocation. Every provider records
 * the ops the runtime actually invoked on it; a provider that declares an op unsupported
 * additionally THROWS from that op, so any spurious invocation is caught by the property
 * (Req 3.2 — "never invoke an operation a provider declares unsupported").
 */
interface CallLog {
  listInvoked: Set<string>;
  searchInvoked: Set<string>;
}

function newCallLog(): CallLog {
  return { listInvoked: new Set<string>(), searchInvoked: new Set<string>() };
}

/**
 * Assert the single-skill `SkillResponse` discriminated-union shape is never altered
 * (Req 4.5): an `ok: true` response has exactly `{ ok, data, provenance }` with a
 * well-formed provenance minimum set and carries NO new top-level fields; aggregate
 * diagnostics ride the provenance envelope, not the response root. An `ok: false`
 * response carries a typed `error` and no `data`.
 */
function assertWellFormed(resp: SkillResponse<unknown>): void {
  expect(typeof resp.ok).toBe('boolean');
  const keys = Object.keys(resp).sort();
  if (resp.ok) {
    expect(keys).toEqual(['data', 'ok', 'provenance']);
    expect(resp.provenance).toBeDefined();
    expect(typeof resp.provenance.fqid).toBe('string');
    expect(typeof resp.provenance.provider).toBe('string');
    expect(typeof resp.provenance.source).toBe('string');
    // Aggregate diagnostics are carried INSIDE provenance, never as a new top-level field.
    expect(keys).not.toContain('aggregateDiagnostics');
    expect(keys).not.toContain('sources');
  } else {
    // ok:false -> error present, no data; provenance is optional on the failure branch.
    expect(keys).not.toContain('data');
    expect(resp.error).toBeDefined();
    expect(typeof resp.error.code).toBe('string');
  }
}

// =============================================================================
// Property 8 — Aggregation polarity & resilience (Req 4.5, 4.6, 4.7, 4.8)
//
// Generate an array of providers, each with a generated `list` outcome:
//   - declaresList: whether the provider DECLARES `capabilities.list`.
//   - behavior:     'succeed-some' | 'succeed-empty' | 'throw' (only meaningful when
//                   the provider declares list; a non-declaring provider's list method
//                   THROWS if ever invoked, proving Req 3.2).
//   - names:        the (de-duplicated) skill names a 'succeed-some' provider emits.
//
// The expected polarity is computed independently from the generated mix and compared
// against the runtime's actual result. Per-provider FQIDs are prefixed by the distinct
// provider id, so cross-provider FQIDs never collide — the deduped union is exactly the
// set of emitted FQIDs across succeeding providers.
// =============================================================================

interface ListSpec {
  declaresList: boolean;
  behavior: 'succeed-some' | 'succeed-empty' | 'throw';
  names: string[];
}

function buildListProvider(id: string, spec: ListSpec, log: CallLog): SkillProvider {
  const owned = spec.names.map((n) => makeResolved(id, desc(id, n)));
  const provider: SkillProvider = {
    id,
    capabilities: { read: false, list: spec.declaresList, search: false, references: false },
    async resolve(): Promise<ResolvedSkill[]> {
      return [];
    },
  };
  // A `list` method is ALWAYS attached (even when undeclared) and throws-if-invoked when
  // undeclared, so the runtime calling it would surface as a thrown guard (Req 3.2). The
  // runtime's supporting filter short-circuits on `capabilities.list`, so a non-declaring
  // provider's list method must never run.
  provider.list = async (): Promise<ResolvedSkill[]> => {
    log.listInvoked.add(id);
    if (!spec.declaresList) {
      throw new Error(`${id}.list invoked though capabilities.list=false`);
    }
    if (spec.behavior === 'throw') throw new Error(`${id}.list intentionally threw`);
    if (spec.behavior === 'succeed-empty') return [];
    return owned;
  };
  return provider;
}

describe('Property 8: Aggregation polarity & resilience (Req 4.5, 4.6, 4.7, 4.8)', () => {
  const nameArb = fc.stringMatching(/^[a-z]{1,6}$/);

  const listSpecArb: fc.Arbitrary<ListSpec> = fc.record({
    declaresList: fc.boolean(),
    behavior: fc.constantFrom('succeed-some', 'succeed-empty', 'throw') as fc.Arbitrary<
      ListSpec['behavior']
    >,
    names: fc.uniqueArray(nameArb, { maxLength: 3 }),
  });

  it('list polarity follows the generated mix and never alters the single-skill shape', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(listSpecArb, { maxLength: 6 }), async (specs) => {
        const log = newCallLog();
        const providers = specs.map((spec, i) => buildListProvider(`p${i}`, spec, log));
        const runtime = new InProcessSkillsRuntime(providers);

        // The runtime never propagates a throw across the contract boundary.
        let resp: SkillResponse<SkillDescriptor[]>;
        try {
          resp = await runtime.list();
        } catch (e) {
          throw new Error(`runtime.list threw across the contract boundary: ${String(e)}`);
        }

        // Whatever the polarity, the single-skill response shape is intact (Req 4.5).
        assertWellFormed(resp);

        // --- expected polarity, computed independently from the generated mix ----------
        const supporting = specs
          .map((spec, i) => ({ id: `p${i}`, spec }))
          .filter((s) => s.spec.declaresList);
        const supportingFailed = supporting.filter((s) => s.spec.behavior === 'throw');
        const supportingOk = supporting.filter((s) => s.spec.behavior !== 'throw');

        // A provider that DECLARED list=false must never have had its list invoked (Req 3.2).
        for (let i = 0; i < specs.length; i++) {
          if (!specs[i].declaresList) {
            expect(log.listInvoked.has(`p${i}`)).toBe(false);
          }
        }

        if (supporting.length === 0) {
          // Branch 1 — no provider supports the operation -> unsupported (Req 3.4).
          expect(resp.ok).toBe(false);
          if (resp.ok) return;
          expect(resp.error.code).toBe('unsupported');
          if (resp.error.code === 'unsupported') {
            expect(resp.error.capability).toBe('list');
          }
          return;
        }

        if (supportingOk.length === 0) {
          // Branch 4 — every supporting provider failed -> aggregate_error preserving
          // each provider's identity + code (Req 4.8).
          expect(resp.ok).toBe(false);
          if (resp.ok) return;
          expect(resp.error.code).toBe('aggregate_error');
          if (resp.error.code !== 'aggregate_error') return;
          const failedIds = new Set(resp.error.failures.map((f) => f.provider));
          expect(failedIds).toEqual(new Set(supportingFailed.map((s) => s.id)));
          for (const f of resp.error.failures) {
            expect(f.error.code).toBe('provider_error');
          }
          return;
        }

        // Branches 2 & 3 — at least one supporting provider succeeded -> ok:true with the
        // (possibly partial, possibly empty) deduped union + aggregate diagnostics
        // (Req 4.6, 4.7).
        expect(resp.ok).toBe(true);
        if (!resp.ok) return;

        const expectedFqids = new Set<string>();
        for (const s of supportingOk) {
          if (s.spec.behavior === 'succeed-some') {
            for (const n of s.spec.names) expectedFqids.add(`${s.id}:${n}`);
          }
        }
        expect(new Set(resp.data.map((d) => d.fqid))).toEqual(expectedFqids);
        expect(resp.data.length).toBe(expectedFqids.size);

        // Aggregate diagnostics: one source per SUPPORTING provider, matching its behavior.
        const diag = readAggregateDiagnostics(resp.provenance);
        expect(diag).toBeDefined();
        if (!diag) return;
        expect(new Set(diag.sources.map((s) => s.provider))).toEqual(
          new Set(supporting.map((s) => s.id)),
        );
        for (const s of supporting) {
          const src = diag.sources.find((x) => x.provider === s.id)!;
          if (s.spec.behavior === 'throw') {
            expect(src.ok).toBe(false);
            expect(src.error?.code).toBe('provider_error');
          } else if (s.spec.behavior === 'succeed-empty') {
            expect(src.ok).toBe(true);
            expect(src.count).toBe(0);
          } else {
            expect(src.ok).toBe(true);
            expect(src.count).toBe(s.spec.names.length);
          }
        }
        // Cross-provider FQIDs never collide here, so no conflicts are surfaced.
        expect(diag.conflicts).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });
});

// =============================================================================
// Property 9 — Capability-optional fallback (Req 3.2, 3.3)
//
// Generate providers where NONE declares `search` (each would THROW if its `search` were
// invoked) and at least one declares `list` (and succeeds). Running `runtime.search`
// must:
//   - serve the result via the documented list+substring fallback -> `ok: true`;
//   - record a 'search:fallback...' entry in `provenance.aggregateDiagnostics.fallbacksApplied`
//     (Req 3.3);
//   - NEVER invoke any provider's `search` (the throwing search stub stays untouched) and
//     NEVER invoke `list` on a provider that declared it unsupported (Req 3.2).
// =============================================================================

interface SearchSpec {
  declaresList: boolean;
  names: string[];
}

function buildSearchSpecProvider(id: string, spec: SearchSpec, log: CallLog): SkillProvider {
  const owned = spec.names.map((n) => makeResolved(id, desc(id, n)));
  const provider: SkillProvider = {
    id,
    // search is ALWAYS declared unsupported in this property.
    capabilities: { read: false, list: spec.declaresList, search: false, references: false },
    async resolve(): Promise<ResolvedSkill[]> {
      return [];
    },
    // Attached but declared unsupported -> must never be invoked by the runtime (Req 3.2).
    async search(): Promise<SearchResult[]> {
      log.searchInvoked.add(id);
      throw new Error(`${id}.search invoked though capabilities.search=false`);
    },
  };
  provider.list = async (): Promise<ResolvedSkill[]> => {
    log.listInvoked.add(id);
    if (!spec.declaresList) {
      throw new Error(`${id}.list invoked though capabilities.list=false`);
    }
    return owned;
  };
  return provider;
}

describe('Property 9: Capability-optional fallback (Req 3.2, 3.3)', () => {
  const nameArb = fc.stringMatching(/^[a-z]{1,6}$/);
  const queryArb = fc.stringMatching(/^[a-z]{0,6}$/);

  const searchSpecArb: fc.Arbitrary<SearchSpec> = fc.record({
    declaresList: fc.boolean(),
    names: fc.uniqueArray(nameArb, { maxLength: 3 }),
  });

  it('degrades a missing native search to the documented fallback, never calling search', async () => {
    await fc.assert(
      fc.asyncProperty(
        queryArb,
        fc.array(searchSpecArb, { maxLength: 5 }),
        async (query, extraSpecs) => {
          const log = newCallLog();

          // Guarantee at least one list-capable, succeeding provider so the fallback can
          // serve `ok: true` (the property is about HOW it serves, via fallback).
          const guaranteed: SearchSpec = { declaresList: true, names: ['alpha', 'beta'] };
          const specs: SearchSpec[] = [guaranteed, ...extraSpecs];
          const providers = specs.map((spec, i) => buildSearchSpecProvider(`p${i}`, spec, log));
          const runtime = new InProcessSkillsRuntime(providers);

          let resp: SkillResponse<SearchResult[]>;
          try {
            resp = await runtime.search({ query });
          } catch (e) {
            throw new Error(`runtime.search threw across the contract boundary: ${String(e)}`);
          }

          // Served via fallback -> ok:true, single-skill shape intact.
          expect(resp.ok).toBe(true);
          assertWellFormed(resp);
          if (!resp.ok) return;

          // The documented fallback is recorded in diagnostics (Req 3.3).
          const diag = readAggregateDiagnostics(resp.provenance);
          expect(diag).toBeDefined();
          if (!diag) return;
          expect(diag.fallbacksApplied).toBeDefined();
          expect(diag.fallbacksApplied!.some((f) => f.startsWith('search:fallback'))).toBe(true);

          // No provider's `search` was ever invoked (Req 3.2): all declared it unsupported.
          expect(log.searchInvoked.size).toBe(0);

          // No provider that declared `list` unsupported had its `list` invoked (Req 3.2).
          for (let i = 0; i < specs.length; i++) {
            if (!specs[i].declaresList) {
              expect(log.listInvoked.has(`p${i}`)).toBe(false);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
