/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Unit + property tests — AdmissionController composition + admission properties
// (Milestone-002, Task 8.2; design §"Components" 2 / "Correctness Properties";
//  Req 2.4, 3.6, 8.1, 9.1, 9.3).
//
// Subject under test:
//   - runtime/admission/admission-controller.ts
//       AdmissionController.admit(descriptor): composes discover → validate → acquire →
//       hash-record → admit → register under ONE budget signal; first failing stage
//       short-circuits to a quarantine naming that stage; a thrown stage → provider_error
//       quarantine; on full success → { ok: true; admitted }.
//
// Properties (design §"Correctness Properties"):
//   - Property 1: admission totality — admit() resolves to an AdmissionOutcome and never
//                 throws, for success / returned-error / thrown stage behaviors.
//   - Property 2: quarantine leaves registry.providers() identical before/after.
//   - Property 5: authority is earned — no path registers unless validate + bounded acquire
//                 + content-as-data + namespace claim all succeed.
//   - Property 6: content over maxContentBytes → content_too_large.
//
// Validates: Requirements 2.4, 3.6, 8.1, 9.1, 9.3
// =============================================================================

import * as fc from 'fast-check';

import { AdmissionController } from '../../../runtime/admission/admission-controller.js';
import { ProviderBlueprintRegistry } from '../../../runtime/admission/blueprint-registry.js';
import { Sha256ContentHasher, type ContentHasher } from '../../../runtime/admission/content-hasher.js';
import { NamespaceOwnershipTable } from '../../../runtime/admission/namespace-ownership.js';
import { OperationBudget } from '../../../runtime/admission/operation-budget.js';
import type {
  ProviderBlueprint,
  ProviderCreationContext,
} from '../../../runtime/admission/provider-blueprint.js';
import type { ProviderDescriptor } from '../../../runtime/admission/provider-descriptor.js';
import type { Schema, SchemaResult } from '../../../runtime/admission/schema.js';
import { MutableProviderView } from '../../../runtime/registry.js';
import { formatFqid } from '../../../runtime/fqid.js';
import { UNTRUSTED_DEFAULT } from '../../../runtime/trust.js';
import type {
  ListSkillsInput,
  ResolvedSkill,
  SkillContent,
  SkillProvider,
  SkillProviderCapabilities,
  SkillRef,
  SkillRuntimeError,
} from '../../../runtime/contract.js';

// --- Fixtures -----------------------------------------------------------------

const CAPS: SkillProviderCapabilities = { read: true, list: true, search: false, references: false };

/** Controllable acquisition behavior for the fake provider built by the fake blueprint. */
type ReadBehavior =
  | { kind: 'ok'; body: string }
  | { kind: 'typed'; error: SkillRuntimeError }
  | { kind: 'throw'; error: Error };

interface FakeConfig {
  readonly url: string;
  /** Optional override of the minted skill name (to drive an out-of-namespace FQID). */
  readonly mintProvider?: string;
}

/** Permissive schema: accepts `{ url: string, mintProvider?: string }`; rejects non-strings. */
const fakeConfigSchema: Schema<FakeConfig> = {
  parse(input: unknown): SchemaResult<FakeConfig> {
    if (typeof input !== 'object' || input === null) {
      return { ok: false, issues: ['config must be an object'] };
    }
    const obj = input as { url?: unknown; mintProvider?: unknown };
    if (typeof obj.url !== 'string') {
      return { ok: false, issues: ['url must be a string'] };
    }
    if (obj.mintProvider !== undefined && typeof obj.mintProvider !== 'string') {
      return { ok: false, issues: ['mintProvider must be a string when present'] };
    }
    return {
      ok: true,
      value: { url: obj.url, ...(obj.mintProvider !== undefined ? { mintProvider: obj.mintProvider } : {}) },
    };
  },
};

/**
 * A controllable provider whose single skill's FQID prefix and `read` behavior are
 * configurable, so the fake blueprint can drive every pipeline branch deterministically.
 */
class FakeProvider implements SkillProvider {
  readonly capabilities = CAPS;

  constructor(
    readonly id: string,
    /** The provider prefix the minted descriptor uses (defaults to `id`). */
    private readonly mintProvider: string,
    private readonly behavior: ReadBehavior,
  ) { }

