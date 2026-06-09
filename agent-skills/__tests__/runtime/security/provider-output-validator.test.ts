/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Unit tests — ProviderOutputValidator
// (Milestone-002, Task 6 — T26-minimum; design §"Components" 6; Req 6.1, 6.2, 6.3, 5.4, 5.5).
//
// Subject under test:
//   - runtime/security/provider-output-validator.ts
//       validateDescriptor(producingProviderId, descriptor)
//       validateDescriptors(producingProviderId, descriptors)
//       validateContentSize(producingProviderId, content)
//
// Behavior verified (the pure validator, in isolation from the runtime):
//   - metadata shape: a non-object descriptor is rejected up front (Req 6.1, 6.2)
//   - identity: delegates to guardDescriptorIdentity (missing fields / oversized FQID)
//   - namespace anti-spoofing: an out-of-namespace FQID is rejected on the CHILD id,
//     only for providers that own a namespace; the reserved `bundled` / non-admitted
//     providers are EXEMPT (Req 5.4, 5.5)
//   - content size: delegates to checkContentSize against the provider's policy (Req 6.1)
//   - backward-compatible seams: no namespace table → namespace check inert; no trust
//     lookup → size check inert (baseline behavior, Req 15.2)
//
// Validates: Requirements 6.1, 6.2, 6.3, 5.4, 5.5
// =============================================================================

import { ProviderOutputValidator } from '../../../runtime/security/provider-output-validator.js';
import { NamespaceOwnershipTable } from '../../../runtime/admission/namespace-ownership.js';
import { FQID_MAX_BYTES } from '../../../runtime/fqid.js';
import { UNTRUSTED_DEFAULT, type TrustPolicy } from '../../../runtime/trust.js';
import type { SkillDescriptor } from '../../../runtime/contract.js';

const desc = (provider: string, name: string, fqid = `${provider}:${name}`): SkillDescriptor => ({
  fqid,
  name,
  provider,
  source: `mem://${provider}/${name}`,
});

describe('ProviderOutputValidator — metadata shape (Req 6.1, 6.2)', () => {
  it('rejects a null descriptor with bad_request before reading any field', () => {
    const v = new ProviderOutputValidator();
    const err = v.validateDescriptor('p', null as unknown as SkillDescriptor);
    expect(err?.code).toBe('bad_request');
  });

  it('rejects a non-object descriptor with bad_request', () => {
    const v = new ProviderOutputValidator();
    const err = v.validateDescriptor('p', 'not-a-descriptor' as unknown as SkillDescriptor);
    expect(err?.code).toBe('bad_request');
  });
});

describe('ProviderOutputValidator — identity (reuses guardDescriptorIdentity)', () => {
  const v = new ProviderOutputValidator();

  it('accepts a valid, consistent descriptor (returns null)', () => {
    expect(v.validateDescriptor('ext', desc('ext', 'alpha'))).toBeNull();
  });

  it('rejects a descriptor missing provider with bad_request', () => {
    const d = { fqid: ':alpha', name: 'alpha', provider: '', source: 's' } as SkillDescriptor;
    expect(v.validateDescriptor('ext', d)?.code).toBe('bad_request');
  });

  it('rejects a descriptor with an empty fqid with bad_request', () => {
    const d = { fqid: '', name: 'alpha', provider: 'ext', source: 's' } as SkillDescriptor;
    expect(v.validateDescriptor('ext', d)?.code).toBe('bad_request');
  });

  it('rejects an oversized declared FQID with bad_request', () => {
    const d = desc('ext', 'alpha', `ext:${'a'.repeat(FQID_MAX_BYTES + 16)}`);
    expect(v.validateDescriptor('ext', d)?.code).toBe('bad_request');
  });
});

