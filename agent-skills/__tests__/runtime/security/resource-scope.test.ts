/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Unit tests — provider resource-scope contract for the path-traversal boundary
// (Task 23 / Milestone-002; design §9; Req 11.4).
//
// What this proves (the latent gap closed by Task 23):
//   Before: the runtime enforced `checkWithinRoot` against the trust policy's
//   `permittedRoot`, which for the bundled provider was the PACKAGE ROOT — but
//   reference files live under `{packageRoot}/agent-skills/{skill}/references`. A
//   cross-skill reference with NO `..` (e.g. an absolute path into a SIBLING skill's
//   references dir, still under the package root) PASSED the runtime guard and was
//   caught only by the FileResolver containment as a thrown provider_error. The
//   runtime boundary was therefore weaker than — not a generalization of — the
//   FileResolver guard.
//
//   After: a provider declares its effective resource root via the OPTIONAL
//   `SkillProvider.resourceRoot` contract. The runtime enforces `checkWithinRoot`
//   against THAT root, so a cross-skill reference is now rejected as `out_of_bounds`
//   by the RUNTIME guard itself (the location is never read). A provider that
//   exposes no resource root opts out, and the runtime falls back to the provider's
//   own containment.
//
// Subjects under test (already implemented — NOT redefined here):
//   - InProcessSkillsRuntime.enforceWithinRoot wiring (via createRuntimeFromRegistry)
//   - SkillProvider.resourceRoot contract
//   - checkWithinRoot (used here only to demonstrate the OLD packageRoot guard would
//     have admitted the cross-skill path — i.e. the new guard is a true generalization)
//
// Validates: Requirements 11.4
// =============================================================================

import * as path from 'path';

import { checkWithinRoot } from '../../../runtime/security/boundary.js';
import { SkillProviderRegistry, createRuntimeFromRegistry } from '../../../runtime/registry.js';
import { bundledTrustPolicy, type TrustPolicy } from '../../../runtime/trust.js';
import type {
  ReferenceContent,
  ResolvedSkill,
  SkillContent,
  SkillProvider,
  SkillRef,
} from '../../../runtime/contract.js';

// The simulated package root (the COARSE, old boundary) and the resolved skill's
// genuine references root (the CORRECT, scoped boundary).
const PACKAGE_ROOT = path.resolve('/srv/skills/pkg');
const SKILL = 'alpha';
const ALPHA_REFS_ROOT = path.join(PACKAGE_ROOT, 'agent-skills', SKILL, 'references');
// A cross-skill reference with NO `..`: an absolute path into a SIBLING skill's
// references dir. It is genuinely INSIDE the package root but OUTSIDE alpha's
// references root — exactly the path the old packageRoot guard let through.
const CROSS_SKILL_REF = path.join(PACKAGE_ROOT, 'agent-skills', 'beta', 'references', 'secret.md');

// =============================================================================
// Instrumented providers
// =============================================================================

interface ProbeProvider extends SkillProvider {
  refReads: number;
}

/**
 * A provider that DECLARES its resource root (the resolved skill's references dir),
 * mirroring the bundled FilesystemSkillProvider. Its `readReference` is instrumented
 * and has NO containment of its own, so any rejection must come from the RUNTIME guard.
 */
function makeScopedProvider(id = 'bundled'): ProbeProvider {
  const descriptor = {
    fqid: `${id}:${SKILL}`,
    name: SKILL,
    provider: id,
    source: `agent-skills/${SKILL}/SKILL.md`,
  };
  const resolved: ResolvedSkill = {
    descriptor,
    providerId: id,
    providerLocalRef: SKILL,
    provenanceSeed: { source: descriptor.source },
  };
  const provider: ProbeProvider = {
    id,
    refReads: 0,
    capabilities: { read: true, list: true, search: false, references: true },
    async resolve(ref: SkillRef): Promise<ResolvedSkill[]> {
      const name = ref.kind === 'name' ? ref.name : ref.kind === 'fqid' ? null : ref.descriptor.name;
      return name === SKILL ? [resolved] : [];
    },
    async read(): Promise<SkillContent> {
      return { descriptor, body: 'alpha body' };
    },
    // No own `..` / containment guard: returns content for ANY path it is asked to read.
    async readReference(_r, reference): Promise<ReferenceContent> {
      provider.refReads += 1;
      return { path: reference, body: `body-for:${reference}` };
    },
    // Resource-scope declaration: the resolved skill's references root.
    resourceRoot(): string {
      return ALPHA_REFS_ROOT;
    },
  };
  return provider;
}

