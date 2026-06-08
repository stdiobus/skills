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
// Property 4 (design.md §5 — Collision → ambiguous; no silent first-match):
//   Single-skill resolution routes through the SAME conflict-aware dedupe that
//   `list`/`search` use, so resolution polarity is a pure function of the number
//   of CONTENT-DISTINCT descriptors among the resolved candidates:
//     0   -> not_found
//     1   -> ok (genuine duplicates — same FQID AND identical content — collapse
//            to one; resolution succeeds without a silent pick)
//     >=2 -> ambiguous, carrying EVERY content-distinct descriptor, never a
//            silent first-match.
//   Critically (the corrected Req 5.6 semantics): two DISTINCT descriptors that
//   COLLIDE on one FQID (same `fqid`, differing content) count as >=2 and are
//   `ambiguous` — they are NOT silently collapsed. Distinct FQIDs likewise yield
//   `ambiguous`.
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
// Property 4 — Collision → ambiguous; no silent first-match (Req 1.4, 2.7, 5.6)
//
// A single federated registry provider emits, for ONE target name, an arbitrary
// list of descriptors. Each descriptor draws its `fqid` and a content-bearing
// `layer` from small pools, while `name`/`provider`/`source` are FIXED — so two
// descriptors are CONTENT-IDENTICAL iff their (fqid, layer) pair is equal. This
// lets the generator freely produce all three cases the corrected Req 5.6
// semantics distinguish:
//   - same FQID + same layer  -> identical descriptors (genuine duplicate)
//   - same FQID + diff layer   -> DISTINCT descriptors colliding on one FQID
//   - different FQID           -> DISTINCT descriptors
//
// Resolution polarity is then a pure function of the number of CONTENT-DISTINCT
// descriptors (signature = all descriptor fields):
//   0   -> not_found
//   1   -> ok (duplicates collapsed; resolved fqid is that single descriptor's)
//   >=2 -> ambiguous, candidates == EVERY content-distinct descriptor, never a
//          silent first-match. A same-FQID/differing-content collision therefore
//          surfaces BOTH clashing descriptors instead of being silently dropped.
// =============================================================================

describe('Property 4: Collision → ambiguous; no silent first-match (Req 1.4, 2.7, 5.6)', () => {
  const TARGET = 'ambiguity-target';
  const REG_ID = 'registry';

  /** A descriptor record the registry provider owns for TARGET. */
  interface RegRecord {
    fqid: string;
    /** Content-bearing field; fixed name/provider/source means (fqid, layer) = identity. */
    layer: number;
  }

  const recordToDescriptor = (r: RegRecord): SkillDescriptor => ({
    fqid: r.fqid,
    name: TARGET,
    provider: REG_ID,
    source: `fake://${REG_ID}/${TARGET}`,
    layer: r.layer,
  });

  /**
   * A single federated registry provider that resolves TARGET to an explicit set
   * of descriptor records — modelling a registry that returns several records for
   * one name (the realistic source of a same-FQID collision). Driving the REAL
   * runtime over this provider exercises `resolveOne`'s conflict-aware dedupe.
   */
  function makeRegistryProvider(records: ReadonlyArray<RegRecord>): SkillProvider {
    const toResolved = (r: RegRecord): ResolvedSkill => {
      const descriptor = recordToDescriptor(r);
      return {
        descriptor,
        providerId: REG_ID,
        providerLocalRef: '__private__',
        provenanceSeed: { source: descriptor.source },
      };
    };
    return {
      id: REG_ID,
      capabilities: { read: true, list: true, search: false, references: false },
      async resolve(ref: SkillRef): Promise<ResolvedSkill[]> {
        if (ref.kind !== 'name' || ref.name !== TARGET) return [];
        if (ref.provider && ref.provider !== REG_ID) return [];
        return records.map(toResolved);
      },
      async read(resolved: ResolvedSkill): Promise<SkillContent> {
        return { descriptor: resolved.descriptor, body: `body:${resolved.descriptor.fqid}` };
      },
      async list(): Promise<ResolvedSkill[]> {
        return records.map(toResolved);
      },
    };
  }

  /** Canonical content-identity key for a record (mirrors the runtime's signature). */
  const identityKey = (r: RegRecord): string => `${r.fqid}|${r.layer}`;

  // Small pools so collisions (same fqid) and content clashes (diff layer) are common.
  const recordArb = fc.record({
    fqid: fc.constantFrom('alpha:x', 'beta:x', 'gamma:x'),
    layer: fc.constantFrom(1, 2),
  });

  it('precondition: the target name is open-world (absent from SkillName)', () => {
    expect(PUBLISHED.has(TARGET)).toBe(false);
  });

  it('polarity follows the content-distinct descriptor count; collisions are never silently picked', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(recordArb, { minLength: 0, maxLength: 6 }), async (records) => {
        const provider = makeRegistryProvider(records);
        const { resp } = await readByName([provider], TARGET);

        // The independent oracle: distinct descriptors keyed by full content identity.
        const distinctKeys = new Set(records.map(identityKey));

        if (distinctKeys.size === 0) {
          expect(resp.ok).toBe(false);
          if (!resp.ok) expect(resp.error.code).toBe('not_found');
          return;
        }

        if (distinctKeys.size === 1) {
          // Genuine duplicates (same FQID AND identical content) collapse to one —
          // resolution succeeds and is NOT a silent pick among differing descriptors.
          expect(resp.ok).toBe(true);
          if (resp.ok) {
            expect(resp.data.descriptor.fqid).toBe(records[0].fqid);
          }
          return;
        }

        // >=2 content-distinct descriptors: `ambiguous`, carrying EVERY distinct
        // descriptor (whether they differ by FQID or collide on one FQID), never a
        // silent first-match.
        expect(resp.ok).toBe(false);
        if (resp.ok) return;
        expect(resp.error.code).toBe('ambiguous');
        if (resp.error.code !== 'ambiguous') return;

        const candidateKeys = new Set(
          resp.error.candidates.map((c) => `${c.fqid}|${c.layer ?? ''}`),
        );
        expect(candidateKeys).toEqual(distinctKeys);
        expect(resp.error.candidates.length).toBe(distinctKeys.size);
      }),
      { numRuns: 400 },
    );
  });

  it('same FQID + DIFFERING content → ambiguous, surfacing BOTH clashing descriptors (Req 5.6)', async () => {
    // Two descriptors collide on one FQID but differ in content (layer). The
    // corrected Req 5.6 semantics: this is a conflict, NOT a silent collapse.
    const provider = makeRegistryProvider([
      { fqid: 'shared:x', layer: 1 },
      { fqid: 'shared:x', layer: 2 },
    ]);
    const { resp } = await readByName([provider], TARGET);

    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error.code).toBe('ambiguous');
    if (resp.error.code !== 'ambiguous') return;
    // Both clashing descriptors are reported (same fqid, different layer).
    expect(resp.error.candidates).toHaveLength(2);
    expect(new Set(resp.error.candidates.map((c) => c.fqid))).toEqual(new Set(['shared:x']));
    expect(new Set(resp.error.candidates.map((c) => c.layer))).toEqual(new Set([1, 2]));
  });

  it('same FQID + IDENTICAL content → collapses to one, resolves without a silent pick', async () => {
    // Two byte-for-byte identical descriptors are genuine duplicates: collapse to
    // one and resolve cleanly (not ambiguous).
    const provider = makeRegistryProvider([
      { fqid: 'dup:x', layer: 1 },
      { fqid: 'dup:x', layer: 1 },
    ]);
    const { resp } = await readByName([provider], TARGET);

    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data.descriptor.fqid).toBe('dup:x');
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
