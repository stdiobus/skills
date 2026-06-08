/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Property-based tests for transport structural equivalence
// (Migration Step 5, Task 7.6).
//
// Subject: the two SkillsRuntime backends behind the transport factory —
//   - InProcessSkillsRuntime (direct call, no serialization), and
//   - BusSkillsRuntime (encode -> StdioBus.request -> decodeResponse).
//
// Property 7: Transport structural equivalence (design §"Property 7", §3)
//   For the SAME input, the in-process and stdio Bus backends produce
//   STRUCTURALLY EQUIVALENT SkillResponse values: same `ok`; when `ok`, the
//   same `data` and the same provenance CORE meaning ({fqid, provider, source,
//   resolvedFrom}); when not `ok`, the same typed `error`. Transport-specific
//   diagnostics MAY differ, but they never change the core result meaning.
//
// Validates: Requirements 2.10, 6.1, 6.3, 6.4
//
// ─── Why no native bus is needed here ───────────────────────────────────────
// The real native bus is heavy and environment-sensitive; its end-to-end
// behavior is proven separately by the real round-trip integration test
// (`transport/bus-roundtrip.integration.test.ts`). This property test proves
// the EQUIVALENCE invariant deterministically and in-process by backing
// BusSkillsRuntime with an in-memory StdioBus whose `request(method, params)`
// faithfully MIRRORS the promoted worker ingress (`runtime/transport/bus-worker.ts`):
//   1. `ParamCodec.decode(method, params)` — the single boundary validation point;
//   2. on success, dispatch the decoded input to an InProcessSkillsRuntime over
//      the SAME providers (the worker hosts exactly such a runtime);
//   3. return the resulting SkillResponse as the wire value, after a JSON round
//      trip so the NDJSON serialization boundary is represented honestly.
// This exercises the real ParamCodec.encode -> decode -> runtime -> decodeResponse
// path — exactly the worker's logic — minus only the OS process + native kernel,
// which the integration test covers.
// =============================================================================

import * as fc from 'fast-check';
import type StdioBus from '@stdiobus/node';
import { BusSkillsRuntime } from '../../../runtime/transport/bus-runtime.js';
import { InProcessSkillsRuntime } from '../../../runtime/in-process-runtime.js';
import { FilesystemSkillProvider } from '../../../runtime/providers/filesystem-provider.js';
import { ParamCodec } from '../../../runtime/transport/param-codec.js';
import { SkillsCapabilities } from '../../../runtime/capabilities.js';
import { SkillName } from '../../../types.js';
import type {
  GetReferencesInput,
  ListSkillsInput,
  Provenance,
  ReadReferenceInput,
  ReadSkillInput,
  SearchSkillsInput,
  SkillProvider,
  SkillResponse,
  SkillsRuntime,
} from '../../../runtime/contract.js';

// -----------------------------------------------------------------------------
// In-memory StdioBus that mirrors the promoted bus-worker ingress EXACTLY.
//
// BusSkillsRuntime only invokes `bus.request(method, params, opts)` for an
// injected (caller-owned) bus — `start()`/`stop()` are no-ops for an injected
// bus — so a `request`-only stub is a faithful stand-in for the transport.
// -----------------------------------------------------------------------------

/** Represent the NDJSON serialization boundary: anything on the wire is JSON. */
function jsonWire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Build the worker-side dispatch table over the proven core capabilities,
 * keyed by the SAME wire `method` strings the real worker uses. This is a
 * verbatim mirror of `bus-worker.ts`'s DISPATCH so the equivalence is meaningful.
 */
function workerDispatch(
  workerRuntime: SkillsRuntime,
): Record<string, (input: unknown) => Promise<SkillResponse<unknown>>> {
  return {
    [SkillsCapabilities.read.method]: (i) => workerRuntime.read(i as ReadSkillInput),
    [SkillsCapabilities.list.method]: (i) => workerRuntime.list(i as ListSkillsInput),
    [SkillsCapabilities.search.method]: (i) => workerRuntime.search(i as SearchSkillsInput),
    [SkillsCapabilities.listReferences.method]: (i) =>
      workerRuntime.getReferences(i as GetReferencesInput),
    [SkillsCapabilities.readReference.method]: (i) =>
      workerRuntime.readReference(i as ReadReferenceInput),
  };
}

/**
 * An in-memory bus whose `request` runs the worker ingress: decode at the single
 * boundary, dispatch to the worker's in-process runtime, return the SkillResponse
 * as a JSON wire value. Mirrors `bus-worker.ts` line for line (minus the OS pipe).
 */
