/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Unit tests — provider registry resolution & pinned subset (Migration Step 2,
// Task 4.3; design §4a, §6).
//
// Subjects under test (already implemented — NOT redefined here):
//   - SkillProviderRegistry / createRuntimeFromRegistry  (runtime/registry.ts)
//   - pinnedDescriptors                                  (runtime/pinned.ts)
// driven through the REAL InProcessSkillsRuntime obtained via the registry →
// transport-factory seam, plus small in-memory SkillProviders (no mocking of
// the runtime under test).
//
// Invariants validated:
//   1. Addressable skills are recomputed per operation from the registered
//      providers — registering a provider then listing/resolving reflects the
//      new provider with no rebuild step (Req 1.1).
//   2. Pinned descriptors carry `pinned: true` and stay resolvable by exact
//      name through the runtime (Req 1.7, 9.3).
//   3. The `SkillName` enum is NOT consulted during resolution: an open-world
//      name absent from the enum still resolves when a provider supplies it,
//      and a published enum name does NOT resolve when no provider supplies it
//      (resolution never gates on enum membership) (Req 1.3, 1.6, 9.3).
//
// Validates: Requirements 1.1, 1.3, 1.7, 9.3
// =============================================================================

import * as path from 'path';

import {
  SkillProviderRegistry,
  createRuntimeFromRegistry,
  type ProviderRegistration,
} from '../../runtime/registry.js';
import { pinnedDescriptors } from '../../runtime/pinned.js';
import { createFileResolver } from '../../lib/file-resolver.js';
import { SkillName, type SkillManifest } from '../../types.js';
import type {
  ResolvedSkill,
  SkillDescriptor,
  SkillProvider,
  SkillRef,
} from '../../runtime/contract.js';

// -----------------------------------------------------------------------------
// In-memory provider — a real SkillProvider whose backing skill list is captured
// by closure, so mutating that list after the runtime is built proves the
// runtime re-invokes the provider on each operation (no cached/built index).
// -----------------------------------------------------------------------------

interface FakeSkill {
  descriptor: SkillDescriptor;
  body?: string;
}

/** Build a `SkillDescriptor`; `pinned`/`layer` etc. supplied via `extra`. */
function desc(provider: string, name: string, extra: Partial<SkillDescriptor> = {}): SkillDescriptor {
  return {
    fqid: `${provider}:${name}`,
    name,
    provider,
    source: `fake://${provider}/${name}`,
    ...extra,
  };
}

/**
 * Build a real {@link SkillProvider} over a (possibly mutable) `skills` array.
 * `resolve`/`list` read the array on every call, so callers can push new skills
 * to prove per-operation recomputation.
 */
function makeProvider(
  id: string,
  skills: FakeSkill[],
  opts: { withList?: boolean; withRead?: boolean } = {},
): SkillProvider {
  const withList = opts.withList ?? true;
  const withRead = opts.withRead ?? true;

  const toResolved = (s: FakeSkill): ResolvedSkill => ({
    descriptor: s.descriptor,
    providerId: id,
    providerLocalRef: '__private__',
    provenanceSeed: { source: s.descriptor.source },
  });

  const matches = (ref: SkillRef): FakeSkill[] => {
    switch (ref.kind) {
      case 'name':
        if (ref.provider && ref.provider !== id) return [];
        return skills.filter((s) => s.descriptor.name === ref.name);
      case 'fqid':
        return skills.filter((s) => s.descriptor.fqid === ref.fqid);
      case 'descriptor':
        return skills.filter((s) => s.descriptor.fqid === ref.descriptor.fqid);
    }
  };

  const provider: SkillProvider = {
    id,
    capabilities: { read: withRead, list: withList, search: false, references: false },
    async resolve(ref: SkillRef): Promise<ResolvedSkill[]> {
      return matches(ref).map(toResolved);
    },
  };

  if (withRead) {
    provider.read = async (resolved) => {
      const s = skills.find((x) => x.descriptor.fqid === resolved.descriptor.fqid);
      return { descriptor: resolved.descriptor, body: s?.body ?? '' };
    };
  }

  if (withList) {
    provider.list = async () => skills.map(toResolved);
  }

  return provider;
}

// =============================================================================
// Invariant 1 — dynamic registry: recompute per operation, no rebuild (Req 1.1)
// =============================================================================

describe('SkillProviderRegistry — open-world registration, no rebuild (Req 1.1)', () => {
  it('registering a provider then building a runtime reflects it with no rebuild step', async () => {
    const registry = new SkillProviderRegistry();
    registry.register({ provider: makeProvider('pa', [{ descriptor: desc('pa', 'alpha'), body: 'A' }]) });

    // Runtime built over the registry as of this call.
    const runtime1 = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

    const list1 = await runtime1.list();
    expect(list1.ok).toBe(true);
    if (!list1.ok) return;
    expect(list1.data.map((d) => d.fqid).sort()).toEqual(['pa:alpha']);

    // `beta` is not registered yet → open-world not_found, registry unchanged.
    const missing = await runtime1.read({ ref: { kind: 'name', name: 'beta' } });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('not_found');

    // Open-world registration: a plain method call, NO package rebuild.
    registry.register({ provider: makeProvider('pb', [{ descriptor: desc('pb', 'beta'), body: 'B' }]) });

    // A fresh runtime over the same registry now reflects BOTH providers.
    const runtime2 = createRuntimeFromRegistry({ kind: 'in-process' }, registry);
    const list2 = await runtime2.list();
    expect(list2.ok).toBe(true);
    if (!list2.ok) return;
    expect(list2.data.map((d) => d.fqid).sort()).toEqual(['pa:alpha', 'pb:beta']);

    const beta = await runtime2.read({ ref: { kind: 'name', name: 'beta' } });
    expect(beta.ok).toBe(true);
    if (beta.ok) expect(beta.data.body).toBe('B');
  });

  it('preserves registration order as precedence in `registrations` and `providers()`', () => {
    const a: ProviderRegistration = { provider: makeProvider('pa', []) };
    const b: ProviderRegistration = { provider: makeProvider('pb', []) };
    const c: ProviderRegistration = { provider: makeProvider('pc', []) };

    const registry = new SkillProviderRegistry([a, b]);
    registry.register(c);

    expect(registry.registrations.map((r) => r.provider.id)).toEqual(['pa', 'pb', 'pc']);
    expect(registry.providers().map((p) => p.id)).toEqual(['pa', 'pb', 'pc']);
  });

  it('recomputes addressable skills on EACH operation from the live providers (no cached index)', async () => {
    // A single mutable backing list shared with one runtime instance.
    const skills: FakeSkill[] = [{ descriptor: desc('mut', 'alpha'), body: 'A' }];
    const registry = new SkillProviderRegistry([{ provider: makeProvider('mut', skills) }]);
    const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

    const first = await runtime.list();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.map((d) => d.fqid)).toEqual(['mut:alpha']);

    // `gamma` is not addressable yet.
    const before = await runtime.read({ ref: { kind: 'name', name: 'gamma' } });
    expect(before.ok).toBe(false);
    if (!before.ok) expect(before.error.code).toBe('not_found');

    // Mutate the provider's source-of-truth WITHOUT rebuilding the runtime.
    skills.push({ descriptor: desc('mut', 'gamma'), body: 'G' });

    // The SAME runtime now lists and resolves `gamma`, proving per-operation
    // recomputation rather than a one-time build.
    const second = await runtime.list();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.map((d) => d.fqid).sort()).toEqual(['mut:alpha', 'mut:gamma']);

    const after = await runtime.read({ ref: { kind: 'name', name: 'gamma' } });
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.data.body).toBe('G');
  });
});

