/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Federation with TWO REAL providers (Milestone-002, Task 10; Migration Step 7).
//
// Exercises the EXISTING Milestone-001 aggregation over the per-operation snapshot
// `[bundled, admitted]` — NO new equality/dedupe semantics, `contentHash` is never
// consulted (design §"Data Flow" / Federation). The two providers are REAL, not mocks:
//
//   - the bundled `FilesystemSkillProvider` (real on-disk skills manifest + SKILL.md), and
//   - a real `HttpSkillProvider` acquiring over real HTTPS from a pinned public origin
//     (the git project's COPYING on GitHub raw — same stable anchor the Task 7.1 unit
//     test pins).
//
// Cases (Req 11.1–11.4):
//   1. Real admission path → federated `list` + a federated `read` over real HTTPS:
//      the HttpSkillProvider is admitted THROUGH the production `AdmissionController`
//      pipeline (real HTTPS acquire), then `list` aggregates both sources with per-source
//      diagnostics, and the admitted skill is read back over HTTPS (Req 11.1).
//   2. Federated `search` across both real providers via the list+substring fallback,
//      with per-source diagnostics (Req 11.1).
//   3. A forced FQID conflict (same FQID, differing content) is SURFACED, never silently
//      picked (Req 11.2).
//   4. A forced admitted-provider OUTAGE (genuinely unreachable HTTPS origin) returns the
//      bundled provider's results and records the admitted provider's identity + error —
//      partial-failure resilience (Req 11.3).
//   5. A name collision under DIFFERING FQIDs yields a typed `ambiguous` carrying the
//      candidate descriptors, consistent with the proven `resolveOne` (Req 11.4).
//
// Mock-free discipline: real HTTPS only. The outage case points a real provider at a
// genuinely unavailable origin (an honest outage), never a stub. Network cases use
// generous timeouts but make no localhost/fixture fallback.
//
// Validates: Requirements 11.1, 11.2, 11.3, 11.4
// =============================================================================

import { AdmissionController } from '../../runtime/admission/admission-controller.js';
import { ProviderBlueprintRegistry } from '../../runtime/admission/blueprint-registry.js';
import { defaultContentHasher } from '../../runtime/admission/content-hasher.js';
import { NamespaceOwnershipTable } from '../../runtime/admission/namespace-ownership.js';
import { OperationBudget } from '../../runtime/admission/operation-budget.js';
import type { ProviderCreationContext, CredentialHeadersProvider } from '../../runtime/admission/provider-blueprint.js';
import { normalizeDescriptor } from '../../runtime/admission/provider-descriptor.js';
import { readAggregateDiagnostics } from '../../runtime/federation.js';
import { InProcessSkillsRuntime } from '../../runtime/in-process-runtime.js';
import {
  HttpSkillProvider,
  HttpSkillProviderBlueprint,
  type HttpProviderConfig,
} from '../../runtime/providers/http-skill-provider.js';
import { FilesystemSkillProvider } from '../../runtime/providers/filesystem-provider.js';
import { MutableProviderView } from '../../runtime/registry.js';
import { UNTRUSTED_DEFAULT } from '../../runtime/trust.js';
import type { ListSkillsInput, ResolvedSkill } from '../../runtime/contract.js';

// A pinned, stable public HTTPS origin (RFC-stable content, real network — no mock, no
// localhost). Mirrors the Task 7.1 unit test's anchor so the body assertion is reliable.
const PINNED_HTTPS_URL = 'https://raw.githubusercontent.com/git/git/v2.43.0/COPYING';
const PINNED_SKILL_NAME = 'copying'; // deriveSkillName('.../COPYING')
const NETWORK_TIMEOUT_MS = 20_000;

// The no-credential adapter (public origins): yields no headers (Req 7.3 default).
const noCredentials: CredentialHeadersProvider = {
  async authorize(_url: string) {
    return {};
  },
};

function ctx(namespace: string, credentials: CredentialHeadersProvider = noCredentials): ProviderCreationContext {
  return { namespace, trust: UNTRUSTED_DEFAULT, credentials };
}

