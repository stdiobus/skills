/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Unit tests — PRE-READ content-size enforcement via the optional provider
// `readMetadata` size probe (Task 18; design §9; Req 11.5 "shall not load in full").
//
// Subjects under test (already implemented — NOT redefined here):
//   - SkillProvider.readMetadata (OPTIONAL size-probe capability)   (runtime/contract.ts)
//   - InProcessSkillsRuntime.enforceContentSizePreRead wiring in
//     read()/readReference(), reached through the registry → factory seam.
//
// Invariants validated:
//   1. A provider declaring an oversize via the probe is rejected as `content_too_large`
//      BEFORE its read()/readReference() body is materialized — the full read is NEVER
//      performed (the protective intent of Req 11.5).
//   2. Valid-size content declared by the probe passes through to a normal read.
//   3. A provider WITHOUT a probe still backstops via the existing post-read check, so the
//      bundled byte-for-byte baseline behavior is preserved.
//
// Validates: Requirements 11.5
// =============================================================================

import { SkillProviderRegistry, createRuntimeFromRegistry } from '../../../runtime/registry.js';
import type { TrustPolicy } from '../../../runtime/trust.js';
import type {
  ReferenceContent,
  ResolvedSkill,
  SkillContent,
  SkillContentMetadata,
  SkillProvider,
  SkillRef,
} from '../../../runtime/contract.js';

// An untrusted provider with a tiny ceiling so any non-trivial body is "oversize".
const TINY_CEILING: TrustPolicy = { tier: 'untrusted', maxContentBytes: 100, isolateFetch: false };

/**
 * Instrumented provider that records whether read()/readReference() actually ran, and
 * optionally implements the `readMetadata` size probe. `probeSize` controls the probe:
 * - a `number` → the declared size at source;
 * - `undefined` (with `hasProbe: true`) → probe present but declines to declare a size;
 * - `hasProbe: false` → no probe at all (absent capability → post-read backstop only).
 */
interface ProbeProvider extends SkillProvider {
  reads: number;
  refReads: number;
  probeCalls: number;
}

function makeProvider(
  id: string,
  body: string,
  opts: { hasProbe: boolean; probeSize?: number },
): ProbeProvider {
  const descriptor = {
    fqid: `${id}:alpha`,
    name: 'alpha',
    provider: id,
    source: `fake://${id}/alpha`,
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
    probeCalls: 0,
    capabilities: { read: true, list: true, search: false, references: true },
    async resolve(ref: SkillRef): Promise<ResolvedSkill[]> {
      const name =
        ref.kind === 'name' ? ref.name : ref.kind === 'fqid' ? null : ref.descriptor.name;
      return name === 'alpha' ? [resolved] : [];
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
  if (opts.hasProbe) {
    provider.readMetadata = async (): Promise<SkillContentMetadata> => {
      provider.probeCalls += 1;
      return { sizeBytes: opts.probeSize };
    };
  }
  return provider;
}

describe('pre-read content-size enforcement (Task 18, Req 11.5)', () => {
  // --- Invariant 1: oversize declared by the probe → reject BEFORE materializing -------

  it('rejects oversize content declared by the probe WITHOUT performing the full read()', async () => {
    // Body is 5,000 bytes; ceiling is 100; the probe declares the oversize at source.
    const provider = makeProvider('ext', 'x'.repeat(5_000), { hasProbe: true, probeSize: 5_000 });
    const registry = new SkillProviderRegistry([{ provider, trust: TINY_CEILING }]);
    const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

    const resp = await runtime.read({ ref: { kind: 'name', name: 'alpha' } });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('content_too_large');
      if (resp.error.code === 'content_too_large') {
        expect(resp.error.provider).toBe('ext');
        expect(resp.error.limitBytes).toBe(100);
      }
    }
    // The protective intent of Req 11.5: the body was NEVER materialized.
    expect(provider.probeCalls).toBe(1);
    expect(provider.reads).toBe(0);
  });

  it('rejects an oversize reference body declared by the probe WITHOUT reading it', async () => {
    const provider = makeProvider('ext', 'x'.repeat(5_000), { hasProbe: true, probeSize: 5_000 });
    const registry = new SkillProviderRegistry([{ provider, trust: TINY_CEILING }]);
    const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

    const resp = await runtime.readReference({
      ref: { kind: 'name', name: 'alpha' },
      reference: 'notes.md',
    });

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('content_too_large');
    // The oversize reference body was never materialized.
    expect(provider.probeCalls).toBe(1);
    expect(provider.refReads).toBe(0);
  });

  // --- Invariant 2: valid size declared by the probe → normal read ---------------------

  it('admits content the probe declares within the limit (normal read proceeds)', async () => {
    const body = 'small body';
    const provider = makeProvider('ext', body, { hasProbe: true, probeSize: body.length });
    const registry = new SkillProviderRegistry([{ provider, trust: TINY_CEILING }]);
    const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

    const resp = await runtime.read({ ref: { kind: 'name', name: 'alpha' } });

    expect(resp.ok).toBe(true);
    if (resp.ok) expect(resp.data.body).toBe(body);
    // Probe ran, then the read proceeded because the declared size was within the limit.
    expect(provider.probeCalls).toBe(1);
    expect(provider.reads).toBe(1);
  });

  // --- Invariant 3: absent probe → post-read backstop still enforces -------------------

  it('backstops via the post-read check when the provider has NO probe (bundled behavior)', async () => {
    // No probe at all: the body is materialized, then the post-read check rejects it. This
    // is exactly the pre-existing bundled behavior the backstop preserves.
    const provider = makeProvider('ext', 'x'.repeat(5_000), { hasProbe: false });
    const registry = new SkillProviderRegistry([{ provider, trust: TINY_CEILING }]);
    const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

    const resp = await runtime.read({ ref: { kind: 'name', name: 'alpha' } });

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('content_too_large');
    // No probe → the read happened (backstop path), but the oversize was still rejected.
    expect(provider.probeCalls).toBe(0);
    expect(provider.reads).toBe(1);
  });

  it('backstops when the probe is present but declines to declare a size (undefined)', async () => {
    // Probe present but returns no size → runtime falls through to the post-read backstop.
    const provider = makeProvider('ext', 'x'.repeat(5_000), { hasProbe: true, probeSize: undefined });
    const registry = new SkillProviderRegistry([{ provider, trust: TINY_CEILING }]);
    const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

    const resp = await runtime.read({ ref: { kind: 'name', name: 'alpha' } });

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('content_too_large');
    // Probe consulted, declined → read happened (backstop), oversize still rejected.
    expect(provider.probeCalls).toBe(1);
    expect(provider.reads).toBe(1);
  });

  it('admits a body within the default untrusted ceiling (probe declares an in-limit size)', async () => {
    // A registration that OMITS `trust` resolves to the least-privileged untrusted default
    // (~1 MB ceiling). The 5,000-byte body the probe declares is within that default, so the
    // pre-read guard returns null and the read proceeds normally.
    const provider = makeProvider('ext', 'x'.repeat(5_000), { hasProbe: true, probeSize: 5_000 });
    const registry = new SkillProviderRegistry([{ provider }]);
    const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

    const resp = await runtime.read({ ref: { kind: 'name', name: 'alpha' } });
    expect(resp.ok).toBe(true);
    if (resp.ok) expect(resp.data.body.length).toBe(5_000);
    expect(provider.probeCalls).toBe(1);
    expect(provider.reads).toBe(1);
  });
});
