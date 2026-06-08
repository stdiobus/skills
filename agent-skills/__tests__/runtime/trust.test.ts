/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Unit tests — trust policy layer, isolation totality, and the
// classification-promotion guard (Migration Step 7, Task 9.4; design §9;
// Req 11.3, 11.4, 11.5, 11.6).
//
// Subjects under test (already implemented — NOT redefined here):
//   - trust.ts          : resolveTrustPolicy / UNTRUSTED_DEFAULT (Req 11.1),
//                         mayPromoteClassification (Req 11.6).
//   - security/boundary : checkIsolation pure predicate (Req 11.2, 11.3).
//   - in-process-runtime: enforceIsolation (PUBLIC) — the Req 11.3 returned-never-thrown
//                         totality case, driven through createRuntimeFromRegistry, plus the
//                         path-traversal / content-size totality through the trust seam.
//
// Scope split (deliberate, to avoid duplicating Task 9.2):
//   - The PURE path/size functions (checkWithinRoot / checkContentSize) and their
//     read/readReference wiring are covered by `security/boundary.test.ts` (Task 9.2).
//     This file therefore focuses on the TRUST-POLICY semantics, the isolation totality
//     case (Req 11.3 — not covered by 9.2), and the classification-promotion guard
//     (Req 11.6). The runtime-wiring path/size cases below are framed through the trust
//     policy (untrusted-with-permittedRoot / tiny ceiling) as the Task 9.4 acceptance
//     items, and intentionally overlap minimally with boundary.test.ts.
//
// Validates: Requirements 11.3, 11.4, 11.5, 11.6
// =============================================================================

import * as path from 'path';

import { checkIsolation } from '../../runtime/security/boundary.js';
import { InProcessSkillsRuntime } from '../../runtime/in-process-runtime.js';
import { SkillProviderRegistry, createRuntimeFromRegistry } from '../../runtime/registry.js';
import {
  UNTRUSTED_DEFAULT,
  bundledTrustPolicy,
  mayPromoteClassification,
  resolveTrustPolicy,
  type TrustPolicy,
} from '../../runtime/trust.js';
import type {
  ReferenceContent,
  ResolvedSkill,
  SkillContent,
  SkillProvider,
  SkillRef,
} from '../../runtime/contract.js';

const ROOT = path.resolve('/srv/skills/provider-root');

// A trusted policy (isolation OFF) and an untrusted policy (isolation ON) for the
// pure-predicate and runtime totality cases.
const UNTRUSTED_ISOLATED: TrustPolicy = {
  tier: 'untrusted',
  maxContentBytes: 1_000,
  isolateFetch: true,
};
const TRUSTED_NO_ISOLATION: TrustPolicy = {
  tier: 'trusted',
  maxContentBytes: 10_000,
  isolateFetch: false,
};

// =============================================================================
// Test provider — instruments read/readReference so a test can prove that an
// out-of-bounds / unsatisfiable-isolation path admits NO content (never reads).
// =============================================================================

interface ProbeProvider extends SkillProvider {
  reads: number;
  refReads: number;
}

function makeProvider(id: string, body: string): ProbeProvider {
  const descriptor = {
    fqid: `${id}:alpha`,
    name: 'alpha',
    provider: id,
    source: `fake://${id}/alpha`,
  };
  const resolved: ResolvedSkill = {
    descriptor,
    providerId: id,
    providerLocalRef: '__private__',
    provenanceSeed: { source: descriptor.source },
  };
  const provider: ProbeProvider = {
    id,
    reads: 0,
    refReads: 0,
    capabilities: { read: true, list: true, search: false, references: true },
    async resolve(ref: SkillRef): Promise<ResolvedSkill[]> {
      const name =
        ref.kind === 'name' ? ref.name : ref.kind === 'fqid' ? null : ref.descriptor.name;
      return name === 'alpha' ? [resolved] : [];
    },
    async read(): Promise<SkillContent> {
      provider.reads += 1;
      return { descriptor, body };
    },
    async readReference(_r, reference): Promise<ReferenceContent> {
      provider.refReads += 1;
      return { path: reference, body };
    },
  };
  return provider;
}

// =============================================================================
// Trust policy resolution — absent → least-privileged untrusted default (Req 11.1)
// =============================================================================

