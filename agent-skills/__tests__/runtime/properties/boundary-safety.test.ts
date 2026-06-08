/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Property test — Boundary safety (Property 11) — Task 9.5
//
// Property 11 (design.md §"Correctness Properties"):
//   Any source or reference path resolving outside a provider's permitted root is
//   rejected as `out_of_bounds` and not read; content exceeding `maxContentBytes`
//   is rejected as `content_too_large` and not fully loaded; untrusted content is
//   treated as data and never executed.
//
// This file operationalizes that invariant with three fast-check properties over
// the REAL subjects under test (no mocking of the runtime/boundary under test):
//
//   Property A (out_of_bounds, Req 11.4):
//     For arbitrary candidate paths that ESCAPE a permitted root — `..` traversal
//     at random depth/position, absolute paths outside the root, and sibling-prefix
//     paths (`${root}-evil/...`) — `checkWithinRoot` RETURNS ok:false / out_of_bounds.
//     For arbitrary paths genuinely INSIDE the root (relative, no `..`) it RETURNS
//     ok:true. A representative subset is driven through `runtime.readReference`
//     (untrusted policy + permittedRoot, instrumented provider): escaping paths
//     surface `out_of_bounds` RETURNED and the provider's `readReference` is NEVER
//     invoked (the location is not read).
//
//   Property B (content_too_large, Req 11.5):
//     For arbitrary content sizes and limits, `checkContentSize` returns
//     `content_too_large` iff byteLength > limit, else ok. The `number` overload
//     (a pre-computed size, e.g. from fs.stat) shows oversize is rejected WITHOUT
//     materializing the content ("not loaded in full"). A representative case is
//     driven through `runtime.read` with a small `maxContentBytes` to show the
//     RETURNED `content_too_large` at the runtime boundary.
//
//   Property C (untrusted-as-data, Req 11.7):
//     For arbitrary provider bodies containing code-like / injection-like strings
//     (incl. a sentinel that WOULD mutate a test-global if executed), reading the
//     body through the runtime returns it VERBATIM as inert data, mutates no global
//     (the sentinel never fires), and never eval/require/spawns it. Complementarily,
//     `mayPromoteClassification` keeps an untrusted provider's classification
//     non-authoritative (data, not authority) unless explicitly pinned/persisted.
//
//   Totality (Req 11.3/11.4/11.5): every runtime call is wrapped — a throw across
//   the contract boundary fails the property.
//
// Validates: Requirements 11.4, 11.5, 11.7
// =============================================================================

import * as path from 'path';

import * as fc from 'fast-check';

import { checkContentSize, checkWithinRoot } from '../../../runtime/security/boundary.js';
import { SkillProviderRegistry, createRuntimeFromRegistry } from '../../../runtime/registry.js';
import { mayPromoteClassification, type TrustPolicy } from '../../../runtime/trust.js';
import type {
  ReferenceContent,
  ResolvedSkill,
  SkillContent,
  SkillProvider,
  SkillRef,
  SkillsRuntime,
} from '../../../runtime/contract.js';

const NUM_RUNS = 200;
const ROOT = path.resolve('/srv/skills/provider-root');
const PROVIDER_ID = 'ext';
const SKILL_NAME = 'alpha';

// A sentinel global key used by Property C: if any generated body were ever
// executed, the embedded `globalThis[PWNED_KEY] = true` statement would set it.
const PWNED_KEY = '__boundary_safety_pwned__';

// =============================================================================
// Instrumented provider — records read/readReference invocations so a test can
// prove an out-of-bounds path admits NO content (the location is never read).
// =============================================================================

interface ProbeProvider extends SkillProvider {
  reads: number;
  refReads: number;
}

