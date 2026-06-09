/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Unit tests — typed blueprint + blueprint registry
// (Milestone-002, Task 2.2; design §"Components" 1).
//
// Subjects under test:
//   - runtime/admission/schema.ts           Schema<TConfig>.parse → ok/fail (returned)
//   - runtime/admission/provider-blueprint.ts ProviderBlueprint<TConfig>, ctx, create
//   - runtime/admission/blueprint-registry.ts ProviderBlueprintRegistry register/resolve
//
// Behavior verified:
//   - register / resolve round-trip (Req 3.2)
//   - unknown factoryId → resolve returns undefined (Req 3.4; discover maps to quarantine)
//   - the binding generic TConfig threads schema → create → provider (§6)
//   - re-registering the same id replaces (last-registration-wins map semantic)
//
// Validates: Requirements 3.2, 3.4, 13.1
// =============================================================================

import { ProviderBlueprintRegistry } from '../../../runtime/admission/blueprint-registry.js';
import type {
  CredentialHeadersProvider,
  ProviderBlueprint,
  ProviderCreationContext,
} from '../../../runtime/admission/provider-blueprint.js';
import type { Schema } from '../../../runtime/admission/schema.js';
import { UNTRUSTED_DEFAULT } from '../../../runtime/trust.js';
import type {
  ResolvedSkill,
  SkillProvider,
  SkillProviderCapabilities,
  SkillRef,
} from '../../../runtime/contract.js';

// --- Test fixtures: a concrete config, schema, provider, and blueprint --------

interface FakeConfig {
  readonly url: string;
}

/**
 * A minimal {@link Schema} whose parsed output IS {@link FakeConfig}. Total + returned:
 * an invalid input yields `{ ok: false; issues }`, never a throw.
 */
const fakeConfigSchema: Schema<FakeConfig> = {
  parse(input: unknown) {
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

const NO_CAPS: SkillProviderCapabilities = {
  read: false,
  list: false,
  search: false,
  references: false,
};

/** A no-op provider used only to prove `create` returns a live provider. */
class FakeProvider implements SkillProvider {
  readonly capabilities = NO_CAPS;
  constructor(readonly id: string) { }
  async resolve(_ref: SkillRef): Promise<ResolvedSkill[]> {
    return [];
  }
}

/** The no-credential adapter (public origins): yields no headers. */
const noCredentials: CredentialHeadersProvider = {
  async authorize(_url: string) {
    return {};
  },
};

/** A concrete blueprint binding {@link FakeConfig} across schema, create, and provider. */
class FakeBlueprint implements ProviderBlueprint<FakeConfig> {
  readonly id = 'fake';
  readonly configSchema = fakeConfigSchema;
  create(config: FakeConfig, ctx: ProviderCreationContext): SkillProvider {
    // id derived from the admitted namespace (Req 3.5) — config kept to prove binding.
    void config;
    return new FakeProvider(`${ctx.namespace}:fake`);
  }
}

function makeCtx(namespace: string): ProviderCreationContext {
  return { namespace, trust: UNTRUSTED_DEFAULT, credentials: noCredentials };
}

// -----------------------------------------------------------------------------

describe('ProviderBlueprintRegistry — register / resolve (Req 3.2, 3.4)', () => {
  it('round-trips a registered blueprint by its factoryId (Req 3.2)', () => {
    const registry = new ProviderBlueprintRegistry();
    const blueprint = new FakeBlueprint();

    registry.register(blueprint);

    expect(registry.resolve('fake')).toBe(blueprint);
  });

  it('returns undefined for an unknown factoryId (Req 3.4 — discover quarantines)', () => {
    const registry = new ProviderBlueprintRegistry();
    registry.register(new FakeBlueprint());

    expect(registry.resolve('does-not-exist')).toBeUndefined();
  });

  it('returns undefined from an empty registry', () => {
    const registry = new ProviderBlueprintRegistry();

    expect(registry.resolve('fake')).toBeUndefined();
  });

  it('keeps independent registries isolated (no shared singleton)', () => {
    const a = new ProviderBlueprintRegistry();
    const b = new ProviderBlueprintRegistry();
    const blueprint = new FakeBlueprint();

    a.register(blueprint);

    expect(a.resolve('fake')).toBe(blueprint);
    expect(b.resolve('fake')).toBeUndefined();
  });

  it('replaces a prior blueprint when the same id is re-registered (last-wins)', () => {
    const registry = new ProviderBlueprintRegistry();
    const first = new FakeBlueprint();
    const second = new FakeBlueprint();

    registry.register(first);
    registry.register(second);

    expect(registry.resolve('fake')).toBe(second);
    expect(registry.resolve('fake')).not.toBe(first);
  });

  it('resolves the right blueprint when multiple factoryIds are registered', () => {
    const registry = new ProviderBlueprintRegistry();

    const fake = new FakeBlueprint();
    const other: ProviderBlueprint<FakeConfig> = {
      id: 'other',
      configSchema: fakeConfigSchema,
      create: (_config, ctx) => new FakeProvider(`${ctx.namespace}:other`),
    };

    registry.register(fake);
    registry.register(other);

    expect(registry.resolve('fake')).toBe(fake);
    expect(registry.resolve('other')).toBe(other);
  });
});

describe('ProviderBlueprint — TConfig binds schema → create → provider (§6)', () => {
  it('constructs a provider from a validated config, with id derived from namespace (Req 3.5)', () => {
    const blueprint = new FakeBlueprint();

    const parsed = blueprint.configSchema.parse({ url: 'https://example.com/skill.md' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected parse to succeed');

    const provider = blueprint.create(parsed.value, makeCtx('acme'));

    expect(provider.id).toBe('acme:fake');
  });

  it('a resolved blueprint validates then constructs (the discover → validate → create path)', () => {
    const registry = new ProviderBlueprintRegistry();
    registry.register(new FakeBlueprint());

    const blueprint = registry.resolve('fake');
    expect(blueprint).toBeDefined();
    if (blueprint === undefined) throw new Error('expected a blueprint');

    const parsed = blueprint.configSchema.parse({ url: 'https://example.com/x' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected parse to succeed');

    const provider = blueprint.create(parsed.value, makeCtx('widgets'));
    expect(provider.id).toBe('widgets:fake');
  });
});

describe('Schema — returned, never thrown (Req 4.1, 4.3 seam)', () => {
  it('returns ok:true with the typed value for a valid config', () => {
    const result = fakeConfigSchema.parse({ url: 'https://example.com' });

    expect(result).toEqual({ ok: true, value: { url: 'https://example.com' } });
  });

  it('returns ok:false with issues (no throw) for an invalid config', () => {
    const result = fakeConfigSchema.parse({ url: 42 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected parse to fail');
    expect(result.issues).toContain('url must be a string');
  });

  it('returns ok:false (no throw) for a non-object input', () => {
    expect(() => fakeConfigSchema.parse(null)).not.toThrow();
    expect(fakeConfigSchema.parse(null).ok).toBe(false);
  });
});
