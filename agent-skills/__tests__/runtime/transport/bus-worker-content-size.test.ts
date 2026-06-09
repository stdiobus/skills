/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Regression test for bugfix B3 — wire `trustOf` into the production bus worker
// runtime so the provider-output CONTENT-SIZE boundary is LIVE on the
// post-admission read path (design §9; Req 6.1, 11.5, 15.2).
//
// Root cause being guarded: `bus-worker.ts` formerly built the runtime as
// `new InProcessSkillsRuntime(providerView, undefined, namespaces)` — `trustOf`
// undefined → `ProviderOutputValidator.validateContentSize` was inert, so an
// admitted external provider could return an oversized body unchecked.
//
// This test reconstructs the EXACT composition the worker builds (a
// MutableProviderView seeded with the bundled FilesystemSkillProvider, the
// SAME-shaped `trustOf`: bundled → bundledTrustPolicy, unknown → UNTRUSTED_DEFAULT,
// and the shared NamespaceOwnershipTable) and drives it through a verbatim mirror
// of the worker ingress over an in-memory bus (ParamCodec.decode → dispatch →
// JSON wire), exactly like `transport-equivalence.test.ts`.
//
// Criterion 1: a post-admission `read` of an oversized provider body over the bus
//   is rejected with `content_too_large` at the runtime output boundary
//   (RETURNED inside the JSON-RPC result, never thrown).
// Criterion 2: the bundled-only baseline read is unchanged (a published skill
//   still resolves and reads byte-for-byte over the same bus).
// =============================================================================

import { InProcessSkillsRuntime, type TrustLookup } from '../../../runtime/in-process-runtime.js';
import { MutableProviderView } from '../../../runtime/registry.js';
import { NamespaceOwnershipTable } from '../../../runtime/admission/namespace-ownership.js';
import { FilesystemSkillProvider } from '../../../runtime/providers/filesystem-provider.js';
import { ParamCodec } from '../../../runtime/transport/param-codec.js';
import { SkillsCapabilities } from '../../../runtime/capabilities.js';
import {
  bundledTrustPolicy,
  UNTRUSTED_DEFAULT,
  UNTRUSTED_MAX_CONTENT_BYTES,
  type TrustPolicy,
} from '../../../runtime/trust.js';
import type {
  GetReferencesInput,
  ListSkillsInput,
  ReadReferenceInput,
  ReadSkillInput,
  ResolvedSkill,
  SearchSkillsInput,
  SkillContent,
  SkillDescriptor,
  SkillProvider,
  SkillRef,
  SkillResponse,
} from '../../../runtime/contract.js';

// -----------------------------------------------------------------------------
// An external provider that returns an OVERSIZED skill body (> the untrusted
// 1 MB default). It owns NO namespace (never registered in the ownership table),
// so the namespace anti-spoof check is exempt and this test isolates the
// CONTENT-SIZE boundary. Its id ('acme') is NOT in the worker's trust map, so it
// resolves to UNTRUSTED_DEFAULT — exactly as a provider admitted at runtime does.
// -----------------------------------------------------------------------------
const EXTERNAL_ID = 'acme';
const EXTERNAL_SKILL = 'big';
const OVERSIZED_BYTES = UNTRUSTED_MAX_CONTENT_BYTES + 1;

class OversizedExternalProvider implements SkillProvider {
  readonly id = EXTERNAL_ID;
  readonly capabilities = { read: true, list: true, search: false, references: false } as const;

  private resolved(): ResolvedSkill {
    const descriptor: SkillDescriptor = {
      fqid: `${EXTERNAL_ID}:${EXTERNAL_SKILL}`,
      name: EXTERNAL_SKILL,
      provider: EXTERNAL_ID,
      source: `https://example.test/${EXTERNAL_SKILL}`,
    };
    return {
      descriptor,
      providerId: this.id,
      providerLocalRef: EXTERNAL_SKILL,
      provenanceSeed: { source: descriptor.source },
    };
  }

  async resolve(ref: SkillRef): Promise<ResolvedSkill[]> {
    const matches =
      (ref.kind === 'name' &&
        ref.name === EXTERNAL_SKILL &&
        (ref.provider === undefined || ref.provider === EXTERNAL_ID)) ||
      (ref.kind === 'fqid' && ref.fqid === `${EXTERNAL_ID}:${EXTERNAL_SKILL}`);
    return matches ? [this.resolved()] : [];
  }

  async read(resolved: ResolvedSkill): Promise<SkillContent> {
    // Genuinely materialize an oversized body — exercises the POST-read backstop
    // (no readMetadata probe), proving the boundary rejects a real over-budget body.
    return { descriptor: resolved.descriptor, body: 'x'.repeat(OVERSIZED_BYTES) };
  }