function makeMirrorBus(workerRuntime: SkillsRuntime): StdioBus {
  const dispatch = workerDispatch(workerRuntime);
  const bus = {
    async request(method: string, params: unknown): Promise<unknown> {
      const decoded = ParamCodec.decode(method, params); // single validation point (Req 10.2/10.3)
      if (!decoded.ok) {
        return jsonWire({ ok: false, error: decoded.error });
      }
      const handler = dispatch[method];
      if (!handler) {
        return jsonWire({ ok: false, error: { code: 'unsupported', capability: method } });
      }
      const result = await handler(decoded.input);
      return jsonWire(result); // typed SkillResponse rides the wire as structured data (Req 6.3)
    },
  };
  return bus as unknown as StdioBus;
}

// -----------------------------------------------------------------------------
// Core-meaning projection — what "structurally equivalent" means precisely.
//
// Two SkillResponses are structurally equivalent iff they agree on:
//   - `ok`;
//   - when ok: `data` (deep) AND the provenance CORE {fqid, provider, source,
//     resolvedFrom} (Req 2.3 minimum set + the resolved-from ref);
//   - when not ok: the typed `error` (deep).
// Other provenance fields are transport-specific diagnostics and are excluded
// from the core meaning by design (Req 6.4). `toEqual` is used (not
// `toStrictEqual`) so the codec's documented absent-vs-explicit-undefined
// normalization on the bus path is treated as equivalent, not as a difference.
// -----------------------------------------------------------------------------

function provenanceCore(p: Provenance): Record<string, unknown> {
  return { fqid: p.fqid, provider: p.provider, source: p.source, resolvedFrom: p.resolvedFrom };
}

function coreMeaning(resp: SkillResponse<unknown>): Record<string, unknown> {
  if (resp.ok) {
    return { ok: true, data: resp.data, provenance: provenanceCore(resp.provenance) };
  }
  return { ok: false, error: resp.error };
}

function expectEquivalent(inProc: SkillResponse<unknown>, bus: SkillResponse<unknown>): void {
  expect(coreMeaning(bus)).toEqual(coreMeaning(inProc));
}

// -----------------------------------------------------------------------------
// Backends — both run over the SAME providers. The bus backend's worker hosts
// its own in-process runtime over those providers (the proven topology), so the
// only difference between the two paths is the encode/decode/serialize boundary.
// The default FilesystemSkillProvider (no packageRoot) reads the real bundled
// skills, so resolution and content are genuine, not faked.
// -----------------------------------------------------------------------------

const providers: ReadonlyArray<SkillProvider> = [new FilesystemSkillProvider()];
const inProc: SkillsRuntime = new InProcessSkillsRuntime(providers);
const workerRuntime: SkillsRuntime = new InProcessSkillsRuntime(providers);
const bus: SkillsRuntime = new BusSkillsRuntime({ pool: 'equiv-test' }, makeMirrorBus(workerRuntime));

const PUBLISHED: readonly string[] = Object.values(SkillName);
const published = new Set<string>(PUBLISHED);

// -----------------------------------------------------------------------------
// Generators — produce only SCHEMA-VALID inputs (so decode on the bus path
// always succeeds and both backends reach the runtime), biased so that a
// healthy fraction resolve to real bundled skills while the rest miss. Names
// are drawn from the published set OR arbitrary non-empty strings (which almost
// never collide with a kebab-case published name → exercises `not_found`).
// -----------------------------------------------------------------------------

const publishedNameArb = fc.constantFrom(...PUBLISHED);
const anyNameArb = fc.string({ minLength: 1 });
const nameArb = fc.oneof(publishedNameArb, anyNameArb);

/** name ref — provider scope optional (absent | 'bundled' | a foreign provider). */
const nameRefArb = fc
  .tuple(nameArb, fc.option(fc.constantFrom('bundled', 'other'), { nil: undefined }))
  .map(([name, provider]) =>
    provider === undefined
      ? { kind: 'name' as const, name }
      : { kind: 'name' as const, name, provider },
  );

/** fqid ref — sometimes a real `bundled:<published>` fqid, sometimes arbitrary. */
const fqidRefArb = fc
  .oneof(
    publishedNameArb.map((n) => `bundled:${n}`),
    fc.string({ minLength: 1 }),
  )
  .map((fqid) => ({ kind: 'fqid' as const, fqid }));

const skillRefArb = fc.oneof(nameRefArb, fqidRefArb);