function makeProvider(body: string, id = PROVIDER_ID): ProbeProvider {
  const descriptor = {
    fqid: `${id}:${SKILL_NAME}`,
    name: SKILL_NAME,
    provider: id,
    source: `fake://${id}/${SKILL_NAME}`,
  };
  const resolved: ResolvedSkill = {
    descriptor,
    providerId: id,
    providerLocalRef: '__private__',
    provenanceSeed: { source: descriptor.source },
  };
  const provider: ProbeProvider = {
    id,
    reads: 0,
    refReads: 0,
    capabilities: { read: true, list: true, search: false, references: true },
    async resolve(ref: SkillRef): Promise<ResolvedSkill[]> {
      const name =
        ref.kind === 'name' ? ref.name : ref.kind === 'fqid' ? null : ref.descriptor.name;
      return name === SKILL_NAME ? [resolved] : [];
    },
    async read(): Promise<SkillContent> {
      provider.reads += 1;
      return { descriptor, body };
    },
    async readReference(_r, reference): Promise<ReferenceContent> {
      provider.refReads += 1;
      return { path: reference, body };
    },
  };
  return provider;
}

/** Build a runtime over a single provider with the given trust policy (registry seam). */
function runtimeWith(provider: SkillProvider, trust: TrustPolicy): SkillsRuntime {
  const registry = new SkillProviderRegistry([{ provider, trust }]);
  return createRuntimeFromRegistry({ kind: 'in-process' }, registry);
}

// =============================================================================
// Generators
// =============================================================================

/** A single safe path segment: lowercase alphanumerics + `_`/`-`, never `.`/`..`/sep. */
const safeSegmentArb = fc
  .stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_-'.split('')), {
    minLength: 1,
    maxLength: 8,
  })
  .filter((s) => s.length > 0);

/** A relative path GENUINELY INSIDE the root: 1..5 safe segments, no `..`. */
const insidePathArb: fc.Arbitrary<string> = fc
  .array(safeSegmentArb, { minLength: 1, maxLength: 5 })
  .map((segs) => segs.join('/'));

/** A `..`-traversal escape: safe segments with at least one `..` at a random index. */
const dotDotEscapeArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.array(safeSegmentArb, { minLength: 0, maxLength: 4 }),
    fc.integer({ min: 1, max: 4 }), // how many `..` segments
    fc.array(safeSegmentArb, { minLength: 0, maxLength: 4 }),
  )
  .map(([pre, ups, post]) => [...pre, ...Array(ups).fill('..'), ...post].join('/'))
  .filter((p) => p.includes('..'));

/** An absolute path OUTSIDE the root (first dir is never `srv`, so never under ROOT). */
const absoluteOutsideArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('etc', 'var', 'tmp', 'usr', 'root', 'opt'),
    fc.array(safeSegmentArb, { minLength: 0, maxLength: 4 }),
  )
  .map(([head, rest]) => `/${[head, ...rest].join('/')}`);

/**
 * A sibling-prefix escape: shares the ROOT string prefix but is NOT nested under
 * `${ROOT}${sep}` (e.g. `${ROOT}-evil/secret`). The suffix never starts with the
 * path separator and contains no `..`.
 */
const siblingPrefixArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')), {
      minLength: 1,
      maxLength: 6,
    }),
    fc.array(safeSegmentArb, { minLength: 0, maxLength: 3 }),
  )
  .map(([suffix, rest]) => path.resolve(`${ROOT}${suffix}`, ...rest));

/** Any escaping candidate path (the three escape families combined). */
const escapingPathArb: fc.Arbitrary<string> = fc.oneof(
  dotDotEscapeArb,
  absoluteOutsideArb,
  siblingPrefixArb,
);

/** Code-like / injection-like fragments — inert DATA the runtime must never execute. */
const dangerousFragmentArb = fc.constantFrom(
  'process.exit(1)',
  'require("fs").rmSync("/", { recursive: true })',
  '<script>alert(document.cookie)</script>',
  'eval("1 + 1")',
  'new Function("return process")()',
  '`rm -rf /`',
  '$(reboot)',
  '"; DROP TABLE skills; --',
  '{{constructor.constructor("return this")()}}',
  '\u0000\u001b[2J\u001b[H',
  'globalThis.__proto__.polluted = true',
);

