/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Property tests — Open-world resolution & no-silent-ambiguity — Task 4.4
//
// Property 3 (design.md §"Correctness Properties" — Open-world resolution):
//   A `name` SkillRef is never rejected merely for being absent from the
//   published `SkillName` set; it resolves to candidates or to `not_found`,
//   leaving the registry unchanged.
//   **Validates: Requirements 1.2, 1.6, 9.6**
//
// Property 4 (design.md §"Correctness Properties" — No silent ambiguity):
//   When a ref resolves to >=2 DISTINCT FQIDs, the result is `ambiguous` with
//   all candidates; the runtime never silently selects the first match. When
//   distinct providers map the same name to the SAME FQID, dedupe collapses the
//   count and resolution succeeds (one candidate) — ambiguity requires >=2
//   DISTINCT FQIDs.
//   **Validates: Requirements 1.4, 2.7, 5.6**
//
// These tests drive the REAL InProcessSkillsRuntime through the registry ->
// transport-factory seam over arbitrary in-memory SkillProviders (no mocking of
// the runtime under test). The runtime's resolution polarity is observed through
// `read`, which routes every single-skill operation through `resolveOne`.
//
// Validates: Requirements 1.2, 1.4, 1.6, 2.7, 5.6, 9.6
// =============================================================================

import * as fc from 'fast-check';

import {
  SkillProviderRegistry,
  createRuntimeFromRegistry,
} from '../../../runtime/registry.js';
import { SkillName } from '../../../types.js';
import type {
  ResolvedSkill,
  SkillContent,
  SkillDescriptor,
  SkillProvider,
  SkillRef,
  SkillResponse,
} from '../../../runtime/contract.js';

// -----------------------------------------------------------------------------
// In-memory provider — a real SkillProvider that owns a fixed set of skills and
// resolves a `name` ref by exact-name match. `read` is supported so a single
// resolved candidate surfaces as `ok: true` (isolating resolution polarity from
// capability-omission). The provider id is distinct per provider; the FQID a
// provider emits for a skill is supplied explicitly so collisions (shared FQID
// across providers) and distinctness (per-provider FQID) can both be generated.
// -----------------------------------------------------------------------------

interface OwnedSkill {
  /** The runtime identity key — may intentionally collide across providers. */
  fqid: string;
  /** The human-facing name a caller addresses. */
  name: string;
}

function makeProvider(id: string, owned: ReadonlyArray<OwnedSkill>): SkillProvider {
  const toResolved = (s: OwnedSkill): ResolvedSkill => {
    const descriptor: SkillDescriptor = {
      fqid: s.fqid,
      name: s.name,
      provider: id,
      source: `fake://${id}/${s.name}`,
    };
    return {
      descriptor,
      providerId: id,
      providerLocalRef: '__private__',
      provenanceSeed: { source: descriptor.source },
    };
  };

  return {
    id,
    capabilities: { read: true, list: true, search: false, references: false },
    async resolve(ref: SkillRef): Promise<ResolvedSkill[]> {
      // Only a `name` ref is exercised by these properties.
      if (ref.kind !== 'name') return [];
      if (ref.provider && ref.provider !== id) return [];
      return owned.filter((s) => s.name === ref.name).map(toResolved);
    },
    async read(resolved: ResolvedSkill): Promise<SkillContent> {
      return { descriptor: resolved.descriptor, body: `body:${resolved.descriptor.fqid}` };
    },
    async list(): Promise<ResolvedSkill[]> {
      return owned.map(toResolved);
    },
  };
}

const PUBLISHED = new Set<string>(Object.values(SkillName));

/** Resolve a name ref through the runtime, asserting it never throws. */
async function readByName(
  providers: ReadonlyArray<SkillProvider>,
  name: string,
): Promise<{ resp: SkillResponse<SkillContent>; registry: SkillProviderRegistry }> {
  const registry = new SkillProviderRegistry(providers.map((provider) => ({ provider })));
  const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);
  let resp: SkillResponse<SkillContent>;
  try {
    resp = await runtime.read({ ref: { kind: 'name', name } });
  } catch (e) {
    throw new Error(`runtime.read threw across the contract boundary: ${String(e)}`);
  }
  return { resp, registry };
}

// =============================================================================
// Property 3 — Open-world resolution (Req 1.2, 1.6, 9.6)
//
// Generate arbitrary registries of providers, each owning the open-world target
// name under a per-provider-distinct FQID (`${id}:${name}`), plus arbitrary
// noise skills. The target name is GUARANTEED absent from the `SkillName` enum.
// The runtime must treat it as valid input — resolving to a candidate or to
// `not_found`, NEVER rejecting it for enum-absence — and must leave the registry
// unchanged across the call.
// =============================================================================

