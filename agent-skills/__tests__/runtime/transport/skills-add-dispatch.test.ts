/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// skills.add.v1 — ParamCodec schema + bus dispatch + quarantined wire code
// (Milestone-002, Task 9.2; design §"Components" 7, §"Error Handling", §"Property 7").
//
// Subjects under test (the REAL components, no mocking of the subject):
//   - runtime/transport/param-codec.ts
//       AddSkillSchema registered under 'skills.add.v1'; KNOWN_ERROR_CODES gains
//       'quarantined'; decodeResponse accepts a quarantine as a valid wire SkillResponse.
//   - runtime/admission/admission-capabilities.ts
//       admissionOutcomeToResponse → the `quarantined` envelope on the wire.
//   - the in-process request seam vs the bus worker dispatch path for 'skills.add.v1'.
//
// Property 7 (transport equivalence, design §"Property 7"; Validates: Requirements 1.4):
//   For the SAME raw descriptor, admitting it IN-PROCESS (runtime.request) and OVER THE BUS
//   (ParamCodec.decode → normalize → controller.admit → toSkillResponse → JSON wire →
//   decodeResponse) produces a STRUCTURALLY EQUIVALENT SkillResponse — same `ok`; on success
//   the same AdmittedProvider data + provenance core; on quarantine the same `quarantined`
//   envelope (same `stage`, same typed `cause`).
//
// Also verified (Req 1.3, 9.2, 9.4):
//   - AddSkillSchema validates the RAW descriptor at the single bus boundary;
//   - a quarantine over the bus is a structurally valid SkillResponse decodeResponse accepts;
//   - KNOWN_ERROR_CODES includes 'quarantined' and the wire validator accepts it.
//
// A deterministic in-memory blueprint stands in for a real external provider so the property
// is exercised WITHOUT real HTTPS (the real-HTTPS path is proven by the live E2E, Task 11).
//
// Validates: Requirements 1.3, 1.4, 9.2, 9.4
// =============================================================================

import * as fc from 'fast-check';
import { AdmissionController } from '../../../runtime/admission/admission-controller.js';
import { AdmissionCapabilityHandler } from '../../../runtime/admission/admission-capabilities.js';
import { ProviderBlueprintRegistry } from '../../../runtime/admission/blueprint-registry.js';
import { Sha256ContentHasher } from '../../../runtime/admission/content-hasher.js';
import { NamespaceOwnershipTable } from '../../../runtime/admission/namespace-ownership.js';
import { OperationBudget } from '../../../runtime/admission/operation-budget.js';
import { normalizeDescriptor } from '../../../runtime/admission/provider-descriptor.js';
import type {
  ProviderBlueprint,
  ProviderCreationContext,
} from '../../../runtime/admission/provider-blueprint.js';
import type { Schema, SchemaResult } from '../../../runtime/admission/schema.js';
import type { RawProviderDescriptor } from '../../../runtime/admission/provider-descriptor.js';
import { InProcessSkillsRuntime } from '../../../runtime/in-process-runtime.js';
import { MutableProviderView } from '../../../runtime/registry.js';
import { AdmissionCapabilities } from '../../../runtime/capabilities.js';
import { ParamCodec, AddSkillSchema, KNOWN_ERROR_CODES } from '../../../runtime/transport/param-codec.js';
import { formatFqid } from '../../../runtime/fqid.js';
import type {
  ListSkillsInput,
  ResolvedSkill,
  SkillContent,
  SkillDescriptor,
  SkillProvider,
  SkillProviderCapabilities,
  SkillRef,
  SkillResponse,
} from '../../../runtime/contract.js';

// -----------------------------------------------------------------------------
// Deterministic in-memory provider + blueprint ('mem') — no I/O, no HTTPS.
//
// The acquire stage calls provider.list() then provider.read(resolved); the admit stage
// guards the acquired descriptor identity and verifies its FQID falls under the namespace.
// This provider mints `${namespace}:${name}` and serves a fixed body, so admission is fully
// deterministic and the content hash is stable across both transports.
// -----------------------------------------------------------------------------

interface MemConfig {
  readonly name: string;
  readonly body: string;
}

