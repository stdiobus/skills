/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Unit tests — admission pipeline stage classes
// (Milestone-002, Task 8.1; design §"Components" 2; Req 2.2, 2.3, 2.4, 4.1, 5.3, 8.1, 8.3).
//
// Subject under test:
//   - runtime/admission/stages.ts
//       DiscoverStage   — resolve blueprint + build creation context; unknown → bad_request
//       ValidateStage   — configSchema.parse → bad_request on fail; (build) the candidate
//       AcquireStage    — bounded read under signal; content_too_large / provider_error
//       HashRecordStage — record-only content hash
//       AdmitStage      — content-as-data guard → FQID ⊆ namespace → namespaces.claim
//       RegisterStage   — copy-on-write MutableProviderView.admit → AdmittedProvider
//
// Each stage is verified for its success path AND the failure that short-circuits it.
//
// Validates: Requirements 2.2, 2.3, 2.4, 4.1, 5.3, 8.1, 8.3
// =============================================================================

import {
  AcquireStage,
  AdmitStage,
  DiscoverStage,
  HashRecordStage,
  RegisterStage,
  ValidateStage,
} from '../../../runtime/admission/stages.js';
import type {
  AcquireResult,
  DiscoverResult,
  HashRecordResult,
  ValidateResult,
} from '../../../runtime/admission/stages.js';
import { ProviderBlueprintRegistry } from '../../../runtime/admission/blueprint-registry.js';
import { Sha256ContentHasher } from '../../../runtime/admission/content-hasher.js';
import { noCredentialHeaders } from '../../../runtime/admission/credential-headers.js';
import { NamespaceOwnershipTable } from '../../../runtime/admission/namespace-ownership.js';
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

interface FakeConfig {
  readonly url: string;
}

const fakeConfigSchema: Schema<FakeConfig> = {
  parse(input: unknown): SchemaResult<FakeConfig> {
    if (typeof input !== 'object' || input === null) {
      return { ok: false, issues: ['config must be an object'] };
    }
    const url = (input as { url?: unknown }).url;
    if (typeof url !== 'string') {
      return { ok: false, issues: ['url must be a string'] };
    }
    return { ok: true, value: { url } };
  },
};

const CAPS: SkillProviderCapabilities = { read: true, list: true, search: false, references: false };

/** A controllable provider whose `read` behavior is configurable per test. */
type ReadBehavior =
  | { kind: 'ok'; body: string }
  | { kind: 'typed'; error: SkillRuntimeError }
  | { kind: 'throw'; error: Error };

class FakeProvider implements SkillProvider {
  readonly capabilities = CAPS;
  lastSignal: AbortSignal | undefined;

  constructor(
    readonly id: string,
    private readonly skillName: string,
    private readonly behavior: ReadBehavior,
  ) { }