describe('resolveTrustPolicy — absent seed → untrusted default (Req 11.1)', () => {
  it('resolves an absent (undefined) seed to UNTRUSTED_DEFAULT', () => {
    expect(resolveTrustPolicy(undefined)).toBe(UNTRUSTED_DEFAULT);
  });

  it('UNTRUSTED_DEFAULT is least-privileged: untrusted tier with isolation ON', () => {
    expect(UNTRUSTED_DEFAULT.tier).toBe('untrusted');
    expect(UNTRUSTED_DEFAULT.isolateFetch).toBe(true);
  });

  it('returns a supplied policy as-is (no mutation)', () => {
    const seed = bundledTrustPolicy(ROOT);
    expect(resolveTrustPolicy(seed)).toBe(seed);
  });
});

// =============================================================================
// Classification-promotion guard — untrusted not promoted without pinning (Req 11.6)
// =============================================================================

describe('mayPromoteClassification — untrusted classification not authoritative (Req 11.6)', () => {
  const trusted: TrustPolicy = TRUSTED_NO_ISOLATION;
  const untrusted: TrustPolicy = UNTRUSTED_ISOLATED;

  // Full truth table over { tier } × { pinned } × { persisted }.
  it('trusted provider: promotable in every pin/persist combination', () => {
    expect(mayPromoteClassification(trusted, { pinned: false, persisted: false })).toBe(true);
    expect(mayPromoteClassification(trusted, { pinned: true, persisted: false })).toBe(true);
    expect(mayPromoteClassification(trusted, { pinned: false, persisted: true })).toBe(true);
    expect(mayPromoteClassification(trusted, { pinned: true, persisted: true })).toBe(true);
  });

  it('untrusted provider: NOT promotable without pinning or persistence', () => {
    expect(mayPromoteClassification(untrusted, { pinned: false, persisted: false })).toBe(false);
  });

  it('untrusted provider: promotable ONLY when explicitly pinned or persisted', () => {
    expect(mayPromoteClassification(untrusted, { pinned: true, persisted: false })).toBe(true);
    expect(mayPromoteClassification(untrusted, { pinned: false, persisted: true })).toBe(true);
    expect(mayPromoteClassification(untrusted, { pinned: true, persisted: true })).toBe(true);
  });
});

// =============================================================================
// Isolation pure predicate — checkIsolation (Req 11.2, 11.3)
// =============================================================================

describe('checkIsolation — untrusted admission predicate (Req 11.2, 11.3)', () => {
  it('untrusted (isolateFetch:true) + isolation UNAVAILABLE → isolation_failed (RETURNED)', () => {
    const res = checkIsolation(UNTRUSTED_ISOLATED, { provider: 'ext', isolationAvailable: false });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('isolation_failed');
      if (res.error.code === 'isolation_failed') expect(res.error.provider).toBe('ext');
    }
  });

  it('untrusted (isolateFetch:true) + isolation AVAILABLE → admit', () => {
    const res = checkIsolation(UNTRUSTED_ISOLATED, { provider: 'ext', isolationAvailable: true });
    expect(res.ok).toBe(true);
  });

  it('trusted (isolateFetch:false) → admit regardless of isolation availability', () => {
    expect(checkIsolation(TRUSTED_NO_ISOLATION, { provider: 'b', isolationAvailable: false }).ok).toBe(true);
    expect(checkIsolation(TRUSTED_NO_ISOLATION, { provider: 'b', isolationAvailable: true }).ok).toBe(true);
  });

  it('never throws — returns a typed result for the unsatisfiable case (Req 11.3 totality)', () => {
    expect(() =>
      checkIsolation(UNTRUSTED_ISOLATED, { provider: 'ext', isolationAvailable: false }),
    ).not.toThrow();
  });
});

// =============================================================================
// Runtime isolation totality — enforceIsolation through createRuntimeFromRegistry
// (Req 11.3: the unsatisfiable case is RETURNED, never thrown; content NOT admitted)
// =============================================================================