function httpConfig(over: Partial<HttpProviderConfig> = {}): HttpProviderConfig {
  return {
    url: PINNED_HTTPS_URL,
    maxContentBytes: 1_000_000,
    timeoutMs: NETWORK_TIMEOUT_MS,
    ...over,
  };
}

/**
 * A REAL provider that performs a genuine HTTPS acquisition as part of `list`, so an
 * unreachable origin produces a REAL outage during an aggregated operation (Req 11.3).
 *
 * It is NOT a mock: it extends the shipped {@link HttpSkillProvider} and drives its real
 * `read` over real HTTPS. On a reachable origin `list` returns the real single-skill
 * descriptor; on a genuinely unavailable origin the real fetch fails and `list` rejects with
 * the provider's typed error — exactly the honest outage the runtime must absorb without
 * poisoning the bundled provider's results.
 */
class NetworkListingHttpSkillProvider extends HttpSkillProvider {
  override async list(input?: ListSkillsInput): Promise<ResolvedSkill[]> {
    const resolved = await super.list(input);
    // Force a genuine HTTPS acquisition; an unreachable origin throws here.
    await this.read(resolved[0]);
    return resolved;
  }
}

// =============================================================================
// Case 1 — real admission path → federated list + federated read over HTTPS (Req 11.1)
// =============================================================================

describe('federation (two real providers) — admit over HTTPS then aggregate (Req 11.1)', () => {
  it(
    'admits a real HttpSkillProvider through the AdmissionController, then list aggregates both real sources',
    async () => {
      const bundled = new FilesystemSkillProvider();
      const bundledList = await bundled.list();
      expect(bundledList.length).toBeGreaterThan(1); // a real, multi-skill bundled surface
      const sampleBundledFqid = bundledList[0].descriptor.fqid;

      // Wire the production admission pipeline over a view seeded with the bundled provider.
      const view = new MutableProviderView([bundled]);
      const namespaces = new NamespaceOwnershipTable();
      const blueprints = new ProviderBlueprintRegistry();
      blueprints.register(new HttpSkillProviderBlueprint());
      const controller = new AdmissionController(
        blueprints,
        view,
        namespaces,
        new OperationBudget(NETWORK_TIMEOUT_MS),
        defaultContentHasher,
      );

      // Admit the real HTTPS provider via the real pipeline (discover → validate → acquire
      // over real HTTPS → hash-record → admit → register).
      const outcome = await controller.admit(
        normalizeDescriptor({ factoryId: 'http', config: httpConfig(), namespace: 'external' }),
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.admitted.descriptor.fqid).toBe(`external:${PINNED_SKILL_NAME}`);
      // contentHash is record-only provenance — present, but never consulted by dedupe.
      expect(typeof outcome.admitted.contentHash).toBe('string');
      expect(outcome.admitted.contentHash.length).toBeGreaterThan(0);

      // The runtime reads the now-two-provider snapshot from the same admitted view, with the
      // ownership table wired (federated deployment shape). The bundled provider owns no
      // namespace and is exempt; the admitted provider's FQID falls under the namespace it
      // claimed at admission.
      const runtime = new InProcessSkillsRuntime(view, undefined, namespaces);

      const listResp = await runtime.list();
      expect(listResp.ok).toBe(true);
      if (!listResp.ok) return;

      const fqids = listResp.data.map((d) => d.fqid);
      expect(fqids).toContain(`external:${PINNED_SKILL_NAME}`); // the admitted source
      expect(fqids).toContain(sampleBundledFqid); // the bundled source

      // Per-source diagnostics record BOTH providers succeeding, with their counts (Req 11.1).
      const diag = readAggregateDiagnostics(listResp.provenance);
      expect(diag).toBeDefined();
      if (!diag) return;
      const bundledSrc = diag.sources.find((s) => s.provider === 'bundled');
      const externalSrc = diag.sources.find((s) => s.provider === 'external');
      expect(bundledSrc?.ok).toBe(true);
      expect(bundledSrc?.count).toBe(bundledList.length);
      expect(externalSrc?.ok).toBe(true);
      expect(externalSrc?.count).toBe(1);
      expect(diag.conflicts).toEqual([]);

      // Federated READ of the admitted skill over real HTTPS returns its real body.
      const readResp = await runtime.read({ ref: { kind: 'fqid', fqid: `external:${PINNED_SKILL_NAME}` } });
      expect(readResp.ok).toBe(true);
      if (!readResp.ok) return;
      expect(readResp.data.body).toContain('GNU GENERAL PUBLIC LICENSE');
    },
    NETWORK_TIMEOUT_MS + 15_000,
  );
});