  private resolved(): ResolvedSkill {
    const descriptor = {
      fqid: formatFqid({ provider: this.mintProvider, name: 'doc' }),
      name: 'doc',
      provider: this.mintProvider,
      source: 'https://example.com/doc',
    };
    return { descriptor, providerId: this.id, provenanceSeed: { source: descriptor.source } };
  }

  async resolve(_ref: SkillRef): Promise<ResolvedSkill[]> {
    return [this.resolved()];
  }

  async list(_input?: ListSkillsInput): Promise<ResolvedSkill[]> {
    return [this.resolved()];
  }

  async read(resolved: ResolvedSkill, _signal?: AbortSignal): Promise<SkillContent> {
    if (this.behavior.kind === 'ok') {
      return { descriptor: resolved.descriptor, body: this.behavior.body };
    }
    if (this.behavior.kind === 'typed') {
      // Mirror a real provider (e.g. HttpProviderError): throw carrying a typed runtimeError.
      throw Object.assign(new Error('typed provider failure'), { runtimeError: this.behavior.error });
    }
    throw this.behavior.error;
  }
}

/** A fake blueprint (id 'fake') whose constructed provider's behavior is configurable. */
class FakeBlueprint implements ProviderBlueprint<FakeConfig> {
  readonly id = 'fake';
  readonly configSchema = fakeConfigSchema;
  constructor(private readonly behavior: ReadBehavior = { kind: 'ok', body: 'hello' }) { }
  create(config: FakeConfig, ctx: ProviderCreationContext): SkillProvider {
    // mintProvider from config drives an out-of-namespace FQID when it differs from namespace.
    return new FakeProvider(ctx.namespace, config.mintProvider ?? ctx.namespace, this.behavior);
  }
}

function makeDescriptor(overrides: Partial<ProviderDescriptor> = {}): ProviderDescriptor {
  return {
    factoryId: 'fake',
    config: { url: 'https://example.com/doc' },
    namespace: 'acme',
    trust: UNTRUSTED_DEFAULT,
    capabilityVersions: {},
    ...overrides,
  };
}

/** Build a controller wired with a fake blueprint of the given behavior + supplied parts. */
function makeController(opts: {
  behavior?: ReadBehavior;
  view?: MutableProviderView;
  namespaces?: NamespaceOwnershipTable;
  hasher?: ContentHasher;
  timeoutMs?: number;
} = {}): { controller: AdmissionController; view: MutableProviderView; namespaces: NamespaceOwnershipTable } {
  const blueprints = new ProviderBlueprintRegistry();
  blueprints.register(new FakeBlueprint(opts.behavior ?? { kind: 'ok', body: 'hello' }));
  const view = opts.view ?? new MutableProviderView();
  const namespaces = opts.namespaces ?? new NamespaceOwnershipTable();
  // Large timeout so the budget never fires during deterministic fast fakes.
  const budget = new OperationBudget(opts.timeoutMs ?? 5_000);
  const hasher = opts.hasher ?? new Sha256ContentHasher();
  const controller = new AdmissionController(blueprints, view, namespaces, budget, hasher);
  return { controller, view, namespaces };
}

// =============================================================================
// Unit tests — composition: success + per-stage short-circuit naming
// =============================================================================