// =============================================================================
// Invariant 2 — pinned subset carries `pinned: true` and resolves by exact name
// (Req 1.7, 9.3)
// =============================================================================

describe('pinnedDescriptors — pinned subset (Req 1.7, 9.3)', () => {
  // Root such that createFileResolver finds agent-skills/skills-manifest.json.
  const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..');
  let manifest: SkillManifest;
  let pinned: SkillDescriptor[];

  beforeAll(async () => {
    manifest = await createFileResolver(PACKAGE_ROOT).readManifest();
    pinned = pinnedDescriptors(manifest);
  });

  it('marks every published descriptor with pinned:true, provider:bundled, and a bundled FQID', () => {
    const published = new Set<string>(Object.values(SkillName));
    expect(pinned.length).toBe(published.size);

    for (const d of pinned) {
      expect(d.pinned).toBe(true);
      expect(d.provider).toBe('bundled');
      expect(published.has(d.name)).toBe(true);
      expect(d.fqid).toBe(`bundled:${d.name}`);
    }
  });

  it('uses SkillName only as a seed: a non-published manifest entry is excluded', () => {
    const augmented: SkillManifest = {
      ...manifest,
      skills: [
        ...manifest.skills,
        {
          name: 'totally-unpublished-skill',
          layer: 9,
          versionRange: '>=0.0.0',
          status: 'valid',
          lastValidated: '2026-01-01T00:00:00.000Z',
        },
      ],
    };

    const result = pinnedDescriptors(augmented);
    expect(result.some((d) => d.name === 'totally-unpublished-skill')).toBe(false);
    expect(result.length).toBe(pinned.length);
  });

  it('keeps pinned descriptors resolvable by EXACT name through the runtime', async () => {
    // A provider that serves the pinned descriptors verbatim (preserving the
    // pinned flag) so resolution through the runtime carries `pinned: true`.
    const skills: FakeSkill[] = pinned.map((descriptor) => ({ descriptor, body: `body:${descriptor.name}` }));
    const registry = new SkillProviderRegistry([{ provider: makeProvider('bundled', skills) }]);
    const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

    const target = pinned.find((d) => d.name === SkillName.RuntimeConcepts)!;
    expect(target).toBeDefined();

    const resp = await runtime.read({ ref: { kind: 'name', name: target.name } });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data.descriptor.fqid).toBe(`bundled:${target.name}`);
    expect(resp.data.descriptor.pinned).toBe(true);
    expect(resp.provenance.fqid).toBe(`bundled:${target.name}`);

    // Exact-name only: a near-miss does not resolve to a pinned descriptor.
    const nearMiss = await runtime.read({ ref: { kind: 'name', name: `${target.name}-x` } });
    expect(nearMiss.ok).toBe(false);
    if (!nearMiss.ok) expect(nearMiss.error.code).toBe('not_found');
  });
});