describe('InProcessSkillsRuntime.enforceIsolation via registry seam (Req 11.3)', () => {
  it('untrusted provider + isolation unavailable → isolation_failed RETURNED, no content read', () => {
    const provider = makeProvider('ext', 'untrusted body');
    // Untrusted registration: trust OMITTED → least-privileged untrusted default
    // (isolateFetch:true) via effectiveTrustPolicy (Req 11.1).
    const registry = new SkillProviderRegistry([{ provider }]);
    const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);
    expect(runtime).toBeInstanceOf(InProcessSkillsRuntime);
    const inproc = runtime as InProcessSkillsRuntime;

    // The Req 11.3 totality case: enforceIsolation RETURNS a typed result, never throws.
    expect(() => inproc.enforceIsolation('ext', false)).not.toThrow();

    const result = inproc.enforceIsolation('ext', /* isolationAvailable */ false);
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.error.code).toBe('isolation_failed');
    }
    // Content NOT admitted: the predicate never touches the provider in this path.
    expect(provider.reads).toBe(0);
    expect(provider.refReads).toBe(0);
  });

  it('untrusted provider + isolation available → admit (null, no error)', () => {
    const provider = makeProvider('ext', 'untrusted body');
    const registry = new SkillProviderRegistry([{ provider, trust: UNTRUSTED_ISOLATED }]);
    const inproc = createRuntimeFromRegistry({ kind: 'in-process' }, registry) as InProcessSkillsRuntime;

    expect(inproc.enforceIsolation('ext', true)).toBeNull();
  });

  it('trusted provider (isolateFetch:false) → admit regardless of isolation availability', () => {
    const provider = makeProvider('bundled', 'trusted body');
    const registry = new SkillProviderRegistry([{ provider, trust: bundledTrustPolicy(ROOT) }]);
    const inproc = createRuntimeFromRegistry({ kind: 'in-process' }, registry) as InProcessSkillsRuntime;

    expect(inproc.enforceIsolation('bundled', false)).toBeNull();
    expect(inproc.enforceIsolation('bundled', true)).toBeNull();
  });
});

// =============================================================================
// Runtime path-traversal & content-size totality through the trust seam
// (Req 11.4, 11.5). The PURE checkWithinRoot/checkContentSize functions are
// covered by security/boundary.test.ts (Task 9.2); here we assert the Task 9.4
// acceptance items: a `..` path is rejected without reading, and oversize content
// is rejected as content_too_large — both as RETURNED errors via the trust policy.
// =============================================================================

describe('Runtime path/size totality via trust policy (Req 11.4, 11.5)', () => {
  it('a ".." reference path → out_of_bounds RETURNED, and readReference is NOT invoked (Req 11.4)', async () => {
    const provider = makeProvider('ext', 'body');
    // Untrusted provider WITH a permittedRoot so the path guard engages.
    const untrustedWithRoot: TrustPolicy = { ...UNTRUSTED_ISOLATED, permittedRoot: ROOT };
    const registry = new SkillProviderRegistry([{ provider, trust: untrustedWithRoot }]);
    const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

    const resp = await runtime.readReference({
      ref: { kind: 'name', name: 'alpha' },
      reference: '../../../etc/passwd',
    });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('out_of_bounds');
      if (resp.error.code === 'out_of_bounds') expect(resp.error.provider).toBe('ext');
    }
    // The out-of-bounds location was never read (content not admitted).
    expect(provider.refReads).toBe(0);
  });

  it('oversize content → content_too_large RETURNED (Req 11.5)', async () => {
    // NOTE (interim): the bundled read path materializes the body as a string and then
    // applies the byte-length check (enforceContentSize on data.body). The "not loaded in
    // full" pre-read (fs.stat number overload) is exercised by the PURE checkContentSize
    // test in security/boundary.test.ts; here we assert the RETURNED-error totality.
    const provider = makeProvider('ext', 'x'.repeat(5_000));
    const tinyCeiling: TrustPolicy = { tier: 'untrusted', maxContentBytes: 100, isolateFetch: true };
    const registry = new SkillProviderRegistry([{ provider, trust: tinyCeiling }]);
    const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

    const resp = await runtime.read({ ref: { kind: 'name', name: 'alpha' } });
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('content_too_large');
      if (resp.error.code === 'content_too_large') expect(resp.error.limitBytes).toBe(100);
    }
  });
});
