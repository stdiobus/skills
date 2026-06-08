/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Federation Surface Reachability — federated-skills-runtime, Task 14
//
// Purpose: prove the rewritten `list_skills` / `search_skills` surface is
//          RUNTIME-AUTHORITATIVE and FEDERATION-CAPABLE — i.e. the federated
//          runtime `list`/`search` (aggregation, per-source diagnostics, native
//          provider search) is now REACHABLE through the exact calls the MCP
//          adapter makes (`runtime.list()` -> presentManifest,
//          `runtime.search()` -> presentSearch), instead of a manifest /
//          legacy-index side-channel.
//
//   1. list: a multi-provider runtime aggregates bundled + an external provider;
//      runtime.list() carries per-source aggregate diagnostics for BOTH providers,
//      and presentManifest renders the published (bundled) document (federated
//      names are not representable in the published manifest-document shape during
//      the compatibility phase, so they are excluded — Req 9.8).
//   2. search: a non-bundled provider's NATIVE search is reachable through
//      presentSearch — its results appear in the published search output, proving
//      federation reaches the product surface (Req 9.4, 9.1).
//
// Providers are genuine in-memory SkillProvider implementations (no mocking of the
// runtime under test).
//
// Validates: Requirements 9.4, 9.1, 4.5
// =============================================================================

import { createFileResolver } from '../../lib/file-resolver';
import { presentManifest } from '../../lib/manifest-presenter';
import { presentSearch, type PublishedSearchResult } from '../../lib/search-presenter';
import { FilesystemSkillProvider } from '../../runtime/providers/filesystem-provider';
import { SkillProviderRegistry, createRuntimeFromRegistry } from '../../runtime/registry';
import { bundledTrustPolicy } from '../../runtime/trust';
import { readAggregateDiagnostics } from '../../runtime/federation';
import type {
  ListSkillsInput,
  ReferenceContent,
  ReferenceDescriptor,
  ResolvedSkill,
  SearchResult,
  SearchSkillsInput,
  SkillContent,
  SkillProvider,
  SkillRef,
} from '../../runtime/contract';
import type { SkillManifest } from '../../types';

/** A small, genuine external provider that owns one skill and supports native search. */
function makeExternalProvider(): SkillProvider {
  const NAME = 'acme-remote-skill';
  const FQID = `external:${NAME}`;
  const SOURCE = 'remote://acme/acme-remote-skill';
  const BODY = '# Acme remote skill\n\nServed by a non-bundled provider.';

  const toResolved = (): ResolvedSkill => ({
    descriptor: { fqid: FQID, name: NAME, provider: 'external', source: SOURCE, layer: 3 },
    providerId: 'external',
    providerLocalRef: '__private__',
    provenanceSeed: { source: SOURCE },
  });

  const matches = (ref: SkillRef): boolean => {
    switch (ref.kind) {
      case 'name':
        return ref.name === NAME && (!ref.provider || ref.provider === 'external');
      case 'fqid':
        return ref.fqid === FQID;
      case 'descriptor':
        return ref.descriptor.fqid === FQID;
    }
  };

  return {
    id: 'external',
    capabilities: { read: true, list: true, search: true, references: true },
    async resolve(ref) {
      return matches(ref) ? [toResolved()] : [];
    },
    async read(resolved): Promise<SkillContent> {
      return { descriptor: resolved.descriptor, body: BODY };
    },
    async list(_input?: ListSkillsInput) {
      return [toResolved()];
    },
    async search(input: SearchSkillsInput): Promise<SearchResult[]> {
      const q = input.query.toLowerCase();
      if (!NAME.includes(q) && !'acme remote'.includes(q)) return [];
      return [{ descriptor: toResolved().descriptor, score: 42, description: 'Acme remote skill' }];
    },
    async listReferences(): Promise<ReferenceDescriptor[]> {
      return [];
    },
    async readReference(_resolved, reference): Promise<ReferenceContent> {
      return { path: reference, body: '' };
    },
  };
}

describe('list_skills is federation-capable through the runtime (Req 9.4, 4.5)', () => {
  let manifest: SkillManifest;

  beforeAll(async () => {
    manifest = await createFileResolver().readManifest();
  });

  it('aggregates bundled + external providers and records per-source diagnostics', async () => {
    const resolver = createFileResolver();
    const registry = new SkillProviderRegistry([
      { provider: new FilesystemSkillProvider({ search: true }), trust: bundledTrustPolicy(resolver.packageRoot) },
      { provider: makeExternalProvider() },
    ]);
    const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

    const listResp = await runtime.list();
    expect(listResp.ok).toBe(true);
    if (!listResp.ok) return;

    // The federated descriptor is present in the AUTHORITATIVE runtime list...
    expect(listResp.data.some((d) => d.fqid === 'external:acme-remote-skill')).toBe(true);
    // ...and the runtime recorded per-source aggregate diagnostics for BOTH providers
    // (this is the federation envelope the surface now reaches).
    const diag = readAggregateDiagnostics(listResp.provenance);
    expect(diag).toBeDefined();
    expect(diag!.sources.map((s) => s.provider).sort()).toEqual(['bundled', 'external']);
    expect(diag!.sources.every((s) => s.ok)).toBe(true);
  });

  it('presentManifest renders the published document; federated names excluded (compat phase, Req 9.8)', async () => {
    const resolver = createFileResolver();
    const registry = new SkillProviderRegistry([
      { provider: new FilesystemSkillProvider({ search: true }), trust: bundledTrustPolicy(resolver.packageRoot) },
      { provider: makeExternalProvider() },
    ]);
    const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

    const doc = JSON.parse(presentManifest(await runtime.list(), manifest).content[0].text) as SkillManifest;
    // Published document is byte-stable: exactly the manifest skills, external name excluded.
    expect(doc.skills.some((s) => s.name === 'acme-remote-skill')).toBe(false);
    expect(doc.skills.map((s) => s.name).sort()).toEqual(manifest.skills.map((s) => s.name).sort());
  });
});

describe('search_skills is federation-capable through the runtime (Req 9.4, 9.1)', () => {
  it("surfaces a non-bundled provider's native search results through presentSearch", async () => {
    // Register the external (native-search) provider FIRST so the runtime selects it as the
    // native search provider — proving a federated provider's search reaches the surface.
    const registry = new SkillProviderRegistry([
      { provider: makeExternalProvider() },
      { provider: new FilesystemSkillProvider({ search: true }) },
    ]);
    const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

    const resp = await runtime.search({ query: 'acme' });
    expect(resp.ok).toBe(true);

    const results = JSON.parse(presentSearch(resp).content[0].text) as PublishedSearchResult[];
    const acme = results.find((r) => r.skill === 'acme-remote-skill');
    expect(acme).toBeDefined();
    expect(acme!.score).toBe(42);
    expect(acme!.description).toBe('Acme remote skill');
    expect(acme!.layer).toBe(3);
  });
});
