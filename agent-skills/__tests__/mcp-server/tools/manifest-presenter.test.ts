/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// ManifestPresenter Tests — federated-skills-runtime, Task 14
//
// Purpose: prove `list_skills` is RUNTIME-AUTHORITATIVE (Req 9.4) while keeping
//          the published manifest-document shape byte-for-byte (Req 9.8).
//
//   1. presentManifest over a REAL runtime.list() reconstructs the manifest
//      registry document BYTE-FOR-BYTE (== JSON.stringify(manifest, null, 2)).
//   2. The runtime is authoritative for membership/order: a partial authoritative
//      descriptor list renders only those published entries, in that order.
//   3. A federated (non-manifest) descriptor is not representable in the published
//      document and is skipped during the compatibility phase.
//   4. A runtime error renders a typed tool error (isError), never throws.
//
// The runtime is wired EXACTLY as the bundled adapter wires it (registry ->
// in-process runtime over the real FilesystemSkillProvider). No mocking of the
// runtime under test.
//
// Validates: Requirements 9.4, 9.8
// =============================================================================

import { createFileResolver } from '../../../lib/file-resolver';
import { presentManifest } from '../../../lib/manifest-presenter';
import { FilesystemSkillProvider } from '../../../runtime/providers/filesystem-provider';
import { SkillProviderRegistry, createRuntimeFromRegistry } from '../../../runtime/registry';
import { bundledTrustPolicy } from '../../../runtime/trust';
import type { SkillDescriptor, SkillResponse } from '../../../runtime/contract';
import type { SkillManifest } from '../../../types';

/** Wire the runtime EXACTLY as the bundled adapter does. */
function makeBundledRuntime() {
  const resolver = createFileResolver();
  const provider = new FilesystemSkillProvider({ search: true });
  const registry = new SkillProviderRegistry([
    { provider, trust: bundledTrustPolicy(resolver.packageRoot) },
  ]);
  return createRuntimeFromRegistry({ kind: 'in-process' }, registry);
}

describe('presentManifest — runtime-authoritative list_skills (Req 9.4, 9.8)', () => {
  let manifest: SkillManifest;

  beforeAll(async () => {
    manifest = await createFileResolver().readManifest();
  });

  it('reconstructs the manifest document byte-for-byte from a real runtime.list()', async () => {
    const runtime = makeBundledRuntime();
    const listResp = await runtime.list();
    expect(listResp.ok).toBe(true);

    const result = presentManifest(listResp, manifest);
    expect(result.isError).toBeFalsy();

    // Byte-for-byte equal to the pre-migration served contract.
    expect(result.content[0].text).toBe(JSON.stringify(manifest, null, 2));
    // ...and parses back to the full manifest.
    expect(JSON.parse(result.content[0].text)).toEqual(manifest);
  });

  it('proves the result rode the federated runtime path (aggregate provenance present)', async () => {
    const runtime = makeBundledRuntime();
    const listResp = await runtime.list();
    expect(listResp.ok).toBe(true);
    if (!listResp.ok) return;
    // The runtime attaches aggregate diagnostics to list provenance — i.e. list_skills now
    // flows through the federated aggregation, not a manifest side-channel.
    expect(listResp.provenance.source).toBe('aggregate:list');
    expect(listResp.provenance.aggregateDiagnostics).toBeDefined();
  });

  it('is authoritative for membership/order: a subset renders only those entries in order', () => {
    // Authoritative descriptors in a deliberately non-manifest order, subset of two.
    const subset: SkillDescriptor[] = [
      { fqid: 'bundled:runtime-api-core', name: 'runtime-api-core', provider: 'bundled', source: 's' },
      { fqid: 'bundled:runtime-concepts', name: 'runtime-concepts', provider: 'bundled', source: 's' },
    ];
    const resp: SkillResponse<SkillDescriptor[]> = {
      ok: true,
      data: subset,
      provenance: { fqid: '*', provider: 'runtime', source: 'aggregate:list' },
    };

    const doc = JSON.parse(presentManifest(resp, manifest).content[0].text) as SkillManifest;
    expect(doc.skills.map((s) => s.name)).toEqual(['runtime-api-core', 'runtime-concepts']);
    // Each rendered entry is the VERBATIM manifest entry for that name.
    const fromManifest = (n: string) => manifest.skills.find((s) => s.name === n);
    expect(doc.skills[0]).toEqual(fromManifest('runtime-api-core'));
    expect(doc.skills[1]).toEqual(fromManifest('runtime-concepts'));
    // The document envelope fields are preserved from the manifest.
    expect(doc.version).toBe(manifest.version);
    expect(doc.frameworkVersion).toBe(manifest.frameworkVersion);
  });

  it('skips a federated (non-manifest) descriptor — not representable in the published document', () => {
    const data: SkillDescriptor[] = [
      { fqid: 'bundled:runtime-concepts', name: 'runtime-concepts', provider: 'bundled', source: 's' },
      { fqid: 'external:acme-skill', name: 'acme-skill', provider: 'external', source: 'remote' },
    ];
    const resp: SkillResponse<SkillDescriptor[]> = {
      ok: true,
      data,
      provenance: { fqid: '*', provider: 'runtime', source: 'aggregate:list' },
    };

    const doc = JSON.parse(presentManifest(resp, manifest).content[0].text) as SkillManifest;
    expect(doc.skills.map((s) => s.name)).toEqual(['runtime-concepts']);
    expect(doc.skills.some((s) => s.name === 'acme-skill')).toBe(false);
  });

  it('renders a typed tool error on a runtime error response (never throws)', () => {
    const resp: SkillResponse<SkillDescriptor[]> = {
      ok: false,
      error: { code: 'unsupported', capability: 'list' },
    };
    const result = presentManifest(resp, manifest);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('list_skills:');
    expect(result.content[0].text).toContain('not supported');
  });
});