  async list(): Promise<ResolvedSkill[]> {
    return [this.resolved()];
  }
}

// -----------------------------------------------------------------------------
// Worker-ingress mirror — a verbatim stand-in for `bus-worker.ts`: decode at the
// single boundary, dispatch the decoded input to the worker's in-process runtime,
// return the SkillResponse as a JSON wire value (the NDJSON serialization edge).
// -----------------------------------------------------------------------------
function jsonWire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function workerDispatch(
  runtime: InProcessSkillsRuntime,
): Record<string, (input: unknown) => Promise<SkillResponse<unknown>>> {
  return {
    [SkillsCapabilities.read.method]: (i) => runtime.read(i as ReadSkillInput),
    [SkillsCapabilities.list.method]: (i) => runtime.list(i as ListSkillsInput),
    [SkillsCapabilities.search.method]: (i) => runtime.search(i as SearchSkillsInput),
    [SkillsCapabilities.listReferences.method]: (i) => runtime.getReferences(i as GetReferencesInput),
    [SkillsCapabilities.readReference.method]: (i) => runtime.readReference(i as ReadReferenceInput),
  };
}

/** Request over the mirrored worker ingress. Resolves a wire envelope; never throws. */
async function busRequest(
  runtime: InProcessSkillsRuntime,
  method: string,
  params: unknown,
): Promise<SkillResponse<unknown>> {
  const dispatch = workerDispatch(runtime);
  const decoded = ParamCodec.decode(method, params);
  if (!decoded.ok) return jsonWire({ ok: false, error: decoded.error });
  const handler = dispatch[method];
  if (!handler) return jsonWire({ ok: false, error: { code: 'unsupported', capability: method } });
  return jsonWire(await handler(decoded.input));
}

// -----------------------------------------------------------------------------
// Composition — IDENTICAL shape to `runtime/transport/bus-worker.ts`.
// -----------------------------------------------------------------------------
function buildWorkerRuntime(): { runtime: InProcessSkillsRuntime; view: MutableProviderView } {
  const bundled = new FilesystemSkillProvider();
  const view = new MutableProviderView([bundled]);
  const namespaces = new NamespaceOwnershipTable();
  const policyById = new Map<string, TrustPolicy>([[bundled.id, bundledTrustPolicy()]]);
  const trustOf: TrustLookup = (providerId) => policyById.get(providerId) ?? UNTRUSTED_DEFAULT;
  const runtime = new InProcessSkillsRuntime(view, trustOf, namespaces);
  return { runtime, view };
}

describe('bugfix B3: bus-worker trustOf makes the content-size boundary live (Req 6.1, 11.5, 15.2)', () => {
  it('rejects a post-admission read of an oversized external body with content_too_large (returned, not thrown)', async () => {
    const { runtime, view } = buildWorkerRuntime();
    // Post-admission: the AdmissionController register stage admits into the SAME view (COW).
    view.admit(new OversizedExternalProvider());

    const input: ReadSkillInput = { ref: { kind: 'name', name: EXTERNAL_SKILL, provider: EXTERNAL_ID } };
    const resp = await busRequest(runtime, SkillsCapabilities.read.method, input);

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('content_too_large');
      expect(resp.error).toMatchObject({ code: 'content_too_large', provider: EXTERNAL_ID });
    }
  });

  it('leaves the bundled-only baseline read unchanged over the same bus path', async () => {
    const { runtime } = buildWorkerRuntime();

    const input: ReadSkillInput = { ref: { kind: 'name', name: 'runtime-concepts' } };
    const resp = (await busRequest(runtime, SkillsCapabilities.read.method, input)) as SkillResponse<SkillContent>;

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect(resp.provenance.fqid).toBe('bundled:runtime-concepts');
      expect(resp.provenance.provider).toBe('bundled');
      expect(resp.data.body.length).toBeGreaterThan(0);
    }
  });

  it('admitting the oversized provider does not affect a sibling bundled read (partial-failure isolation)', async () => {
    const { runtime, view } = buildWorkerRuntime();
    view.admit(new OversizedExternalProvider());

    const bundledResp = (await busRequest(runtime, SkillsCapabilities.read.method, {
      ref: { kind: 'name', name: 'runtime-concepts' },
    })) as SkillResponse<SkillContent>;

    expect(bundledResp.ok).toBe(true);
    if (bundledResp.ok) expect(bundledResp.data.body.length).toBeGreaterThan(0);
  });
});