describe('ProviderOutputValidator — namespace anti-spoofing (Req 5.4, 5.5)', () => {
  function tableOwning(namespace: string, providerId: string): NamespaceOwnershipTable {
    const table = new NamespaceOwnershipTable();
    expect(table.claim(namespace, providerId).ok).toBe(true);
    return table;
  }

  it('admits an in-namespace FQID for the owning provider', () => {
    const v = new ProviderOutputValidator(tableOwning('acme', 'acme'));
    expect(v.validateDescriptor('acme', desc('acme', 'widget'))).toBeNull();
  });

  it('rejects an out-of-namespace FQID for the owning provider (Req 5.4)', () => {
    const v = new ProviderOutputValidator(tableOwning('acme', 'acme'));
    const err = v.validateDescriptor('acme', desc('acme', 'widget', 'evil:widget'));
    expect(err?.code).toBe('bad_request');
  });

  it("rejects an FQID spoofing the reserved `bundled` prefix (Req 5.3, 5.4)", () => {
    const v = new ProviderOutputValidator(tableOwning('acme', 'acme'));
    const err = v.validateDescriptor('acme', desc('acme', 'core', 'bundled:core'));
    expect(err?.code).toBe('bad_request');
  });

  it("rejects an FQID under another provider's owned namespace, keyed on the child id (Req 5.5)", () => {
    const table = tableOwning('acme', 'acme');
    expect(table.claim('globex', 'globex').ok).toBe(true);
    const v = new ProviderOutputValidator(table);
    // acme cannot launder a globex-prefixed FQID even though globex is a real owner.
    const err = v.validateDescriptor('acme', desc('acme', 'widget', 'globex:widget'));
    expect(err?.code).toBe('bad_request');
    // globex itself can mint under its own namespace.
    expect(v.validateDescriptor('globex', desc('globex', 'widget'))).toBeNull();
  });

  it('EXEMPTS a provider that owns no namespace (e.g. bundled / non-admitted) — Req 5.4 gate', () => {
    // A table that owns `acme` is wired, but provider `bundled` owns nothing → exempt, so its
    // `bundled:*` FQID is admitted even though `bundled` is not in the table. This is the
    // backward-compat seam that keeps the bundled baseline unchanged in a federated runtime.
    const v = new ProviderOutputValidator(tableOwning('acme', 'acme'));
    expect(v.validateDescriptor('bundled', desc('bundled', 'core-skill'))).toBeNull();
  });

  it('namespace check is INERT when no ownership table is wired (baseline)', () => {
    const v = new ProviderOutputValidator();
    // Without a table, an out-of-namespace-looking FQID is admitted (identity-only boundary).
    expect(v.validateDescriptor('acme', desc('acme', 'widget', 'evil:widget'))).toBeNull();
  });
});

describe('ProviderOutputValidator — content size (reuses checkContentSize)', () => {
  const smallPolicy: TrustPolicy = { tier: 'untrusted', maxContentBytes: 8, isolateFetch: true };
  const trustOf = (id: string): TrustPolicy | undefined => (id === 'acme' ? smallPolicy : undefined);

  it('rejects content over maxContentBytes with content_too_large', () => {
    const v = new ProviderOutputValidator(undefined, trustOf);
    const err = v.validateContentSize('acme', 'x'.repeat(64));
    expect(err?.code).toBe('content_too_large');
  });

  it('admits content within maxContentBytes', () => {
    const v = new ProviderOutputValidator(undefined, trustOf);
    expect(v.validateContentSize('acme', 'tiny')).toBeNull();
  });

  it('accepts a pre-computed byte count (not-loaded-in-full path)', () => {
    const v = new ProviderOutputValidator(undefined, trustOf);
    expect(v.validateContentSize('acme', 999)?.code).toBe('content_too_large');
    expect(v.validateContentSize('acme', 4)).toBeNull();
  });

  it('size check is INERT when no trust lookup is wired (baseline)', () => {
    const v = new ProviderOutputValidator();
    expect(v.validateContentSize('acme', 'x'.repeat(10_000))).toBeNull();
  });

  it('size check is INERT for a provider with no policy', () => {
    const v = new ProviderOutputValidator(undefined, () => UNTRUSTED_DEFAULT);
    // UNTRUSTED_DEFAULT allows ~1MB; a modest body is admitted.
    expect(v.validateContentSize('any', 'x'.repeat(1000))).toBeNull();
  });
});

describe('ProviderOutputValidator — validateDescriptors batch (Req 6.2)', () => {
  it('returns the FIRST disqualifying error and null when all are valid', () => {
    const v = new ProviderOutputValidator(new NamespaceOwnershipTable());
    const all = [desc('ext', 'a'), desc('ext', 'b'), desc('ext', 'c')];
    expect(v.validateDescriptors('ext', all)).toBeNull();

    const bad = { fqid: '', name: 'x', provider: 'ext', source: 's' } as SkillDescriptor;
    const mixed = [desc('ext', 'a'), bad, desc('ext', 'c')];
    expect(v.validateDescriptors('ext', mixed)?.code).toBe('bad_request');
  });
});