/** Config schema requiring `name` + `body` strings — a missing field → validate quarantine. */
const memConfigSchema: Schema<MemConfig> = {
  parse(input: unknown): SchemaResult<MemConfig> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return { ok: false, issues: ['config must be an object'] };
    }
    const obj = input as Record<string, unknown>;
    const issues: string[] = [];
    if (typeof obj.name !== 'string' || obj.name.length === 0) {
      issues.push('name is required and must be a non-empty string');
    }
    if (typeof obj.body !== 'string') {
      issues.push('body is required and must be a string');
    }
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: { name: obj.name as string, body: obj.body as string } };
  },
};

class MemSkillProvider implements SkillProvider {
  readonly id: string;
  readonly capabilities: SkillProviderCapabilities = {
    read: true,
    list: true,
    search: false,
    references: false,
  };

  constructor(
    private readonly config: MemConfig,
    ctx: ProviderCreationContext,
  ) {
    this.id = ctx.namespace;
  }

  private resolvedSkill(): ResolvedSkill {
    const descriptor: SkillDescriptor = {
      fqid: formatFqid({ provider: this.id, name: this.config.name }),
      name: this.config.name,
      provider: this.id,
      source: `mem://${this.id}/${this.config.name}`,
    };
    return { descriptor, providerId: this.id, provenanceSeed: { source: descriptor.source } };
  }

  async resolve(ref: SkillRef): Promise<ResolvedSkill[]> {
    const skill = this.resolvedSkill();
    if (ref.kind === 'name' && ref.name === this.config.name) return [skill];
    if (ref.kind === 'fqid' && ref.fqid === skill.descriptor.fqid) return [skill];
    return [];
  }

  async list(_input?: ListSkillsInput): Promise<ResolvedSkill[]> {
    return [this.resolvedSkill()];
  }

  async read(_resolved: ResolvedSkill): Promise<SkillContent> {
    return { descriptor: this.resolvedSkill().descriptor, body: this.config.body };
  }
}

class MemSkillProviderBlueprint implements ProviderBlueprint<MemConfig> {
  readonly id = 'mem';
  readonly configSchema = memConfigSchema;
  create(config: MemConfig, ctx: ProviderCreationContext): SkillProvider {
    return new MemSkillProvider(config, ctx);
  }
}

// -----------------------------------------------------------------------------
// Admission wiring — a fresh, isolated setup per call so admission state (namespace
// ownership, provider view) never leaks between the two transport paths or runs.
// -----------------------------------------------------------------------------

interface AdmissionSetup {
  runtime: InProcessSkillsRuntime;
  handler: AdmissionCapabilityHandler;
  view: MutableProviderView;
}

function buildAdmission(): AdmissionSetup {
  const view = new MutableProviderView([]);
  const namespaces = new NamespaceOwnershipTable();
  const blueprints = new ProviderBlueprintRegistry();
  blueprints.register(new MemSkillProviderBlueprint());
  const controller = new AdmissionController(
    blueprints,
    view,
    namespaces,
    new OperationBudget(5_000),
    new Sha256ContentHasher(),
  );
  const handler = new AdmissionCapabilityHandler(controller);
  // The runtime reads from the SAME view admission registers into, and is given the admission
  // seam so request(skills.add.v1, raw) is reachable in-process (design §"Components" 7).
  const runtime = new InProcessSkillsRuntime(view, undefined, namespaces, handler);
  return { runtime, handler, view };
}

/** Represent the NDJSON serialization boundary: anything on the wire is JSON. */
function jsonWire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * The bus path — a faithful mirror of the worker dispatch for 'skills.add.v1':
 * encode → JSON wire → ParamCodec.decode(AddSkillSchema) → normalize → controller.admit →
 * toSkillResponse → JSON wire → decodeResponse (the untrusted-worker structural validation).
 */
async function admitOverBus(
  setup: AdmissionSetup,
  raw: RawProviderDescriptor,
): Promise<SkillResponse<unknown>> {
  const params = ParamCodec.encode(AdmissionCapabilities.add, raw);
  const wireParams = jsonWire(params);
  const decoded = ParamCodec.decode(AdmissionCapabilities.add.method, wireParams);
  if (!decoded.ok) {
    return ParamCodec.decodeResponse(AdmissionCapabilities.add, jsonWire({ ok: false, error: decoded.error }));
  }
  // The worker dispatch hands the decoded RAW descriptor to the admission handler.
  const response = await setup.handler.handle(decoded.input as RawProviderDescriptor);
  return ParamCodec.decodeResponse(AdmissionCapabilities.add, jsonWire(response));
}

