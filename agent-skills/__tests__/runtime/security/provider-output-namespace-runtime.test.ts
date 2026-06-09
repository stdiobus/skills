/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Runtime-level per-operation namespace anti-spoofing (Milestone-002 bugfix B2;
// design §"Components" 6 / Property 4; Req 5.4, 5.5, 6.1, 6.2).
//
// Subject under test (composition, NOT a unit):
//   - runtime/in-process-runtime.ts        (the REAL InProcessSkillsRuntime)
//   - runtime/admission/namespace-ownership.ts (the REAL NamespaceOwnershipTable)
//   - runtime/security/provider-output-validator.ts (applied by the runtime)
//   - runtime/registry.ts                  (the REAL MutableProviderView)
//
// Why this test exists (bugfix B2 — the regression guard for B1):
//   The only pre-existing namespace-spoof coverage asserts the admission-time `claim`
//   path (`stage === 'admit'`). The RUNTIME per-operation provider-output boundary
//   (Req 5.4) had NO end-to-end coverage — which is exactly how B1's wiring gap (the
//   `NamespaceOwnershipTable` was never passed into the runtime) went unnoticed. This
//   test drives the REAL runtime, wired with a REAL ownership table, and proves that a
//   registered external provider returning an FQID OUTSIDE its owned namespace on a
//   SUBSEQUENT operation (not at admission) is rejected at the provider-output boundary
//   as a RETURNED typed error on EACH public operation, while a well-formed sibling's
//   output is unaffected.
//
// Mock-free at the boundary: the runtime, the ownership table, the provider view, and the
// output validator are all the REAL production objects. The only test doubles are two
// in-memory `SkillProvider` stubs — a legitimate provider seam, NOT a mock of the boundary
// under test (the boundary itself is exercised exactly as in production).
//
// Regression-guard proof (acceptance criterion 3): the SAME fixture is run BOTH with the
// table wired (post-B1, production wiring → rejection enforced) and WITHOUT the table
// (pre-B1 wiring → spoof output admitted). The asymmetry demonstrates the test genuinely
// exercises the runtime-level NamespaceOwnershipTable / ProviderOutputValidator path, and
// would FAIL against the pre-B1 wiring it guards.
//
// Validates: Requirements 5.4, 5.5, 6.1, 6.2
// =============================================================================

import { InProcessSkillsRuntime } from '../../../runtime/in-process-runtime.js';
import { NamespaceOwnershipTable } from '../../../runtime/admission/namespace-ownership.js';
import { MutableProviderView } from '../../../runtime/registry.js';
import { readAggregateDiagnostics } from '../../../runtime/federation.js';
import type {
  ListSkillsInput,
  ReferenceContent,
  ReferenceDescriptor,
  ResolvedSkill,
  SearchResult,
  SearchSkillsInput,
  SkillContent,
  SkillDescriptor,
  SkillProvider,
  SkillProviderCapabilities,
  SkillRef,
} from '../../../runtime/contract.js';

// --- fixtures ----------------------------------------------------------------

/** Does a descriptor match a caller ref? (provider-private match used by the stub.) */
function matchesRef(d: SkillDescriptor, ref: SkillRef): boolean {
  switch (ref.kind) {
    case 'fqid':
      return d.fqid === ref.fqid;
    case 'name':
      return d.name === ref.name && (ref.provider ? d.provider === ref.provider : true);
    case 'descriptor':
      return d.fqid === ref.descriptor.fqid;
  }
}

/**
 * A minimal, REAL in-memory {@link SkillProvider} (a legitimate provider seam, not a mock
 * of the boundary). It serves a fixed set of descriptors verbatim on every operation, so a
 * crafted out-of-namespace descriptor reaches the runtime's provider-output boundary on
 * `resolve` / `list` / `search` (via the list+substring fallback) exactly as a real
 * provider's output would.
 */
class InMemorySkillProvider implements SkillProvider {
  readonly capabilities: SkillProviderCapabilities;

  constructor(
    readonly id: string,
    private readonly descriptors: readonly SkillDescriptor[],
  ) {
    // List-capable, references-capable, NO native search → `search` is served by the
    // documented list+substring fallback, which applies the same output boundary.
    this.capabilities = { read: true, list: true, search: false, references: true };
  }

  private resolvedAll(): ResolvedSkill[] {
    return this.descriptors.map((descriptor) => ({
      descriptor,
      providerId: this.id,
      provenanceSeed: { source: descriptor.source },
    }));
  }

  async resolve(ref: SkillRef): Promise<ResolvedSkill[]> {
    return this.resolvedAll().filter((r) => matchesRef(r.descriptor, ref));
  }

  async list(_input?: ListSkillsInput): Promise<ResolvedSkill[]> {
    return this.resolvedAll();
  }

  async search(_input: SearchSkillsInput): Promise<SearchResult[]> {
    // Never invoked (capabilities.search === false) — present only to satisfy the optional
    // method shape; the runtime routes through the list+substring fallback instead.
    return this.resolvedAll().map((r) => ({ descriptor: r.descriptor, score: 1 }));
  }

  async read(resolved: ResolvedSkill): Promise<SkillContent> {
    return { descriptor: resolved.descriptor, body: `body of ${resolved.descriptor.fqid}` };
  }

  async listReferences(_resolved: ResolvedSkill): Promise<ReferenceDescriptor[]> {
    return [{ path: 'reference.md' }];
  }

  async readReference(_resolved: ResolvedSkill, reference: string): Promise<ReferenceContent> {
    return { path: reference, body: `reference body for ${reference}` };
  }
}

// Well-formed sibling: owns `good`, mints strictly under it.
const GOOD_FQID = 'good:widget';
const goodDescriptor: SkillDescriptor = {
  fqid: GOOD_FQID,
  name: 'widget',
  provider: 'good',
  source: 'mem://good/widget',
};

// Spoofing provider: id `spoof`, owns `spoof`, but emits an FQID under the SIBLING's
// namespace (`good:loot`) and even self-asserts `provider: 'good'` — the precise Req 5.5
// laundering attempt. Its identity is otherwise VALID (non-empty provider/name/fqid within
// the byte bound), so the ONLY reason it can be rejected is the namespace anti-spoofing
// check — proving the test exercises the namespace path, not the identity guard.
const SPOOF_FQID = 'good:loot';
const spoofDescriptor: SkillDescriptor = {
  fqid: SPOOF_FQID,
  name: 'loot',
  provider: 'good',
  source: 'mem://spoof/loot',
};

/**
 * Build the real composition. `wireTable` toggles the B1 fix: when `true`, the runtime and
 * the ownership table share the SAME instance (post-B1, production wiring); when `false`,
 * the runtime is constructed WITHOUT the table (pre-B1 wiring) so the namespace check is
 * inert.
 */
function buildFixture(wireTable: boolean): { runtime: InProcessSkillsRuntime } {
  const good = new InMemorySkillProvider('good', [goodDescriptor]);
  const spoof = new InMemorySkillProvider('spoof', [spoofDescriptor]);

  // The SAME ownership table the admission pipeline would hold: both providers have claimed
  // their namespaces, so both own a namespace and are subject to the per-operation check.
  const namespaces = new NamespaceOwnershipTable();
  expect(namespaces.claim('good', 'good').ok).toBe(true);
  expect(namespaces.claim('spoof', 'spoof').ok).toBe(true);

  // `good` first (highest precedence), then `spoof` — the per-operation snapshot spans both.
  const view = new MutableProviderView([good, spoof]);

  const runtime = wireTable
    ? new InProcessSkillsRuntime(view, undefined, namespaces)
    : new InProcessSkillsRuntime(view);
  return { runtime };
}

// =============================================================================
// Post-B1 (production wiring) — per-operation rejection on EACH public operation
// =============================================================================

describe('runtime per-operation namespace anti-spoofing — table wired (post-B1; Req 5.4, 5.5)', () => {
  // Single-resolution operations: a rejected out-of-namespace descriptor fails the whole
  // resolution as a RETURNED typed error at the provider-output boundary (Req 6.1), before
  // any body/reference is read.
  describe('single-resolution operations reject the spoofed output (Req 5.4)', () => {
    it('read rejects an out-of-namespace FQID as a returned bad_request (never thrown)', async () => {
      const { runtime } = buildFixture(true);
      const resp = await runtime.read({ ref: { kind: 'name', name: 'loot' } });
      expect(resp.ok).toBe(false);
      if (resp.ok) return;
      expect(resp.error.code).toBe('bad_request');
    });

    it('getReferences rejects an out-of-namespace FQID as a returned bad_request', async () => {
      const { runtime } = buildFixture(true);
      const resp = await runtime.getReferences({ ref: { kind: 'name', name: 'loot' } });
      expect(resp.ok).toBe(false);
      if (resp.ok) return;
      expect(resp.error.code).toBe('bad_request');
    });

    it('readReference rejects an out-of-namespace FQID as a returned bad_request', async () => {
      const { runtime } = buildFixture(true);
      const resp = await runtime.readReference({
        ref: { kind: 'name', name: 'loot' },
        reference: 'reference.md',
      });
      expect(resp.ok).toBe(false);
      if (resp.ok) return;
      expect(resp.error.code).toBe('bad_request');
    });
  });

  // Aggregate operations: the spoofing source is recorded as a PER-SOURCE error in the
  // diagnostics (Req 6.2) WITHOUT poisoning the well-formed sibling's output — the operation
  // still returns `ok: true` carrying only the sibling's descriptor.
  describe('aggregate operations record a per-source error without poisoning siblings (Req 6.2)', () => {
    it('list returns only the sibling output and records spoof as a bad_request source error', async () => {
      const { runtime } = buildFixture(true);
      const resp = await runtime.list();

      expect(resp.ok).toBe(true);
      if (!resp.ok) return;

      // Sibling output is unaffected; the spoofed FQID never enters the result.
      expect(resp.data.map((d) => d.fqid)).toEqual([GOOD_FQID]);
      expect(resp.data.map((d) => d.fqid)).not.toContain(SPOOF_FQID);

      const diag = readAggregateDiagnostics(resp.provenance);
      expect(diag).toBeDefined();
      if (!diag) return;
      const spoofSrc = diag.sources.find((s) => s.provider === 'spoof');
      const goodSrc = diag.sources.find((s) => s.provider === 'good');
      expect(spoofSrc?.ok).toBe(false);
      expect(spoofSrc?.error?.code).toBe('bad_request');
      expect(goodSrc?.ok).toBe(true);
      expect(goodSrc?.count).toBe(1);
      expect(diag.conflicts).toEqual([]);
    });

    it('search returns only the sibling output and records spoof as a bad_request source error', async () => {
      const { runtime } = buildFixture(true);
      // Query matches the well-formed sibling's name so it appears in results; the spoof
      // source is rejected at the boundary regardless of the query.
      const resp = await runtime.search({ query: 'widget' });

      expect(resp.ok).toBe(true);
      if (!resp.ok) return;

      expect(resp.data.map((r) => r.descriptor.fqid)).toEqual([GOOD_FQID]);
      expect(resp.data.map((r) => r.descriptor.fqid)).not.toContain(SPOOF_FQID);

      const diag = readAggregateDiagnostics(resp.provenance);
      expect(diag).toBeDefined();
      if (!diag) return;
      const spoofSrc = diag.sources.find((s) => s.provider === 'spoof');
      const goodSrc = diag.sources.find((s) => s.provider === 'good');
      expect(spoofSrc?.ok).toBe(false);
      expect(spoofSrc?.error?.code).toBe('bad_request');
      expect(goodSrc?.ok).toBe(true);
    });
  });
});

// =============================================================================
// Regression-guard proof — pre-B1 wiring (no table) does NOT reject the spoof
//
// These cases lock in that the rejection above is produced by the runtime-level ownership
// table (the B1 fix), NOT by some other guard. Constructing the runtime WITHOUT the table
// (the exact pre-B1 wiring) admits the very same out-of-namespace output — so the post-B1
// assertions above would FAIL against pre-B1 code, which is precisely what B2 must guard.
// =============================================================================

describe('regression guard — pre-B1 wiring (no namespace table) admits the spoof', () => {
  it('read admits the out-of-namespace FQID when the table is not wired', async () => {
    const { runtime } = buildFixture(false);
    const resp = await runtime.read({ ref: { kind: 'name', name: 'loot' } });
    // Pre-B1: the namespace check is inert, so the spoofed skill resolves and reads cleanly.
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data.descriptor.fqid).toBe(SPOOF_FQID);
  });

  it('list admits the out-of-namespace FQID (spoof recorded as a successful source) when not wired', async () => {
    const { runtime } = buildFixture(false);
    const resp = await runtime.list();
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    // The spoofed FQID is present in the aggregate, and the spoof source is NOT an error.
    expect(resp.data.map((d) => d.fqid)).toEqual(expect.arrayContaining([GOOD_FQID, SPOOF_FQID]));
    const diag = readAggregateDiagnostics(resp.provenance);
    expect(diag?.sources.find((s) => s.provider === 'spoof')?.ok).toBe(true);
  });
});