/**
 * A provider that exposes NO resource root (no `resourceRoot`, untrusted default → no
 * `permittedRoot`), but enforces its OWN containment by rejecting `..` paths. Models a
 * remote/DB provider whose containment is internal to the provider.
 */
function makeOwnContainmentProvider(id = 'remote'): ProbeProvider {
  const descriptor = {
    fqid: `${id}:${SKILL}`,
    name: SKILL,
    provider: id,
    source: `remote://${id}/${SKILL}`,
  };
  const resolved: ResolvedSkill = {
    descriptor,
    providerId: id,
    providerLocalRef: SKILL,
    provenanceSeed: { source: descriptor.source },
  };
  const provider: ProbeProvider = {
    id,
    refReads: 0,
    capabilities: { read: true, list: true, search: false, references: true },
    async resolve(ref: SkillRef): Promise<ResolvedSkill[]> {
      const name = ref.kind === 'name' ? ref.name : ref.kind === 'fqid' ? null : ref.descriptor.name;
      return name === SKILL ? [resolved] : [];
    },
    async readReference(_r, reference): Promise<ReferenceContent> {
      provider.refReads += 1;
      // The provider's OWN containment — the runtime applies no path guard for this
      // provider (it declares no resource root), so this is the backstop.
      if (reference.includes('..')) {
        throw new Error('own-containment: directory traversal not allowed');
      }
      return { path: reference, body: `remote-body:${reference}` };
    },
    // NOTE: no `resourceRoot` method → opts out of the runtime path guard.
  };
  return provider;
}

// =============================================================================
// The runtime guard is now a TRUE generalization (Req 11.4)
// =============================================================================

describe('Provider resource-scope contract scopes the path-traversal boundary (Req 11.4)', () => {
  it('rejects a cross-skill reference (no "..") as out_of_bounds at the RUNTIME guard, never reading it', async () => {
    const provider = makeScopedProvider('bundled');
    // The trust policy carries the COARSE package root as permittedRoot — the OLD
    // (looser) boundary. The provider's declared resourceRoot must take precedence.
    const registry = new SkillProviderRegistry([
      { provider, trust: bundledTrustPolicy(PACKAGE_ROOT) },
    ]);
    const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

    // Demonstrate the gap: the OLD packageRoot guard WOULD have admitted this path —
    // so catching it now is a genuine strengthening, not a duplicate of the `..` check.
    const oldGuard = checkWithinRoot(PACKAGE_ROOT, CROSS_SKILL_REF, 'bundled');
    expect(oldGuard.ok).toBe(true);

    const resp = await runtime.readReference({
      ref: { kind: 'name', name: SKILL },
      reference: CROSS_SKILL_REF,
    });

    // The NEW guard, scoped to the skill's references root, rejects it.
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('out_of_bounds');
      if (resp.error.code === 'out_of_bounds') expect(resp.error.provider).toBe('bundled');
    }
    // The out-of-bounds location was NEVER read — caught by the runtime, not the provider.
    expect(provider.refReads).toBe(0);
  });

  it('still admits a valid in-references reference (valid reads unchanged)', async () => {
    const provider = makeScopedProvider('bundled');
    const registry = new SkillProviderRegistry([
      { provider, trust: bundledTrustPolicy(PACKAGE_ROOT) },
    ]);
    const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

    const resp = await runtime.readReference({
      ref: { kind: 'name', name: SKILL },
      reference: 'guide.md',
    });

    expect(resp.ok).toBe(true);
    if (resp.ok) expect(resp.data.body).toBe('body-for:guide.md');
    expect(provider.refReads).toBe(1);
  });

  it('also rejects a ".." traversal as out_of_bounds (the generalization still subsumes the base case)', async () => {
    const provider = makeScopedProvider('bundled');
    const registry = new SkillProviderRegistry([
      { provider, trust: bundledTrustPolicy(PACKAGE_ROOT) },
    ]);
    const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

    const resp = await runtime.readReference({
      ref: { kind: 'name', name: SKILL },
      reference: '../../beta/references/secret.md',
    });

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('out_of_bounds');
    expect(provider.refReads).toBe(0);
  });
});

