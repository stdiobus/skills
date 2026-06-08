/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Unit tests for the provenance finalization policy (Task 21, Req 2.9)
//
// Subject: runtime/provenance.ts — the single point where a provider ProvenanceSeed
// becomes the runtime-owned Provenance envelope. The runtime, NOT the provider, owns
// the provenance shape:
//   (a) reserved runtime-owned keys (fqid, provider, source, resolvedFrom,
//       aggregateDiagnostics, providerMetadata) are NEVER admitted from a seed;
//   (b) remaining provider-supplied keys are namespaced under `providerMetadata` so
//       they can never collide with a runtime-owned top-level field;
//   (c) each admitted value must be JSON-serializable and fit the size bound — anything
//       non-serializable or oversized is SAFE-DROPPED (the success path is never failed).
//
// Both the pure policy functions AND the real runtime `read` path are exercised: a
// provider whose seed injects reserved keys / heavy / non-serializable payloads must
// not be able to shape the finalized single-skill provenance.
//
// Validates: Requirements 2.9
// =============================================================================

import { FilesystemSkillProvider } from '../../runtime/providers/filesystem-provider.js';
import { InProcessSkillsRuntime } from '../../runtime/in-process-runtime.js';
import {
  MAX_PROVIDER_SEED_BYTES,
  PROVIDER_METADATA_KEY,
  finalizeProvenance,
  sanitizeProvenanceSeed,
} from '../../runtime/provenance.js';
import { AGGREGATE_DIAGNOSTICS_KEY } from '../../runtime/federation.js';
import type {
  ProvenanceSeed,
  ResolvedSkill,
  SkillProvider,
  SkillRef,
  SkillResponse,
} from '../../runtime/contract.js';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const FQID = 'fake:skill-a';
const PROVIDER = 'fake';
const SOURCE = 'fake://fake/skill-a';
const ASKED: SkillRef = { kind: 'name', name: 'skill-a' };

function makeResolved(seed: ProvenanceSeed): ResolvedSkill {
  return {
    descriptor: { fqid: FQID, name: 'skill-a', provider: PROVIDER, source: SOURCE },
    providerId: PROVIDER,
    providerLocalRef: '__private__',
    provenanceSeed: seed,
  };
}

/** A single-skill provider whose resolved skill carries a caller-supplied seed verbatim. */
function makeSeedProvider(seed: ProvenanceSeed): SkillProvider {
  const resolved = makeResolved(seed);
  return {
    id: PROVIDER,
    capabilities: { read: true, list: false, search: false, references: false },
    async resolve(ref: SkillRef): Promise<ResolvedSkill[]> {
      if (ref.kind === 'name' && ref.name === 'skill-a') return [resolved];
      if (ref.kind === 'fqid' && ref.fqid === FQID) return [resolved];
      return [];
    },
    async read(r) {
      return { descriptor: r.descriptor, body: 'BODY' };
    },
  };
}

// =============================================================================
// sanitizeProvenanceSeed — the policy in isolation
// =============================================================================

describe('sanitizeProvenanceSeed (Req 2.9 policy)', () => {
  it('returns undefined for a {source}-only seed (no extra keys → no namespace bag)', () => {
    expect(sanitizeProvenanceSeed({ source: SOURCE })).toBeUndefined();
  });

  it('drops every reserved runtime-owned key, including aggregateDiagnostics', () => {
    const seed: ProvenanceSeed = {
      source: SOURCE,
      fqid: 'forged',
      provider: 'forged',
      resolvedFrom: { kind: 'name', name: 'forged' },
      [AGGREGATE_DIAGNOSTICS_KEY]: { sources: [], conflicts: [] },
      [PROVIDER_METADATA_KEY]: { forged: true },
    };
    // Every key is reserved → nothing admitted → undefined.
    expect(sanitizeProvenanceSeed(seed)).toBeUndefined();
  });

  it('namespaces legitimate extra keys (JSON round-tripped)', () => {
    const bag = sanitizeProvenanceSeed({
      source: SOURCE,
      fetchedAt: '2026-01-01T00:00:00Z',
      cacheHit: true,
      etag: 'abc123',
    });
    expect(bag).toEqual({ fetchedAt: '2026-01-01T00:00:00Z', cacheHit: true, etag: 'abc123' });
  });

  it('drops non-serializable values (circular, bigint, function, symbol)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const bag = sanitizeProvenanceSeed({
      source: SOURCE,
      keep: 'ok',
      circular,
      big: BigInt(5) as unknown,
      fn: (() => 1) as unknown,
      sym: Symbol('s') as unknown,
    });
    // Only the serializable key survives.
    expect(bag).toEqual({ keep: 'ok' });
  });

  it('drops a value that exceeds the size bound, keeps small ones (safe drop)', () => {
    const huge = 'x'.repeat(MAX_PROVIDER_SEED_BYTES + 100);
    const bag = sanitizeProvenanceSeed({ source: SOURCE, small: 'tiny', huge });
    expect(bag).toEqual({ small: 'tiny' });
  });
});