// =============================================================================
// Case 2 — federated search across two real providers (Req 11.1)
// =============================================================================

describe('federation (two real providers) — federated search aggregation (Req 11.1)', () => {
  it('aggregates search across the bundled provider and an admitted HttpSkillProvider', async () => {
    const bundled = new FilesystemSkillProvider();
    const http = new HttpSkillProvider(httpConfig(), ctx('external'));

    // Direct view seeded with the bundled provider, then the HttpSkillProvider added — the
    // per-operation snapshot now spans both real providers (Req 10 / design §"Data Flow").
    const view = new MutableProviderView([bundled]);
    view.admit(http);
    const runtime = new InProcessSkillsRuntime(view);

    // Neither provider declares native search → both are served by the documented
    // list+substring fallback. The query matches the admitted skill's name (offline: list
    // does not hit the network).
    const resp = await runtime.search({ query: PINNED_SKILL_NAME });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;

    expect(resp.data.map((r) => r.descriptor.fqid)).toContain(`external:${PINNED_SKILL_NAME}`);

    const diag = readAggregateDiagnostics(resp.provenance);
    expect(diag).toBeDefined();
    if (!diag) return;
    // Both real providers participated as sources.
    expect(diag.sources.map((s) => s.provider).sort()).toEqual(['bundled', 'external']);
    expect(diag.sources.every((s) => s.ok)).toBe(true);
    // The documented fallback was used and recorded (Req 3.3 mechanic, reused unchanged).
    expect(diag.fallbacksApplied).toContain('search:fallback(list+substring)');
    expect(diag.conflicts).toEqual([]);
  });
});

// =============================================================================
// Case 3 — forced FQID conflict surfaces, never a silent pick (Req 11.2)
// =============================================================================

describe('federation (two real providers) — forced FQID conflict (Req 11.2)', () => {
  it('surfaces a conflict for the same FQID with differing content and keeps the first occurrence', async () => {
    const bundled = new FilesystemSkillProvider();
    const bundledList = await bundled.list();
    const target = bundledList[0].descriptor; // a real bundled skill (fqid `bundled:<name>`)

    // A real HttpSkillProvider configured to MINT a colliding FQID: its namespace is the
    // bundled prefix and its URL basename is the bundled skill name, so it emits
    // `bundled:<name>` with DIFFERING content (a different `source`). Run WITHOUT a namespace
    // table so the federation layer's conflict surfacing — not anti-spoofing — is exercised.
    const collider = new HttpSkillProvider(
      httpConfig({ url: `https://example.com/collision/${target.name}` }),
      ctx('bundled'),
    );
    expect((await collider.list())[0].descriptor.fqid).toBe(target.fqid);

    const view = new MutableProviderView([bundled]);
    view.admit(collider);
    const runtime = new InProcessSkillsRuntime(view);

    const resp = await runtime.list();
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;

    // No silent pick: exactly ONE surviving entry for the shared FQID, and it is the FIRST
    // occurrence (the bundled provider's, by precedence) — the collider did not displace it.
    const survivors = resp.data.filter((d) => d.fqid === target.fqid);
    expect(survivors).toHaveLength(1);
    expect(survivors[0].source).toBe(target.source);
    expect(survivors[0].source.startsWith('agent-skills/')).toBe(true);

    // The conflict is SURFACED for the shared FQID (Req 11.2).
    const diag = readAggregateDiagnostics(resp.provenance);
    expect(diag).toBeDefined();
    if (!diag) return;
    const conflict = diag.conflicts.find((c) => c.fqid === target.fqid);
    expect(conflict).toBeDefined();
    expect(conflict!.providers).toContain('bundled');
  });
});