// =============================================================================
// A provider with NO resource root falls back to its own containment (Req 11.4)
// =============================================================================

describe('A provider that declares no resource root falls back to its own containment (Req 11.4)', () => {
  it('the runtime applies no path guard and delegates — the provider\'s own containment fires', async () => {
    const provider = makeOwnContainmentProvider('remote');
    // Untrusted default registration: no permittedRoot, and the provider declares no
    // resourceRoot → the runtime applies NO path guard for it.
    const registry = new SkillProviderRegistry([{ provider }]);
    const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

    const resp = await runtime.readReference({
      ref: { kind: 'name', name: SKILL },
      reference: '../../../etc/passwd',
    });

    // The rejection comes from the PROVIDER's own containment (a thrown error surfaced as
    // provider_error), NOT from a runtime out_of_bounds guard — proving the documented
    // fallback. The runtime delegated (the provider was invoked).
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('provider_error');
      if (resp.error.code === 'provider_error') expect(resp.error.provider).toBe('remote');
    }
    expect(provider.refReads).toBe(1);
  });

  it('admits an in-bounds reference through the provider when no resource root is declared', async () => {
    const provider = makeOwnContainmentProvider('remote');
    const registry = new SkillProviderRegistry([{ provider }]);
    const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

    const resp = await runtime.readReference({
      ref: { kind: 'name', name: SKILL },
      reference: 'notes.md',
    });

    expect(resp.ok).toBe(true);
    if (resp.ok) expect(resp.data.body).toBe('remote-body:notes.md');
    expect(provider.refReads).toBe(1);
  });
});

// =============================================================================
// The bundled FilesystemSkillProvider exposes its references root (true generalization)
// =============================================================================

describe('FilesystemSkillProvider exposes its references root via the resource-scope contract', () => {
  it('declares resourceRoot equal to the FileResolver references root for the resolved skill', async () => {
    const { FilesystemSkillProvider } = await import('../../../runtime/providers/filesystem-provider.js');
    const { createFileResolver } = await import('../../../lib/file-resolver.js');

    const provider = new FilesystemSkillProvider();
    const resolver = createFileResolver();

    const resolved = (await provider.resolve({ kind: 'name', name: 'runtime-concepts' }))[0];
    expect(resolved).toBeDefined();

    const root = provider.resourceRoot!(resolved!);
    expect(root).toBe(resolver.referencesRoot('runtime-concepts'));
    expect(root).toBe(path.join(resolver.packageRoot, 'agent-skills', 'runtime-concepts', 'references'));
  });

  it('a valid published reference still reads byte-for-byte under the scoped guard', async () => {
    const { FilesystemSkillProvider } = await import('../../../runtime/providers/filesystem-provider.js');
    const { createFileResolver } = await import('../../../lib/file-resolver.js');

    const resolver = createFileResolver();
    const provider = new FilesystemSkillProvider({ search: true });
    const trust: TrustPolicy = bundledTrustPolicy(resolver.packageRoot);
    const registry = new SkillProviderRegistry([{ provider, trust }]);
    const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

    const refs = await runtime.getReferences({ ref: { kind: 'name', name: 'runtime-concepts' } });
    expect(refs.ok).toBe(true);
    if (!refs.ok) return;
    const first = refs.data[0]?.path;
    expect(first).toBeDefined();

    const resp = await runtime.readReference({
      ref: { kind: 'name', name: 'runtime-concepts' },
      reference: first!,
    });
    expect(resp.ok).toBe(true);
    if (resp.ok) expect(resp.data.body.length).toBeGreaterThan(0);
  });
});