  private resolved(): ResolvedSkill {
    const descriptor = {
      fqid: formatFqid({ provider: this.id, name: this.skillName }),
      name: this.skillName,
      provider: this.id,
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

  async read(resolved: ResolvedSkill, signal?: AbortSignal): Promise<SkillContent> {
    this.lastSignal = signal;
    if (this.behavior.kind === 'ok') {
      return { descriptor: resolved.descriptor, body: this.behavior.body };
    }
    if (this.behavior.kind === 'typed') {
      // A provider throws a typed error carrying a SkillRuntimeError (e.g. HttpProviderError).
      throw Object.assign(new Error('typed provider failure'), {
        runtimeError: this.behavior.error,
      });
    }
    throw this.behavior.error;
  }
}

class FakeBlueprint implements ProviderBlueprint<FakeConfig> {
  readonly id = 'fake';
  readonly configSchema = fakeConfigSchema;
  constructor(private readonly behavior: ReadBehavior = { kind: 'ok', body: 'hello' }) { }
  create(_config: FakeConfig, ctx: ProviderCreationContext): SkillProvider {
    return new FakeProvider(ctx.namespace, 'doc', this.behavior);
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

function makeCreationContext(namespace: string): ProviderCreationContext {
  return { namespace, trust: UNTRUSTED_DEFAULT, credentials: noCredentialHeaders };
}

const NEVER_ABORTS = new AbortController().signal;

function makeContent(namespace: string, name = 'doc', body = 'hello'): SkillContent {
  return {
    descriptor: {
      fqid: formatFqid({ provider: namespace, name }),
      name,
      provider: namespace,
      source: 'https://example.com/doc',
    },
    body,
  };
}

// =============================================================================
// discover
// =============================================================================

describe('DiscoverStage (Req 3.4)', () => {
  it('resolves the blueprint and builds the creation context on success', async () => {
    const registry = new ProviderBlueprintRegistry();
    const blueprint = new FakeBlueprint();
    registry.register(blueprint);
    const stage = new DiscoverStage(registry, noCredentialHeaders);

    const result = await stage.run({ descriptor: makeDescriptor() }, NEVER_ABORTS);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value.blueprint).toBe(blueprint);
    expect(result.value.creationContext).toEqual({
      namespace: 'acme',
      trust: UNTRUSTED_DEFAULT,
      credentials: noCredentialHeaders,
    });
  });

  it('short-circuits with bad_request for an unknown factoryId', async () => {
    const registry = new ProviderBlueprintRegistry();
    const stage = new DiscoverStage(registry);

    const result = await stage.run(
      { descriptor: makeDescriptor({ factoryId: 'nope' }) },
      NEVER_ABORTS,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('bad_request');
    if (result.error.code !== 'bad_request') throw new Error('narrowing');
    expect(result.error.issues[0]).toContain('nope');
  });
});

// =============================================================================
// validate
// =============================================================================

describe('ValidateStage (Req 4.1, 4.3)', () => {
  function discovered(behavior?: ReadBehavior): DiscoverResult {
    const descriptor = makeDescriptor();
    return {
      descriptor,
      blueprint: new FakeBlueprint(behavior) as unknown as ProviderBlueprint<unknown>,
      creationContext: makeCreationContext(descriptor.namespace),
    };
  }

  it('parses the config and constructs the private candidate on success', async () => {
    const stage = new ValidateStage();

    const result = await stage.run(discovered(), NEVER_ABORTS);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value.config).toEqual({ url: 'https://example.com/doc' });
    expect(result.value.provider.id).toBe('acme');
  });

  it('short-circuits with bad_request naming the schema issues', async () => {
    const stage = new ValidateStage();
    const ctx = discovered();
    const bad: DiscoverResult = {
      ...ctx,
      descriptor: makeDescriptor({ config: { url: 42 } }),
    };

    const result = await stage.run(bad, NEVER_ABORTS);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('bad_request');
    if (result.error.code !== 'bad_request') throw new Error('narrowing');
    expect(result.error.issues).toContain('url must be a string');
  });

  it('maps a construction throw to a typed provider_error (stage stays total)', async () => {
    const stage = new ValidateStage();
    const throwing: ProviderBlueprint<unknown> = {
      id: 'fake',
      configSchema: fakeConfigSchema as unknown as Schema<unknown>,
      create() {
        throw new Error('construction boom');
      },
    };
    const ctx: DiscoverResult = {
      descriptor: makeDescriptor(),
      blueprint: throwing,
      creationContext: makeCreationContext('acme'),
    };

    const result = await stage.run(ctx, NEVER_ABORTS);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('provider_error');
    if (result.error.code !== 'provider_error') throw new Error('narrowing');
    expect(result.error.message).toContain('construction boom');
  });
});

// =============================================================================
// acquire
// =============================================================================

describe('AcquireStage (Req 7, 8.1)', () => {
  function validated(behavior: ReadBehavior): ValidateResult {
    const descriptor = makeDescriptor();
    return {
      descriptor,
      blueprint: new FakeBlueprint() as unknown as ProviderBlueprint<unknown>,
      creationContext: makeCreationContext(descriptor.namespace),
      config: { url: descriptor.config },
      provider: new FakeProvider('acme', 'doc', behavior),
    };
  }

  it('reads the content under the budget signal on success', async () => {
    const stage = new AcquireStage();
    const ctx = validated({ kind: 'ok', body: 'acquired-body' });

    const result = await stage.run(ctx, NEVER_ABORTS);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value.content.body).toBe('acquired-body');
    // The budget signal is threaded into the provider read.
    expect((ctx.provider as FakeProvider).lastSignal).toBe(NEVER_ABORTS);
  });

  it('preserves a provider content_too_large typed error (short-circuit)', async () => {
    const stage = new AcquireStage();
    const tooLarge: SkillRuntimeError = {
      code: 'content_too_large',
      provider: 'acme',
      limitBytes: 1000,
    };
    const ctx = validated({ kind: 'typed', error: tooLarge });

    const result = await stage.run(ctx, NEVER_ABORTS);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toEqual(tooLarge);
  });

  it('maps a non-typed fetch fault to provider_error', async () => {
    const stage = new AcquireStage();
    const ctx = validated({ kind: 'throw', error: new Error('origin unavailable') });

    const result = await stage.run(ctx, NEVER_ABORTS);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('provider_error');
    if (result.error.code !== 'provider_error') throw new Error('narrowing');
    expect(result.error.message).toContain('origin unavailable');
  });

  it('rejects a multi-skill list with bad_request (single-skill scope, Req 7.1, 8.1)', async () => {
    const stage = new AcquireStage();
    const ctx = validated({ kind: 'ok', body: 'unused' });
    // A provider whose list() returns more than one skill is out of the M-002 single-skill
    // scope: it must be rejected, not silently first-picked.
    const multiSkill: SkillProvider = {
      id: 'acme',
      capabilities: CAPS,
      async resolve(): Promise<ResolvedSkill[]> {
        return [];
      },
      async list(): Promise<ResolvedSkill[]> {
        const one = makeContent('acme', 'doc-a').descriptor;
        const two = makeContent('acme', 'doc-b').descriptor;
        return [
          { descriptor: one, providerId: 'acme', provenanceSeed: { source: one.source } },
          { descriptor: two, providerId: 'acme', provenanceSeed: { source: two.source } },
        ];
      },
      async read(resolved: ResolvedSkill): Promise<SkillContent> {
        return { descriptor: resolved.descriptor, body: 'unused' };
      },
    };
    const multiCtx: ValidateResult = { ...ctx, provider: multiSkill };

    const result = await stage.run(multiCtx, NEVER_ABORTS);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('bad_request');
    if (result.error.code !== 'bad_request') throw new Error('narrowing');
    expect(result.error.issues[0]).toContain('exactly one skill');
  });
});

// =============================================================================
// hash-record
// =============================================================================

describe('HashRecordStage (Req 8.2)', () => {
  function acquired(body: string): AcquireResult {
    const descriptor = makeDescriptor();
    return {
      descriptor,
      blueprint: new FakeBlueprint() as unknown as ProviderBlueprint<unknown>,
      creationContext: makeCreationContext(descriptor.namespace),
      config: {},
      provider: new FakeProvider('acme', 'doc', { kind: 'ok', body }),
      content: makeContent('acme', 'doc', body),
    };
  }

  it('records the content hash over the acquired body', async () => {
    const hasher = new Sha256ContentHasher();
    const stage = new HashRecordStage(hasher);
    const ctx = acquired('hello-world');

    const result = await stage.run(ctx, NEVER_ABORTS);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value.contentHash).toBe(hasher.hash('hello-world'));
  });
});

// =============================================================================
// admit
// =============================================================================

describe('AdmitStage (Req 5.3, 8.3)', () => {
  function hashed(overrides: { namespace?: string; content?: SkillContent } = {}): HashRecordResult {
    const namespace = overrides.namespace ?? 'acme';
    const descriptor = makeDescriptor({ namespace });
    return {
      descriptor,
      blueprint: new FakeBlueprint() as unknown as ProviderBlueprint<unknown>,
      creationContext: makeCreationContext(namespace),
      config: {},
      provider: new FakeProvider(namespace, 'doc', { kind: 'ok', body: 'b' }),
      content: overrides.content ?? makeContent(namespace),
      contentHash: 'deadbeef',
    };
  }

  it('validates content-as-data, verifies the namespace, and claims it on success', async () => {
    const namespaces = new NamespaceOwnershipTable();
    const stage = new AdmitStage(namespaces);
    const ctx = hashed();

    const result = await stage.run(ctx, NEVER_ABORTS);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value.admittedDescriptor.fqid).toBe('acme:doc');
    expect(namespaces.owns('acme')).toBe('acme');
  });

  it('short-circuits with bad_request for an FQID outside the namespace (no claim)', async () => {
    const namespaces = new NamespaceOwnershipTable();
    const stage = new AdmitStage(namespaces);
    // Acquired descriptor mints under a DIFFERENT prefix than the claimed namespace.
    const ctx = hashed({ namespace: 'acme', content: makeContent('evil') });

    const result = await stage.run(ctx, NEVER_ABORTS);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('bad_request');
    // The ownership table is untouched — the FQID check runs before the claim.
    expect(namespaces.owns('acme')).toBeUndefined();
  });

  it('short-circuits with bad_request when the namespace is reserved (bundled)', async () => {
    const namespaces = new NamespaceOwnershipTable();
    const stage = new AdmitStage(namespaces);
    const ctx = hashed({ namespace: 'bundled', content: makeContent('bundled') });

    const result = await stage.run(ctx, NEVER_ABORTS);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('bad_request');
    expect(namespaces.owns('bundled')).toBeUndefined();
  });
});