// =============================================================================
// Case 4 — forced admitted-provider outage → partial-failure resilience (Req 11.3)
// =============================================================================

describe('federation (two real providers) — admitted-provider outage (Req 11.3)', () => {
  it(
    'returns the bundled provider results and records the admitted provider error on a real outage',
    async () => {
      const bundled = new FilesystemSkillProvider();
      const bundledList = await bundled.list();

      // A real provider pointed at a genuinely unavailable origin: the `.invalid` TLD is
      // reserved and never resolves (RFC 6761), so the HTTPS fetch fails for real — an honest
      // outage, not a mock. Its `list` performs the real acquisition, so the failure surfaces
      // during the aggregated operation.
      const flaky = new NetworkListingHttpSkillProvider(
        httpConfig({ url: 'https://provider-boundary-outage.invalid/skill-x', timeoutMs: 5_000 }),
        ctx('flaky'),
      );

      const view = new MutableProviderView([bundled]);
      view.admit(flaky);
      const runtime = new InProcessSkillsRuntime(view);

      const resp = await runtime.list();

      // Partial success — the surviving bundled provider's results are returned (Req 11.3).
      expect(resp.ok).toBe(true);
      if (!resp.ok) return;
      const fqids = resp.data.map((d) => d.fqid);
      expect(fqids).toEqual(expect.arrayContaining(bundledList.map((r) => r.descriptor.fqid)));
      // The failing provider contributed nothing to the data.
      expect(fqids.some((f) => f.startsWith('flaky:'))).toBe(false);

      // The admitted provider's identity + error are recorded in the diagnostics (Req 11.3).
      const diag = readAggregateDiagnostics(resp.provenance);
      expect(diag).toBeDefined();
      if (!diag) return;
      const flakySrc = diag.sources.find((s) => s.provider === 'flaky');
      expect(flakySrc).toBeDefined();
      expect(flakySrc!.ok).toBe(false);
      expect(flakySrc!.error?.code).toBe('provider_error');
      const bundledSrc = diag.sources.find((s) => s.provider === 'bundled');
      expect(bundledSrc?.ok).toBe(true);
    },
    NETWORK_TIMEOUT_MS + 15_000,
  );
});

// =============================================================================
// Case 5 — name collision under differing FQIDs → typed `ambiguous` (Req 11.4)
// =============================================================================

describe('federation (two real providers) — name collision under differing FQIDs (Req 11.4)', () => {
  it('returns a typed ambiguous with both candidate descriptors when a name collides across FQIDs', async () => {
    const bundled = new FilesystemSkillProvider();
    const bundledList = await bundled.list();
    const target = bundledList[0].descriptor; // real bundled `bundled:<name>`

    // A real HttpSkillProvider under a DIFFERENT namespace whose single skill shares the
    // bundled skill NAME — so the two descriptors collide on `name` but carry DIFFERING FQIDs
    // (`bundled:<name>` vs `external:<name>`). Resolving by name must be `ambiguous`.
    const http = new HttpSkillProvider(
      httpConfig({ url: `https://example.com/external/${target.name}` }),
      ctx('external'),
    );
    const httpDescriptor = (await http.list())[0].descriptor;
    expect(httpDescriptor.name).toBe(target.name);
    expect(httpDescriptor.fqid).toBe(`external:${target.name}`);
    expect(httpDescriptor.fqid).not.toBe(target.fqid);

    const view = new MutableProviderView([bundled]);
    view.admit(http);
    const runtime = new InProcessSkillsRuntime(view);

    // Resolve by NAME (offline: resolve does not hit the network) — both providers resolve a
    // candidate with the same name but distinct FQIDs.
    const resp = await runtime.read({ ref: { kind: 'name', name: target.name } });

    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error.code).toBe('ambiguous');
    if (resp.error.code !== 'ambiguous') return;

    const candidateFqids = resp.error.candidates.map((c) => c.fqid).sort();
    expect(candidateFqids).toEqual([target.fqid, `external:${target.name}`].sort());
  });
});