describe('AdmissionController composition (Req 2.5, 9.2)', () => {
  it('admits a well-formed provider end-to-end and registers it last', async () => {
    const { controller, view, namespaces } = makeController({ behavior: { kind: 'ok', body: 'body' } });

    const outcome = await controller.admit(makeDescriptor());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.admitted.descriptor.fqid).toBe('acme:doc');
    expect(outcome.admitted.contentHash).toBe(new Sha256ContentHasher().hash('body'));
    expect(view.providers()).toHaveLength(1);
    expect(view.providers()[0].id).toBe('acme');
    expect(namespaces.owns('acme')).toBe('acme');
  });

  it('quarantines at discover for an unknown factoryId (names the stage)', async () => {
    const { controller, view } = makeController();

    const outcome = await controller.admit(makeDescriptor({ factoryId: 'missing' }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected quarantine');
    expect(outcome.stage).toBe('discover');
    expect(outcome.error.code).toBe('bad_request');
    expect(view.providers()).toHaveLength(0);
  });

  it('quarantines at validate for an invalid config (names the stage)', async () => {
    const { controller, view } = makeController();

    const outcome = await controller.admit(makeDescriptor({ config: { url: 42 } }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected quarantine');
    expect(outcome.stage).toBe('validate');
    expect(outcome.error.code).toBe('bad_request');
    expect(view.providers()).toHaveLength(0);
  });

  it('quarantines at acquire when the provider reports content_too_large', async () => {
    const tooLarge: SkillRuntimeError = { code: 'content_too_large', provider: 'acme', limitBytes: 10 };
    const { controller, view } = makeController({ behavior: { kind: 'typed', error: tooLarge } });

    const outcome = await controller.admit(makeDescriptor());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected quarantine');
    expect(outcome.stage).toBe('acquire');
    expect(outcome.error).toEqual(tooLarge);
    expect(view.providers()).toHaveLength(0);
  });

  it('quarantines at admit for an FQID outside the claimed namespace (no claim, no register)', async () => {
    const { controller, view, namespaces } = makeController({ behavior: { kind: 'ok', body: 'b' } });

    // The provider mints under 'evil' while the descriptor claims 'acme'.
    const outcome = await controller.admit(
      makeDescriptor({ config: { url: 'https://example.com/doc', mintProvider: 'evil' } }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected quarantine');
    expect(outcome.stage).toBe('admit');
    expect(outcome.error.code).toBe('bad_request');
    expect(view.providers()).toHaveLength(0);
    expect(namespaces.owns('acme')).toBeUndefined();
  });

  it('quarantines at admit for the reserved bundled namespace', async () => {
    const { controller, view } = makeController({ behavior: { kind: 'ok', body: 'b' } });

    const outcome = await controller.admit(
      makeDescriptor({ namespace: 'bundled', config: { url: 'https://example.com/doc' } }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected quarantine');
    expect(outcome.stage).toBe('admit');
    expect(view.providers()).toHaveLength(0);
  });

  it('converts a thrown stage (hasher throws) into a provider_error quarantine, never throws', async () => {
    const throwingHasher: ContentHasher = {
      hash() {
        throw new Error('hasher boom');
      },
    };
    const { controller, view } = makeController({ behavior: { kind: 'ok', body: 'b' }, hasher: throwingHasher });

    const outcome = await controller.admit(makeDescriptor());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected quarantine');
    expect(outcome.stage).toBe('hash-record');
    expect(outcome.error.code).toBe('provider_error');
    if (outcome.error.code !== 'provider_error') throw new Error('narrowing');
    expect(outcome.error.message).toContain('hasher boom');
    expect(view.providers()).toHaveLength(0);
  });
});

// =============================================================================
// Property 1: admission totality (Req 2.4, 9.1)
// =============================================================================

/** The space of stage behaviors a fuzzed admission can exhibit. */
type AdmissionScenario =
  | { tag: 'success' }
  | { tag: 'discover-error' }
  | { tag: 'validate-error' }
  | { tag: 'acquire-too-large' }
  | { tag: 'acquire-throw' }
  | { tag: 'admit-out-of-namespace' }
  | { tag: 'admit-reserved' }
  | { tag: 'hash-throw' };

const scenarioArb: fc.Arbitrary<AdmissionScenario> = fc.constantFrom(
  { tag: 'success' },
  { tag: 'discover-error' },
  { tag: 'validate-error' },
  { tag: 'acquire-too-large' },
  { tag: 'acquire-throw' },
  { tag: 'admit-out-of-namespace' },
  { tag: 'admit-reserved' },
  { tag: 'hash-throw' },
);

/** Build a controller + descriptor that realizes the given scenario. */
function controllerForScenario(
  scenario: AdmissionScenario,
  body: string,
): { controller: AdmissionController; view: MutableProviderView; descriptor: ProviderDescriptor } {
  let behavior: ReadBehavior = { kind: 'ok', body };
  let hasher: ContentHasher = new Sha256ContentHasher();
  let descriptor = makeDescriptor();

  switch (scenario.tag) {
    case 'success':
      break;
    case 'discover-error':
      descriptor = makeDescriptor({ factoryId: 'unregistered' });
      break;
    case 'validate-error':
      descriptor = makeDescriptor({ config: { url: 99 } });
      break;
    case 'acquire-too-large':
      behavior = { kind: 'typed', error: { code: 'content_too_large', provider: 'acme', limitBytes: 1 } };
      break;
    case 'acquire-throw':
      behavior = { kind: 'throw', error: new Error('origin unavailable') };
      break;
    case 'admit-out-of-namespace':
      descriptor = makeDescriptor({ config: { url: 'https://example.com/doc', mintProvider: 'evil' } });
      break;
    case 'admit-reserved':
      descriptor = makeDescriptor({ namespace: 'bundled', config: { url: 'https://example.com/doc' } });
      break;
    case 'hash-throw':
      hasher = {
        hash() {
          throw new Error('hasher boom');
        },
      };
      break;
  }

  const { controller, view } = makeController({ behavior, hasher });
  return { controller, view, descriptor };
}

describe('Property 1: admission totality (Req 2.4, 9.1)', () => {
  it('admit() resolves to a well-formed AdmissionOutcome and never throws', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, fc.string(), async (scenario, body) => {
        const { controller, descriptor } = controllerForScenario(scenario, body);

        // Must not throw — capture the resolved outcome.
        const outcome = await controller.admit(descriptor);

        // A well-formed AdmissionOutcome: a discriminated union on `ok`.
        expect(typeof outcome.ok).toBe('boolean');
        if (outcome.ok) {
          expect(outcome.admitted).toBeDefined();
          expect(typeof outcome.admitted.descriptor.fqid).toBe('string');
          expect(typeof outcome.admitted.contentHash).toBe('string');
        } else {
          // Names the rejecting stage and carries a typed error code (Req 9.2).
          expect(typeof outcome.stage).toBe('string');
          expect(typeof outcome.error.code).toBe('string');
        }
      }),
      { numRuns: 200 },
    );
  });
});

// =============================================================================
// Property 2: quarantine leaves registry.providers() identical (Req 9.3)
// =============================================================================

/** The quarantining scenarios (every behavior except a full success). */
const quarantineScenarioArb: fc.Arbitrary<AdmissionScenario> = fc.constantFrom(
  { tag: 'discover-error' },
  { tag: 'validate-error' },
  { tag: 'acquire-too-large' },
  { tag: 'acquire-throw' },
  { tag: 'admit-out-of-namespace' },
  { tag: 'admit-reserved' },
  { tag: 'hash-throw' },
);

describe('Property 2: quarantine leaves the registry unchanged (Req 9.3)', () => {
  it('providers() is identical before and after any quarantining admit', async () => {
    await fc.assert(
      fc.asyncProperty(quarantineScenarioArb, fc.string(), async (scenario, body) => {
        const { controller, view, descriptor } = controllerForScenario(scenario, body);
        const before = view.providers();

        const outcome = await controller.admit(descriptor);

        // The scenarios are all quarantines.
        expect(outcome.ok).toBe(false);
        const after = view.providers();
        // Same reference snapshot AND same membership — no copy-on-write add happened.
        expect(after).toBe(before);
        expect(after).toHaveLength(before.length);
      }),
      { numRuns: 200 },
    );
  });
});

// =============================================================================
// Property 5: authority is earned (Req 3.6)
// =============================================================================

describe('Property 5: authority is earned — no register on a failing stage (Req 3.6)', () => {
  it('a provider is registered iff every prior stage succeeded', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, fc.string(), async (scenario, body) => {
        const { controller, view, descriptor } = controllerForScenario(scenario, body);
        const sizeBefore = view.providers().length;

        const outcome = await controller.admit(descriptor);

        const registered = view.providers().length > sizeBefore;
        // Registration happens EXACTLY when the outcome is a full success — never on a
        // failing stage (validate / acquire / admit / hash gate registration).
        expect(registered).toBe(outcome.ok);
      }),
      { numRuns: 200 },
    );
  });
});

// =============================================================================
// Property 6: bound enforcement (Req 8.1)
// =============================================================================

describe('Property 6: content over maxContentBytes → content_too_large (Req 8.1)', () => {
  it('admit quarantines at acquire with content_too_large for any over-limit body', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1_000_000 }), async (limitBytes) => {
        // A deterministic over-limit provider: its read reports the bound was exceeded.
        const tooLarge: SkillRuntimeError = { code: 'content_too_large', provider: 'acme', limitBytes };
        const { controller, view } = makeController({ behavior: { kind: 'typed', error: tooLarge } });

        const outcome = await controller.admit(makeDescriptor());

        expect(outcome.ok).toBe(false);
        if (outcome.ok) throw new Error('expected quarantine');
        expect(outcome.stage).toBe('acquire');
        expect(outcome.error.code).toBe('content_too_large');
        if (outcome.error.code !== 'content_too_large') throw new Error('narrowing');
        expect(outcome.error.limitBytes).toBe(limitBytes);
        // No registration on the bound failure (Property 5 corollary).
        expect(view.providers()).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });
});