// =============================================================================
// register
// =============================================================================

describe('RegisterStage (Req 10.5)', () => {
  function admitted(): {
    descriptor: ProviderDescriptor;
    blueprint: ProviderBlueprint<unknown>;
    creationContext: ProviderCreationContext;
    config: unknown;
    provider: SkillProvider;
    content: SkillContent;
    contentHash: string;
    admittedDescriptor: SkillContent['descriptor'];
  } {
    const descriptor = makeDescriptor();
    const provider = new FakeProvider('acme', 'doc', { kind: 'ok', body: 'b' });
    const content = makeContent('acme');
    return {
      descriptor,
      blueprint: new FakeBlueprint() as unknown as ProviderBlueprint<unknown>,
      creationContext: makeCreationContext('acme'),
      config: {},
      provider,
      content,
      contentHash: 'cafef00d',
      admittedDescriptor: content.descriptor,
    };
  }

  it('copy-on-write adds the provider and returns the AdmittedProvider on success', async () => {
    const view = new MutableProviderView();
    const stage = new RegisterStage(view);
    const ctx = admitted();

    const result = await stage.run(ctx, NEVER_ABORTS);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value).toEqual({
      descriptor: ctx.admittedDescriptor,
      contentHash: 'cafef00d',
    });
    expect(view.providers()).toContain(ctx.provider);
  });
});