/** The in-process path — the SAME request seam, no serialization (design §"Components" 7). */
async function admitInProcess(
  setup: AdmissionSetup,
  raw: RawProviderDescriptor,
): Promise<SkillResponse<unknown>> {
  return setup.runtime.request(AdmissionCapabilities.add, raw);
}

// =============================================================================
// AddSkillSchema — single bus-boundary validation of the RAW descriptor (Req 1.3)
// =============================================================================

describe('AddSkillSchema (Req 1.3)', () => {
  it('is registered under the skills.add.v1 method and accepts a valid raw descriptor', () => {
    const decoded = ParamCodec.decode(AdmissionCapabilities.add.method, {
      factoryId: 'mem',
      config: { name: 'doc', body: 'hello' },
      namespace: 'acme',
    });
    expect(decoded.ok).toBe(true);
  });

  it('accepts an omitted trust / capabilityVersions (optional on the wire, Req 1.2)', () => {
    const parsed = AddSkillSchema.safeParse({
      factoryId: 'mem',
      config: {},
      namespace: 'acme',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a missing/blank factoryId as bad_request naming the field', () => {
    const decoded = ParamCodec.decode(AdmissionCapabilities.add.method, {
      factoryId: '',
      config: {},
      namespace: 'acme',
    });
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error('expected failure');
    expect(decoded.error.code).toBe('bad_request');
    if (decoded.error.code !== 'bad_request') throw new Error('expected bad_request');
    expect(decoded.error.issues.some((i) => i.startsWith('factoryId'))).toBe(true);
  });

  it('rejects a missing namespace as bad_request', () => {
    const decoded = ParamCodec.decode(AdmissionCapabilities.add.method, {
      factoryId: 'mem',
      config: {},
    });
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error('expected failure');
    expect(decoded.error.code).toBe('bad_request');
  });

  it('rejects a malformed trust object at the boundary', () => {
    const parsed = AddSkillSchema.safeParse({
      factoryId: 'mem',
      config: {},
      namespace: 'acme',
      trust: { tier: 'super-trusted' },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown top-level descriptor key (strict envelope)', () => {
    const parsed = AddSkillSchema.safeParse({
      factoryId: 'mem',
      config: {},
      namespace: 'acme',
      injected: 'nope',
    });
    expect(parsed.success).toBe(false);
  });
});

// =============================================================================
// quarantined is a known wire code; decodeResponse accepts the envelope (Req 9.4)
// =============================================================================

describe('quarantined wire code (Req 9.4)', () => {
  it('KNOWN_ERROR_CODES includes quarantined', () => {
    expect(KNOWN_ERROR_CODES).toContain('quarantined');
  });

  it('decodeResponse accepts a quarantined error response as a valid wire SkillResponse', () => {
    const wire = {
      ok: false,
      error: {
        code: 'quarantined',
        stage: 'admit',
        cause: { code: 'bad_request', issues: ["namespace 'bundled' is reserved"] },
      },
    };
    const decoded = ParamCodec.decodeResponse(AdmissionCapabilities.add, jsonWire(wire));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error('expected failure');
    expect(decoded.error.code).toBe('quarantined');
    if (decoded.error.code !== 'quarantined') throw new Error('expected quarantined');
    // The envelope preserves BOTH the rejecting stage and the authoritative typed cause.
    expect(decoded.error.stage).toBe('admit');
    expect(decoded.error.cause.code).toBe('bad_request');
  });

  it('decodeResponse still rejects an unknown top-level error code', () => {
    const decoded = ParamCodec.decodeResponse(
      AdmissionCapabilities.add,
      jsonWire({ ok: false, error: { code: 'totally_made_up' } }),
      'bus:test',
    );
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error('expected failure');
    // A malformed wire response maps to a provider_error carrying the transport origin.
    expect(decoded.error.code).toBe('provider_error');
  });
});

// =============================================================================
// Property 7: transport equivalence for skills.add.v1 (Req 1.4)
// =============================================================================

// Only SCHEMA-VALID raw descriptors so both paths reach admission (the bus path's decode
// always succeeds, exactly as the core-capability equivalence test does).
const factoryIdArb = fc.constantFrom('mem', 'no-such-factory');
const namespaceArb = fc.constantFrom('acme', 'widgets', 'bundled'); // 'bundled' → admit quarantine
const configArb = fc.oneof(
  // valid mem config
  fc
    .tuple(fc.constantFrom('doc', 'guide', 'readme'), fc.string())
    .map(([name, body]) => ({ name, body })),
  // invalid mem config (missing body) → validate quarantine
  fc.record({ name: fc.constantFrom('doc', 'guide') }),
);

const rawDescriptorArb: fc.Arbitrary<RawProviderDescriptor> = fc
  .tuple(factoryIdArb, namespaceArb, configArb)
  .map(([factoryId, namespace, config]) => ({ factoryId, namespace, config }));

function provenanceCore(resp: SkillResponse<unknown>): Record<string, unknown> | undefined {
  if (!resp.ok) return undefined;
  const p = resp.provenance;
  return { fqid: p.fqid, provider: p.provider, source: p.source, contentHash: p.contentHash };
}

function coreMeaning(resp: SkillResponse<unknown>): Record<string, unknown> {
  if (resp.ok) {
    return { ok: true, data: jsonWire(resp.data), provenance: provenanceCore(resp) };
  }
  return { ok: false, error: jsonWire(resp.error) };
}

describe('Property 7: skills.add.v1 transport equivalence (Req 1.4)', () => {
  it('in-process and over-the-bus admission produce structurally equivalent SkillResponses', async () => {
    let successCount = 0;
    let quarantineCount = 0;
    await fc.assert(
      fc.asyncProperty(rawDescriptorArb, async (raw) => {
        // Fresh, isolated admission state per path so neither run observes the other's claim.
        const a = await admitInProcess(buildAdmission(), raw);
        const b = await admitOverBus(buildAdmission(), raw);
        expect(coreMeaning(b)).toEqual(coreMeaning(a));
        if (a.ok) successCount += 1;
        else if (a.error.code === 'quarantined') quarantineCount += 1;
      }),
      { numRuns: 120 },
    );
    // Guard against a trivially-green property: both a successful admission and a quarantine
    // must have been exercised.
    expect(successCount).toBeGreaterThan(0);
    expect(quarantineCount).toBeGreaterThan(0);
  });

  it('a successful admission is equivalent and ok on both transports', async () => {
    const raw: RawProviderDescriptor = {
      factoryId: 'mem',
      namespace: 'acme',
      config: { name: 'doc', body: 'the body bytes' },
    };
    const a = await admitInProcess(buildAdmission(), raw);
    const b = await admitOverBus(buildAdmission(), raw);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(coreMeaning(b)).toEqual(coreMeaning(a));
    if (a.ok && b.ok) {
      expect(b.provenance.fqid).toBe('acme:doc');
      expect(b.provenance.contentHash).toBe(a.provenance.contentHash);
      expect(typeof b.provenance.contentHash).toBe('string');
    }
  });

  it('a quarantine over the bus is a structurally valid SkillResponse (reserved namespace)', async () => {
    const raw: RawProviderDescriptor = {
      factoryId: 'mem',
      namespace: 'bundled', // reserved → admit-stage quarantine
      config: { name: 'doc', body: 'x' },
    };
    const b = await admitOverBus(buildAdmission(), raw);

    expect(b.ok).toBe(false);
    if (b.ok) throw new Error('expected quarantine');
    expect(b.error.code).toBe('quarantined');
    if (b.error.code !== 'quarantined') throw new Error('expected quarantined');
    expect(b.error.stage).toBe('admit');
    expect(b.error.cause.code).toBe('bad_request');
  });

  it('an unknown factoryId quarantines equivalently on both transports (discover stage)', async () => {
    const raw: RawProviderDescriptor = {
      factoryId: 'no-such-factory',
      namespace: 'acme',
      config: {},
    };
    const a = await admitInProcess(buildAdmission(), raw);
    const b = await admitOverBus(buildAdmission(), raw);

    expect(coreMeaning(b)).toEqual(coreMeaning(a));
    if (b.ok) throw new Error('expected quarantine');
    expect(b.error.code).toBe('quarantined');
    if (b.error.code !== 'quarantined') throw new Error('expected quarantined');
    expect(b.error.stage).toBe('discover');
  });

  it('request(skills.add.v1) returns unsupported when no admission handler is wired (baseline)', async () => {
    // Backward-compat: a runtime without the admission seam treats the extension as unsupported.
    const runtime = new InProcessSkillsRuntime(new MutableProviderView([]));
    const resp = await runtime.request(AdmissionCapabilities.add, {
      factoryId: 'mem',
      namespace: 'acme',
      config: { name: 'doc', body: 'x' },
    });
    expect(resp.ok).toBe(false);
    if (resp.ok) throw new Error('expected failure');
    expect(resp.error.code).toBe('unsupported');
  });
});
