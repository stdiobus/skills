/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Unit tests — operator origin allowlist (Milestone-002, Task 13.2;
// design §"Components" 8; Req 16.5).
//
// Subjects under test:
//   - runtime/admission/origin-allowlist.ts
//       OriginAllowlist            unset → permit-all default; set → HTTPS-origins-only
//       OriginAllowlist.fromEnv    sourced from STDIOBUS_SKILLS_ORIGIN_ALLOWLIST
//   - runtime/providers/http-skill-provider.ts
//       withOriginAllowlist        additive schema guard; unset → base by reference
//       HttpSkillProviderBlueprint optional allowlist arg composes the configSchema
//
// Behavior verified (Req 16.5):
//   - UNSET allowlist permits public HTTPS (the documented default), schema unchanged
//   - SET allowlist permits only listed HTTPS origins, blocks every other origin
//   - a non-allowlisted origin is quarantined at the admission `validate` stage
//     (typed bad_request) BEFORE any fetch — never conceals the tool, only restricts origins
//
// Validates: Requirements 16.5
// =============================================================================

import { AdmissionController } from '../../../runtime/admission/admission-controller.js';
import { ProviderBlueprintRegistry } from '../../../runtime/admission/blueprint-registry.js';
import { Sha256ContentHasher } from '../../../runtime/admission/content-hasher.js';
import { NamespaceOwnershipTable } from '../../../runtime/admission/namespace-ownership.js';
import { OperationBudget } from '../../../runtime/admission/operation-budget.js';
import {
  ORIGIN_ALLOWLIST_ENV,
  OriginAllowlist,
} from '../../../runtime/admission/origin-allowlist.js';
import type { ProviderDescriptor } from '../../../runtime/admission/provider-descriptor.js';
import {
  HttpSkillProviderBlueprint,
  httpProviderConfigSchema,
  withOriginAllowlist,
} from '../../../runtime/providers/http-skill-provider.js';
import { MutableProviderView } from '../../../runtime/registry.js';
import { UNTRUSTED_DEFAULT } from '../../../runtime/trust.js';

const ALLOWED_ORIGIN = 'https://raw.githubusercontent.com';
const ALLOWED_URL = 'https://raw.githubusercontent.com/git/git/v2.43.0/COPYING';
const OTHER_URL = 'https://evil.example.com/skill.md';

// -----------------------------------------------------------------------------
// OriginAllowlist — unset (default) vs set (Req 16.5)
// -----------------------------------------------------------------------------

describe('OriginAllowlist — permit-all default vs operator restriction (Req 16.5)', () => {
  it('UNSET (unrestricted) permits every URL and is not configured', () => {
    const allowlist = OriginAllowlist.unrestricted();
    expect(allowlist.isConfigured).toBe(false);
    expect(allowlist.permits(ALLOWED_URL)).toBe(true);
    expect(allowlist.permits(OTHER_URL)).toBe(true);
    expect(allowlist.permittedOrigins()).toEqual([]);
  });

  it('SET permits only listed HTTPS origins and blocks every other origin', () => {
    const allowlist = OriginAllowlist.fromOrigins([ALLOWED_ORIGIN]);
    expect(allowlist.isConfigured).toBe(true);
    expect(allowlist.permits(ALLOWED_URL)).toBe(true); // matches on origin, any path
    expect(allowlist.permits(OTHER_URL)).toBe(false);
  });

  it('decides membership on the origin (scheme+host+port), not the full path', () => {
    const allowlist = OriginAllowlist.fromOrigins([ALLOWED_ORIGIN]);
    expect(allowlist.permits('https://raw.githubusercontent.com/a/b/c')).toBe(true);
    expect(allowlist.permits('https://raw.githubusercontent.com:8443/a')).toBe(false); // different port
  });

  it('normalises case/host so an allowlist entry matches regardless of casing', () => {
    const allowlist = OriginAllowlist.fromOrigins(['https://Raw.GitHubUserContent.com']);
    expect(allowlist.permits('https://raw.githubusercontent.com/x')).toBe(true);
  });

  it('a configured allowlist blocks a non-HTTPS URL (HTTPS origins only)', () => {
    const allowlist = OriginAllowlist.fromOrigins([ALLOWED_ORIGIN]);
    expect(allowlist.permits('http://raw.githubusercontent.com/x')).toBe(false);
  });

  it('drops non-HTTPS / unparseable entries; an all-invalid list collapses to unrestricted', () => {
    const allowlist = OriginAllowlist.fromOrigins(['http://insecure.example.com', 'not a url', '']);
    expect(allowlist.isConfigured).toBe(false);
    expect(allowlist.permits(OTHER_URL)).toBe(true);
  });

  it('keeps only the valid HTTPS origins from a mixed list', () => {
    const allowlist = OriginAllowlist.fromOrigins([ALLOWED_ORIGIN, 'http://insecure.example.com']);
    expect(allowlist.isConfigured).toBe(true);
    expect(allowlist.permittedOrigins()).toEqual([ALLOWED_ORIGIN]);
  });
});

// -----------------------------------------------------------------------------
// OriginAllowlist.fromEnv — deployment sourcing (Req 16.5)
// -----------------------------------------------------------------------------

describe('OriginAllowlist.fromEnv — sourced from the environment (Req 16.5)', () => {
  it('an unset env var yields the unrestricted default', () => {
    const allowlist = OriginAllowlist.fromEnv({});
    expect(allowlist.isConfigured).toBe(false);
    expect(allowlist.permits(OTHER_URL)).toBe(true);
  });

  it('a set env var configures the allowlist, split on commas and whitespace', () => {
    const allowlist = OriginAllowlist.fromEnv({
      [ORIGIN_ALLOWLIST_ENV]: `${ALLOWED_ORIGIN}, https://example.com`,
    });
    expect(allowlist.isConfigured).toBe(true);
    expect(allowlist.permits(ALLOWED_URL)).toBe(true);
    expect(allowlist.permits('https://example.com/s')).toBe(true);
    expect(allowlist.permits(OTHER_URL)).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// withOriginAllowlist — additive schema composition (Req 16.5)
// -----------------------------------------------------------------------------

describe('withOriginAllowlist — additive guard over the HTTPS schema (Req 16.5)', () => {
  const validConfig = (url: string) => ({ url, maxContentBytes: 1_000, timeoutMs: 1_000 });

  it('UNSET allowlist returns the base schema BY REFERENCE (no behaviour change)', () => {
    const composed = withOriginAllowlist(httpProviderConfigSchema, OriginAllowlist.unrestricted());
    expect(composed).toBe(httpProviderConfigSchema);
  });

  it('SET allowlist permits a listed origin (config still validates to TConfig)', () => {
    const composed = withOriginAllowlist(
      httpProviderConfigSchema,
      OriginAllowlist.fromOrigins([ALLOWED_ORIGIN]),
    );
    const result = composed.parse(validConfig(ALLOWED_URL));
    expect(result.ok).toBe(true);
  });

  it('SET allowlist rejects a non-listed origin with a typed issue (→ bad_request)', () => {
    const composed = withOriginAllowlist(
      httpProviderConfigSchema,
      OriginAllowlist.fromOrigins([ALLOWED_ORIGIN]),
    );
    const result = composed.parse(validConfig(OTHER_URL));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected parse to fail');
    expect(result.issues.some((i) => i.includes('operator origin allowlist'))).toBe(true);
  });

  it('preserves the base rejections (non-HTTPS, unknown key) before the allowlist runs', () => {
    const composed = withOriginAllowlist(
      httpProviderConfigSchema,
      OriginAllowlist.fromOrigins([ALLOWED_ORIGIN]),
    );
    // Non-HTTPS: base schema rejects on scheme, not the allowlist message.
    const nonHttps = composed.parse(validConfig('http://raw.githubusercontent.com/x'));
    expect(nonHttps.ok).toBe(false);
    if (nonHttps.ok) throw new Error('expected parse to fail');
    expect(nonHttps.issues.some((i) => i.includes('https:'))).toBe(true);

    // Unknown key: still rejected by the base schema.
    const unknownKey = composed.parse({ ...validConfig(ALLOWED_URL), caCert: 'x' });
    expect(unknownKey.ok).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// HttpSkillProviderBlueprint — optional allowlist composes the configSchema (Req 16.5)
// -----------------------------------------------------------------------------

describe('HttpSkillProviderBlueprint — allowlist composition (Req 16.5)', () => {
  it('no allowlist arg keeps the default schema by reference (backward compatible)', () => {
    const blueprint = new HttpSkillProviderBlueprint();
    expect(blueprint.configSchema).toBe(httpProviderConfigSchema);
  });

  it('a configured allowlist installs the composed guard on configSchema', () => {
    const blueprint = new HttpSkillProviderBlueprint(OriginAllowlist.fromOrigins([ALLOWED_ORIGIN]));
    expect(blueprint.configSchema).not.toBe(httpProviderConfigSchema);
    expect(blueprint.configSchema.parse({ url: OTHER_URL, maxContentBytes: 1, timeoutMs: 1 }).ok).toBe(
      false,
    );
  });
});

// -----------------------------------------------------------------------------
// AdmissionController integration — quarantine at validate BEFORE any fetch (Req 16.5)
// -----------------------------------------------------------------------------

function makeDescriptor(url: string): ProviderDescriptor {
  return {
    factoryId: 'http',
    config: { url, maxContentBytes: 1_000_000, timeoutMs: 5_000 },
    namespace: 'acme',
    trust: UNTRUSTED_DEFAULT,
    capabilityVersions: {},
  };
}

function makeController(allowlist: OriginAllowlist): {
  controller: AdmissionController;
  view: MutableProviderView;
} {
  const blueprints = new ProviderBlueprintRegistry();
  blueprints.register(new HttpSkillProviderBlueprint(allowlist));
  const view = new MutableProviderView();
  const controller = new AdmissionController(
    blueprints,
    view,
    new NamespaceOwnershipTable(),
    new OperationBudget(5_000),
    new Sha256ContentHasher(),
  );
  return { controller, view };
}

describe('AdmissionController — origin allowlist quarantines at validate before fetch (Req 16.5)', () => {
  it('a non-allowlisted HTTPS origin quarantines at stage "validate" (no fetch, registry unchanged)', async () => {
    // No network: the validate stage rejects BEFORE acquire, so this runs fully offline.
    const { controller, view } = makeController(OriginAllowlist.fromOrigins([ALLOWED_ORIGIN]));

    const outcome = await controller.admit(makeDescriptor(OTHER_URL));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected quarantine');
    expect(outcome.stage).toBe('validate');
    expect(outcome.error.code).toBe('bad_request');
    expect(view.providers()).toHaveLength(0);
  });

  it('an UNSET allowlist does not reject at validate — the default permits public HTTPS', async () => {
    // With the unrestricted default the validate stage accepts the config; we assert the
    // pipeline does NOT short-circuit at validate (it proceeds past it). We avoid a live fetch
    // by pointing at an unroutable host so acquire fails LATER — proving validate let it through.
    const { controller } = makeController(OriginAllowlist.unrestricted());

    const outcome = await controller.admit(
      makeDescriptor('https://127.0.0.1:1/never'),
    );

    // The default permitted the origin at validate; any failure is at a LATER stage, not validate.
    if (!outcome.ok) {
      expect(outcome.stage).not.toBe('validate');
    }
  }, 15_000);
});