// =============================================================================
// Property A — out_of_bounds (Req 11.4)
// =============================================================================

describe('Property 11.A: out-of-bounds paths are rejected and never read (Req 11.4)', () => {
  it('checkWithinRoot RETURNS out_of_bounds for any escaping candidate path', () => {
    fc.assert(
      fc.property(escapingPathArb, (candidate) => {
        const res = checkWithinRoot(ROOT, candidate, PROVIDER_ID);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe('out_of_bounds');
          if (res.error.code === 'out_of_bounds') {
            expect(res.error.provider).toBe(PROVIDER_ID);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('checkWithinRoot RETURNS ok for any path genuinely inside the root', () => {
    fc.assert(
      fc.property(insidePathArb, (inside) => {
        const res = checkWithinRoot(ROOT, inside, PROVIDER_ID);
        expect(res.ok).toBe(true);
        if (res.ok) {
          // The resolved path stays under the permitted root.
          expect(res.resolved.startsWith(ROOT + path.sep)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('runtime.readReference rejects escaping paths as out_of_bounds WITHOUT reading them', async () => {
    const untrustedWithRoot: TrustPolicy = {
      tier: 'untrusted',
      maxContentBytes: 1_000_000,
      isolateFetch: true,
      permittedRoot: ROOT,
    };
    await fc.assert(
      fc.asyncProperty(escapingPathArb, async (candidate) => {
        const provider = makeProvider('body', PROVIDER_ID);
        const runtime = runtimeWith(provider, untrustedWithRoot);

        // Totality: a throw across the boundary fails the property.
        let resp;
        try {
          resp = await runtime.readReference({
            ref: { kind: 'name', name: SKILL_NAME },
            reference: candidate,
          });
        } catch (e) {
          throw new Error(`readReference threw across the boundary for "${candidate}": ${String(e)}`);
        }

        expect(resp.ok).toBe(false);
        if (!resp.ok) {
          expect(resp.error.code).toBe('out_of_bounds');
          if (resp.error.code === 'out_of_bounds') expect(resp.error.provider).toBe(PROVIDER_ID);
        }
        // The out-of-bounds location was NEVER read.
        expect(provider.refReads).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('runtime.readReference admits an in-bounds path within the size limit (no false positives)', async () => {
    const untrustedWithRoot: TrustPolicy = {
      tier: 'untrusted',
      maxContentBytes: 1_000_000,
      isolateFetch: true,
      permittedRoot: ROOT,
    };
    await fc.assert(
      fc.asyncProperty(insidePathArb, async (inside) => {
        const provider = makeProvider('small body', PROVIDER_ID);
        const runtime = runtimeWith(provider, untrustedWithRoot);

        const resp = await runtime.readReference({
          ref: { kind: 'name', name: SKILL_NAME },
          reference: inside,
        });

        expect(resp.ok).toBe(true);
        if (resp.ok) expect(resp.data.body).toBe('small body');
        // An in-bounds reference IS read exactly once.
        expect(provider.refReads).toBe(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// =============================================================================
// Property B — content_too_large (Req 11.5)
// =============================================================================

describe('Property 11.B: oversize content is rejected and not fully loaded (Req 11.5)', () => {
  it('checkContentSize (number overload) rejects iff size > limit, without materializing content', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 5_000_000 }),
        fc.nat({ max: 5_000_000 }),
        (size, limit) => {
          // The `number` overload is the "not loaded in full" path: only the
          // pre-computed byte count is passed — no content is ever materialized.
          const res = checkContentSize(size, limit, PROVIDER_ID);
          expect(res.ok).toBe(size <= limit);
          if (!res.ok) {
            expect(res.error.code).toBe('content_too_large');
            if (res.error.code === 'content_too_large') {
              expect(res.error.limitBytes).toBe(limit);
              expect(res.error.provider).toBe(PROVIDER_ID);
            }
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('checkContentSize (string) rejects iff UTF-8 byteLength > limit', () => {
    fc.assert(
      fc.property(fc.string(), fc.nat({ max: 4_096 }), (content, limit) => {
        const bytes = Buffer.byteLength(content, 'utf8');
        const res = checkContentSize(content, limit, PROVIDER_ID);
        expect(res.ok).toBe(bytes <= limit);
        if (!res.ok) expect(res.error.code).toBe('content_too_large');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('runtime.read RETURNS content_too_large when the body exceeds maxContentBytes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 512 }), // ceiling
        fc.integer({ min: 1, max: 4_096 }), // extra bytes over the ceiling
        async (limit, over) => {
          const provider = makeProvider('x'.repeat(limit + over), PROVIDER_ID);
          const policy: TrustPolicy = {
            tier: 'untrusted',
            maxContentBytes: limit,
            isolateFetch: true,
          };
          const runtime = runtimeWith(provider, policy);

          let resp;
          try {
            resp = await runtime.read({ ref: { kind: 'name', name: SKILL_NAME } });
          } catch (e) {
            throw new Error(`read threw across the boundary: ${String(e)}`);
          }

          expect(resp.ok).toBe(false);
          if (!resp.ok) {
            expect(resp.error.code).toBe('content_too_large');
            if (resp.error.code === 'content_too_large') expect(resp.error.limitBytes).toBe(limit);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// =============================================================================
// Property C — untrusted-as-data: never executed (Req 11.7)
// =============================================================================

describe('Property 11.C: untrusted content is treated as inert data, never executed (Req 11.7)', () => {
  // The sentinel global must stay undefined throughout: if any body were executed,
  // its embedded `globalThis[PWNED_KEY] = true` would flip it.
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[PWNED_KEY];
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[PWNED_KEY];
  });

  it('reading a code-like body returns it VERBATIM and executes nothing', async () => {
    // Trusted policy with a generous ceiling so the body passes the size gate and we
    // isolate the untrusted-as-data invariant (no code path executes the content).
    const policy: TrustPolicy = {
      tier: 'trusted',
      maxContentBytes: 10_000_000,
      isolateFetch: false,
    };
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          prefix: fc.string(),
          inject: fc.array(dangerousFragmentArb, { minLength: 0, maxLength: 6 }),
          suffix: fc.string(),
        }),
        async ({ prefix, inject, suffix }) => {
          // A sentinel statement that WOULD mutate a test-global if executed.
          const sentinel = `globalThis[${JSON.stringify(PWNED_KEY)}] = true;`;
          const body = [prefix, ...inject, sentinel, suffix].join('\n');

          const provider = makeProvider(body, PROVIDER_ID);
          const runtime = runtimeWith(provider, policy);

          let resp;
          try {
            resp = await runtime.read({ ref: { kind: 'name', name: SKILL_NAME } });
          } catch (e) {
            throw new Error(`read threw across the boundary: ${String(e)}`);
          }

          // The content is admitted as DATA, byte-for-byte unchanged...
          expect(resp.ok).toBe(true);
          if (resp.ok) expect(resp.data.body).toBe(body);
          // ...and was NEVER executed: the sentinel global remains undefined.
          expect((globalThis as Record<string, unknown>)[PWNED_KEY]).toBeUndefined();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('mayPromoteClassification keeps untrusted classification non-authoritative (data, not authority)', () => {
    const untrusted: TrustPolicy = { tier: 'untrusted', maxContentBytes: 1_000, isolateFetch: true };
    const trusted: TrustPolicy = { tier: 'trusted', maxContentBytes: 10_000, isolateFetch: false };
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (pinned, persisted) => {
        // Untrusted: an embedded/inferred classification becomes authoritative ONLY
        // through explicit pinning or persistence — never from the content itself.
        expect(mayPromoteClassification(untrusted, { pinned, persisted })).toBe(pinned || persisted);
        // Trusted (first-party): always promotable.
        expect(mayPromoteClassification(trusted, { pinned, persisted })).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