describe('Property 3: Open-world resolution (Req 1.2, 1.6, 9.6)', () => {
  // A target name built to be absent from the published SkillName set.
  const targetNameArb = fc
    .stringMatching(/^[a-z]{1,8}$/)
    .map((s) => `open-world-${s}`)
    .filter((name) => !PUBLISHED.has(name));

  // For each provider: a distinct id, whether it owns the target, and noise.
  const providerSpecArb = fc.record({
    ownsTarget: fc.boolean(),
    noise: fc.array(fc.stringMatching(/^[a-z]{1,6}$/), { maxLength: 3 }),
  });

  it('treats an enum-absent name as valid input: resolves to candidates or not_found', async () => {
    await fc.assert(
      fc.asyncProperty(
        targetNameArb,
        fc.array(providerSpecArb, { minLength: 0, maxLength: 5 }),
        async (targetName, specs) => {
          // Precondition: the target genuinely is NOT a published skill name.
          expect(PUBLISHED.has(targetName)).toBe(false);

          const providers = specs.map((spec, i) => {
            const id = `p${i}`;
            const owned: OwnedSkill[] = [];
            if (spec.ownsTarget) owned.push({ fqid: `${id}:${targetName}`, name: targetName });
            for (const n of spec.noise) {
              if (n !== targetName) owned.push({ fqid: `${id}:${n}`, name: n });
            }
            return makeProvider(id, owned);
          });

          // Per-provider FQIDs are distinct (keyed by id), so the distinct-FQID
          // count for the target equals the number of providers that own it.
          const ownerCount = specs.filter((s) => s.ownsTarget).length;

          const before = providers.map((p) => p.id);
          const { resp, registry } = await readByName(providers, targetName);

          // The outcome is dictated by provider supply, never by enum membership.
          if (ownerCount === 0) {
            expect(resp.ok).toBe(false);
            if (!resp.ok) expect(resp.error.code).toBe('not_found');
          } else if (ownerCount === 1) {
            expect(resp.ok).toBe(true);
          } else {
            expect(resp.ok).toBe(false);
            if (!resp.ok) expect(resp.error.code).toBe('ambiguous');
          }

          // Whatever the outcome, it is never an enum-absence rejection: the only
          // ok:false codes reachable here are the open-world resolution outcomes.
          if (!resp.ok) {
            expect(['not_found', 'ambiguous']).toContain(resp.error.code);
          }

          // Registry unchanged: same providers, same order, same count.
          const after = registry.providers().map((p) => p.id);
          expect(after).toEqual(before);
          expect(registry.registrations.length).toBe(providers.length);
        },
      ),
      { numRuns: 400 },
    );
  });
});

// =============================================================================
// Property 4 — No silent ambiguity (Req 1.4, 2.7, 5.6)
//
// Generate, for a single target name, a set of providers that each emit ONE FQID
// drawn from a small pool (so collisions are common). The runtime dedupes by
// FQID, so the result polarity is a pure function of the DISTINCT FQID count:
//   0  -> not_found
//   1  -> ok (dedupe collapsed any same-FQID duplicates — NOT ambiguous)
//   >=2 -> ambiguous, candidates == the full set of distinct FQIDs
// This precisely encodes "ambiguity requires >=2 DISTINCT FQIDs" and "never a
// silent first-match".
// =============================================================================

describe('Property 4: No silent ambiguity (Req 1.4, 2.7, 5.6)', () => {
  const TARGET = 'ambiguity-target';

  // A small FQID pool so distinct providers frequently share an FQID (dedupe)
  // and frequently differ (ambiguity).
  const fqidArb = fc.constantFrom('alpha:x', 'beta:x', 'gamma:x', 'delta:x');

  it('precondition: the target name is open-world (absent from SkillName)', () => {
    expect(PUBLISHED.has(TARGET)).toBe(false);
  });

  it('returns ambiguous with ALL distinct candidates iff >=2 distinct FQIDs resolve', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fqidArb, { minLength: 0, maxLength: 6 }),
        async (emittedFqids) => {
          // Each emitted FQID belongs to a DISTINCT provider, so two providers
          // can map the same name to the same FQID (forcing dedupe collapse).
          const providers = emittedFqids.map((fqid, i) =>
            makeProvider(`prov${i}`, [{ fqid, name: TARGET }]),
          );

          const distinct = new Set(emittedFqids);
          const { resp } = await readByName(providers, TARGET);

          if (distinct.size === 0) {
            expect(resp.ok).toBe(false);
            if (!resp.ok) expect(resp.error.code).toBe('not_found');
            return;
          }

          if (distinct.size === 1) {
            // Same FQID across providers collapses to ONE candidate — never
            // ambiguous, and resolved without a silent pick of "the first".
            expect(resp.ok).toBe(true);
            if (resp.ok) {
              expect(resp.data.descriptor.fqid).toBe([...distinct][0]);
            }
            return;
          }

          // >=2 distinct FQIDs: must be `ambiguous` carrying EVERY distinct
          // candidate, never a silent first-match.
          expect(resp.ok).toBe(false);
          if (resp.ok) return;
          expect(resp.error.code).toBe('ambiguous');
          if (resp.error.code !== 'ambiguous') return;

          const candidateFqids = new Set(resp.error.candidates.map((c) => c.fqid));
          // All distinct FQIDs are present...
          expect(candidateFqids).toEqual(distinct);
          // ...and there is exactly one candidate per distinct FQID (deduped).
          expect(resp.error.candidates.length).toBe(distinct.size);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('never silently selects the first match (explicit two-distinct-FQID example)', async () => {
    const providers = [
      makeProvider('first', [{ fqid: 'first:x', name: TARGET }]),
      makeProvider('second', [{ fqid: 'second:x', name: TARGET }]),
    ];
    const { resp } = await readByName(providers, TARGET);

    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error.code).toBe('ambiguous');
    if (resp.error.code !== 'ambiguous') return;
    expect(new Set(resp.error.candidates.map((c) => c.fqid))).toEqual(
      new Set(['first:x', 'second:x']),
    );
  });
});