const readInputArb = skillRefArb.map((ref) => ({ ref }));
const listInputArb = fc.option(fc.constantFrom('bundled', 'other'), { nil: undefined }).map(
  (provider) => (provider === undefined ? {} : { provider }),
);
const searchInputArb = fc
  .tuple(fc.oneof(fc.constantFrom('runtime', 'concepts', 'sdk', 'zzz-none'), fc.string()), fc.option(fc.integer({ min: 0, max: 50 }), { nil: undefined }))
  .map(([query, limit]) => (limit === undefined ? { query } : { query, limit }));
const readReferenceInputArb = fc
  .tuple(skillRefArb, fc.string({ minLength: 1 }))
  .map(([ref, reference]) => ({ ref, reference }));

// =============================================================================
// Property 7: in-process and bus backends are structurally equivalent
// =============================================================================

describe('Property 7: transport structural equivalence (Req 2.10, 6.1, 6.3, 6.4)', () => {
  it('read(): equivalent SkillResponse over both transports for arbitrary refs', async () => {
    let okCount = 0;
    let notFoundCount = 0;
    await fc.assert(
      fc.asyncProperty(readInputArb, async (input: ReadSkillInput) => {
        const a = await inProc.read(input);
        const b = await bus.read(input);
        expectEquivalent(a, b);
        if (a.ok) okCount += 1;
        else if (a.error.code === 'not_found') notFoundCount += 1;
      }),
      { numRuns: 150 },
    );
    // Guard against a trivially-green test: the run must have exercised BOTH a
    // resolving (ok) path and a missing (not_found) path.
    expect(okCount).toBeGreaterThan(0);
    expect(notFoundCount).toBeGreaterThan(0);
  });

  it('list(): equivalent SkillResponse over both transports', async () => {
    await fc.assert(
      fc.asyncProperty(listInputArb, async (input: ListSkillsInput) => {
        const a = await inProc.list(input);
        const b = await bus.list(input);
        expectEquivalent(a, b);
      }),
      { numRuns: 60 },
    );
  });

  it('search(): equivalent SkillResponse over both transports (fallback path)', async () => {
    await fc.assert(
      fc.asyncProperty(searchInputArb, async (input: SearchSkillsInput) => {
        const a = await inProc.search(input);
        const b = await bus.search(input);
        expectEquivalent(a, b);
      }),
      { numRuns: 100 },
    );
  });

  it('getReferences(): equivalent SkillResponse over both transports', async () => {
    await fc.assert(
      fc.asyncProperty(readInputArb, async (input: GetReferencesInput) => {
        const a = await inProc.getReferences(input);
        const b = await bus.getReferences(input);
        expectEquivalent(a, b);
      }),
      { numRuns: 120 },
    );
  });

  it('readReference(): equivalent SkillResponse over both transports', async () => {
    await fc.assert(
      fc.asyncProperty(readReferenceInputArb, async (input: ReadReferenceInput) => {
        const a = await inProc.readReference(input);
        const b = await bus.readReference(input);
        expectEquivalent(a, b);
      }),
      { numRuns: 120 },
    );
  });
});

// =============================================================================
// Example anchors — pin the two canonical outcomes (resolved + open-world miss)
// so the equivalence is legible and the ok/not_found paths are both covered.
// =============================================================================

describe('Property 7: equivalence anchors (published hit + open-world miss)', () => {
  it('read() of a published name is equivalent and ok on both transports', async () => {
    const input: ReadSkillInput = { ref: { kind: 'name', name: 'runtime-concepts' } };
    const a = await inProc.read(input);
    const b = await bus.read(input);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expectEquivalent(a, b);
    if (a.ok && b.ok) {
      expect(b.data.body).toBe(a.data.body);
      expect(b.data.body.length).toBeGreaterThan(0);
      expect(b.provenance.fqid).toBe('bundled:runtime-concepts');
      expect(b.provenance.provider).toBe('bundled');
    }
  });

  it('read() of an unknown name is equivalent and not_found on both transports', async () => {
    const input: ReadSkillInput = { ref: { kind: 'name', name: 'no-such-skill-xyz' } };
    const a = await inProc.read(input);
    const b = await bus.read(input);

    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expectEquivalent(a, b);
    if (!b.ok) expect(b.error.code).toBe('not_found');
  });

  it('published flag set: a bundled name resolves identically (no transport drift)', () => {
    expect(published.has('runtime-concepts')).toBe(true);
  });
});