// =============================================================================
// finalizeProvenance — the runtime-owned envelope
// =============================================================================

describe('finalizeProvenance (Req 2.9)', () => {
  it('bundled {source}-only seed → unchanged core envelope, no namespace key', () => {
    const provenance = finalizeProvenance(makeResolved({ source: SOURCE }), ASKED);
    expect(provenance).toEqual({
      fqid: FQID,
      provider: PROVIDER,
      source: SOURCE,
      resolvedFrom: ASKED,
    });
    expect(PROVIDER_METADATA_KEY in provenance).toBe(false);
  });

  it('core fields come from the runtime, never from forged seed keys', () => {
    const provenance = finalizeProvenance(
      makeResolved({
        source: SOURCE,
        fqid: 'forged-fqid',
        provider: 'forged-provider',
        resolvedFrom: { kind: 'name', name: 'forged' },
      }),
      ASKED,
    );
    expect(provenance.fqid).toBe(FQID);
    expect(provenance.provider).toBe(PROVIDER);
    expect(provenance.source).toBe(SOURCE);
    expect(provenance.resolvedFrom).toEqual(ASKED);
  });

  it('a seed-injected aggregateDiagnostics never appears in single-skill provenance', () => {
    const provenance = finalizeProvenance(
      makeResolved({
        source: SOURCE,
        [AGGREGATE_DIAGNOSTICS_KEY]: { sources: [{ provider: 'x', ok: true }], conflicts: [] },
      }),
      ASKED,
    );
    expect(AGGREGATE_DIAGNOSTICS_KEY in provenance).toBe(false);
    const bag = provenance[PROVIDER_METADATA_KEY] as Record<string, unknown> | undefined;
    expect(bag?.[AGGREGATE_DIAGNOSTICS_KEY]).toBeUndefined();
  });

  it('legitimate extra seed keys are namespaced, not placed at the top level', () => {
    const provenance = finalizeProvenance(
      makeResolved({ source: SOURCE, fetchedAt: 'T', cacheHit: false }),
      ASKED,
    );
    expect('fetchedAt' in provenance).toBe(false);
    expect('cacheHit' in provenance).toBe(false);
    expect(provenance[PROVIDER_METADATA_KEY]).toEqual({ fetchedAt: 'T', cacheHit: false });
  });
});

// =============================================================================
// Runtime-level: a provider cannot shape provenance through read()
// =============================================================================

describe('runtime read() provenance integrity (Req 2.9)', () => {
  it('strips a seed-injected aggregateDiagnostics + heavy payload from the result provenance', async () => {
    const runtime = new InProcessSkillsRuntime([
      makeSeedProvider({
        source: SOURCE,
        [AGGREGATE_DIAGNOSTICS_KEY]: { sources: [], conflicts: [] },
        heavy: 'x'.repeat(MAX_PROVIDER_SEED_BYTES + 1),
        note: 'kept',
      }),
    ]);

    const resp: SkillResponse<unknown> = await runtime.read({ ref: ASKED });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;

    // Core envelope intact; reserved + oversized seed keys never leaked.
    expect(resp.provenance.fqid).toBe(FQID);
    expect(AGGREGATE_DIAGNOSTICS_KEY in resp.provenance).toBe(false);
    expect('heavy' in resp.provenance).toBe(false);
    const bag = resp.provenance[PROVIDER_METADATA_KEY] as Record<string, unknown>;
    expect(bag).toEqual({ note: 'kept' });
    expect(JSON.stringify(resp.provenance)).not.toContain('x'.repeat(MAX_PROVIDER_SEED_BYTES + 1));
  });

  it('the real bundled FilesystemSkillProvider yields an unchanged {source}-only provenance shape', async () => {
    const runtime = new InProcessSkillsRuntime([new FilesystemSkillProvider()]);
    const resp = await runtime.read({ ref: { kind: 'name', name: 'runtime-concepts' } });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    // Bundled provider contributes only {source} → no namespace key is added.
    expect(PROVIDER_METADATA_KEY in resp.provenance).toBe(false);
    expect(Object.keys(resp.provenance).sort()).toEqual(
      ['fqid', 'provider', 'resolvedFrom', 'source'].sort(),
    );
  });
});