// =============================================================================
// Invariant 3 — SkillName enum is NOT a resolution gate (Req 1.3, 1.6, 9.3)
// =============================================================================

describe('Resolution does not consult the SkillName enum (Req 1.3, 1.6, 9.3)', () => {
  const OPEN_WORLD_NAME = 'open-world-skill-not-in-enum';

  it('precondition: the open-world name is genuinely absent from SkillName', () => {
    expect(Object.values(SkillName) as string[]).not.toContain(OPEN_WORLD_NAME);
  });

  it('resolves an open-world name absent from the enum when a provider supplies it', async () => {
    const registry = new SkillProviderRegistry([
      { provider: makeProvider('ext', [{ descriptor: desc('ext', OPEN_WORLD_NAME), body: 'open' }]) },
    ]);
    const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

    const resp = await runtime.read({ ref: { kind: 'name', name: OPEN_WORLD_NAME } });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data.body).toBe('open');
    expect(resp.data.descriptor.fqid).toBe(`ext:${OPEN_WORLD_NAME}`);

    const listed = await runtime.list();
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.data.some((d) => d.name === OPEN_WORLD_NAME)).toBe(true);
  });

  it('does NOT resolve a published enum name when no provider supplies it', async () => {
    // Only the open-world provider is registered; `runtime-concepts` is a member
    // of SkillName but no provider serves it. Enum membership alone must not make
    // it resolvable — the runtime returns not_found, never a silent success.
    const enumName = SkillName.RuntimeConcepts;
    expect(Object.values(SkillName) as string[]).toContain(enumName);

    const registry = new SkillProviderRegistry([
      { provider: makeProvider('ext', [{ descriptor: desc('ext', OPEN_WORLD_NAME) }]) },
    ]);
    const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

    const resp = await runtime.read({ ref: { kind: 'name', name: enumName } });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('not_found');
  });
});
