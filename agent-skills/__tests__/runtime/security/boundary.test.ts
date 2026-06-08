/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Unit tests — security boundary path-traversal & content-size guards
// (Migration Step 7, Task 9.2; design §9; Req 11.4, 11.5).
//
// Subjects under test (already implemented — NOT redefined here):
//   - checkWithinRoot / checkContentSize        (runtime/security/boundary.ts)
//   - their wiring into InProcessSkillsRuntime via the optional TrustLookup,
//     reached through the registry → factory seam (createRuntimeFromRegistry).
//
// Invariants validated:
//   1. A path containing `..` OR resolving outside the permitted root is rejected
//      as `out_of_bounds` (RETURNED, never thrown) and the location is not read.
//   2. Content whose byte length exceeds `maxContentBytes` is rejected as
//      `content_too_large` (RETURNED, never thrown).
//   3. Both guards surface as RETURNED SkillResponse errors at the runtime
//      boundary — a provider is never invoked for an out-of-bounds reference, and
//      no exception ever crosses the contract boundary.
//
// Comprehensive trust-policy and property-based coverage live in Tasks 9.4 / 9.5;
// this file focuses on the boundary module itself and its returned-error wiring.
//
// Validates: Requirements 11.4, 11.5
// =============================================================================

import * as path from 'path';

import { checkContentSize, checkWithinRoot } from '../../../runtime/security/boundary.js';
import { SkillProviderRegistry, createRuntimeFromRegistry } from '../../../runtime/registry.js';
import { bundledTrustPolicy } from '../../../runtime/trust.js';
import type {
  ReferenceContent,
  ResolvedSkill,
  SkillContent,
  SkillProvider,
  SkillRef,
} from '../../../runtime/contract.js';

const ROOT = path.resolve('/srv/skills/provider-root');

// =============================================================================
// Pure function — checkWithinRoot (Req 11.4)
// =============================================================================

describe('checkWithinRoot — path-traversal containment (Req 11.4)', () => {
  it('admits a relative path nested under the permitted root', () => {
    const res = checkWithinRoot(ROOT, 'templates/worker.ts', 'p');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved).toBe(path.join(ROOT, 'templates/worker.ts'));
  });

  it('admits the permitted root itself', () => {
    const res = checkWithinRoot(ROOT, '.', 'p');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved).toBe(ROOT);
  });

  it('rejects a path containing a ".." traversal segment as out_of_bounds', () => {
    const res = checkWithinRoot(ROOT, '../../etc/passwd', 'p');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('out_of_bounds');
      if (res.error.code === 'out_of_bounds') expect(res.error.provider).toBe('p');
    }
  });

  it('rejects an absolute path outside the root as out_of_bounds', () => {
    const res = checkWithinRoot(ROOT, '/etc/passwd', 'p');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('out_of_bounds');
  });

  it('rejects a sibling-prefix path that is not actually nested', () => {
    // `${ROOT}-evil` shares the string prefix but is NOT under `${ROOT}${sep}`.
    const res = checkWithinRoot(ROOT, path.resolve(`${ROOT}-evil/secret`), 'p');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('out_of_bounds');
  });
});

// =============================================================================
// Pure function — checkContentSize (Req 11.5)
// =============================================================================

describe('checkContentSize — content-size limit (Req 11.5)', () => {
  it('admits content within the limit', () => {
    expect(checkContentSize('hello', 10, 'p').ok).toBe(true);
  });

  it('admits content exactly at the limit (boundary)', () => {
    expect(checkContentSize('12345', 5, 'p').ok).toBe(true);
  });

  it('rejects content one byte over the limit as content_too_large', () => {
    const res = checkContentSize('123456', 5, 'p');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('content_too_large');
      if (res.error.code === 'content_too_large') {
        expect(res.error.limitBytes).toBe(5);
        expect(res.error.provider).toBe('p');
      }
    }
  });

  it('measures multi-byte UTF-8 by byte length, not character count', () => {
    // '€' is 3 UTF-8 bytes; a single char exceeds a 2-byte limit.
    const res = checkContentSize('€', 2, 'p');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('content_too_large');
  });

  it('accepts a pre-computed byte count (the "not loaded in full" path)', () => {
    // A size from fs.stat would be passed as a number, rejecting without materializing.
    const res = checkContentSize(10_000, 1_000, 'p');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('content_too_large');
  });
});

// =============================================================================
// Runtime wiring — returned (never thrown) enforcement through the registry seam
// =============================================================================

/**
 * Minimal real provider whose `readReference` records whether it was invoked, so the
 * test can prove an out-of-bounds reference is rejected WITHOUT reading the location.
 */
function makeProvider(
  id: string,
  body: string,
  onReadReference: () => void,
): SkillProvider {
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
  return {
    id,
    capabilities: { read: true, list: true, search: false, references: true },
    async resolve(ref: SkillRef): Promise<ResolvedSkill[]> {
      const name =
        ref.kind === 'name' ? ref.name : ref.kind === 'fqid' ? null : ref.descriptor.name;
      return name === 'alpha' ? [resolved] : [];
    },
    async read(): Promise<SkillContent> {
      return { descriptor, body };
    },
    async readReference(_r, reference): Promise<ReferenceContent> {
      onReadReference();
      return { path: reference, body };
    },
  };
}

describe('InProcessSkillsRuntime security boundary via registry seam (Req 11.4, 11.5)', () => {
  it('rejects an out-of-bounds reference as out_of_bounds WITHOUT reading it (Req 11.4)', async () => {
    let read = false;
    const provider = makeProvider('bundled', 'body', () => {
      read = true;
    });
    const registry = new SkillProviderRegistry([
      { provider, trust: bundledTrustPolicy(ROOT) },
    ]);
    const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

    const resp = await runtime.readReference({
      ref: { kind: 'name', name: 'alpha' },
      reference: '../../../etc/passwd',
    });

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('out_of_bounds');
    // The out-of-bounds location was never read.
    expect(read).toBe(false);
  });

  it('rejects oversize content as content_too_large, returned never thrown (Req 11.5)', async () => {
    const big = 'x'.repeat(2_000);
    const provider = makeProvider('bundled', big, () => undefined);
    // A trust policy with a tiny ceiling makes the body oversize.
    const registry = new SkillProviderRegistry([
      { provider, trust: { tier: 'trusted', maxContentBytes: 100, isolateFetch: false, permittedRoot: ROOT } },
    ]);
    const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

    const resp = await runtime.read({ ref: { kind: 'name', name: 'alpha' } });
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('content_too_large');
      if (resp.error.code === 'content_too_large') expect(resp.error.limitBytes).toBe(100);
    }
  });

  it('admits an in-bounds reference within the size limit (happy path preserved)', async () => {
    let read = false;
    const provider = makeProvider('bundled', 'small body', () => {
      read = true;
    });
    const registry = new SkillProviderRegistry([
      { provider, trust: bundledTrustPolicy(ROOT) },
    ]);
    const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

    const resp = await runtime.readReference({
      ref: { kind: 'name', name: 'alpha' },
      reference: 'notes.md',
    });

    expect(resp.ok).toBe(true);
    if (resp.ok) expect(resp.data.body).toBe('small body');
    expect(read).toBe(true);
  });
});
