/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Adapter error-rendering unit tests (Migration Step 3 — design §1, §6).
//
// Subject: the pure error-rendering helpers in `lib/tool-render.ts`, which the
// delegate-only MCP adapter uses to translate EVERY typed `SkillRuntimeError`
// returned by the runtime into the MCP tool-result shape (`isError: true`).
//
// These helpers are the adapter's total mapping from the typed error union to a
// human-facing diagnostic line. The staged-provenance suite already covers the
// SUCCESS paths and the `not_found` error; this suite pins the rendering of
// EVERY remaining error code and EVERY `SkillRef` kind so the adapter never
// emits an empty/undefined diagnostic for a typed runtime error.
//
// Validates: Requirements 9.1, 9.2, 9.4, 9.6
// =============================================================================

import { describeError, renderError } from '../../lib/tool-render.js';
import type { SkillDescriptor, SkillRef, SkillRuntimeError } from '../../runtime/contract.js';

const descriptor: SkillDescriptor = {
  fqid: 'bundled:runtime-concepts',
  name: 'runtime-concepts',
  provider: 'bundled',
  source: 'file:///skills/runtime-concepts/SKILL.md',
};

// All three SkillRef kinds, so refLabel() is exercised on every arm.
const nameRef: SkillRef = { kind: 'name', name: 'runtime-concepts' };
const fqidRef: SkillRef = { kind: 'fqid', fqid: 'bundled:runtime-concepts' };
const descriptorRef: SkillRef = { kind: 'descriptor', descriptor };

describe('describeError: every typed error code renders a non-empty diagnostic', () => {
  it('not_found names the unresolved ref', () => {
    const line = describeError({ code: 'not_found', ref: nameRef });
    expect(line).toContain('not found');
    expect(line).toContain('runtime-concepts');
  });

  it('ambiguous reports the candidate count', () => {
    const error: SkillRuntimeError = {
      code: 'ambiguous',
      ref: nameRef,
      candidates: [descriptor, { ...descriptor, provider: 'mirror', fqid: 'mirror:runtime-concepts' }],
    };
    const line = describeError(error);
    expect(line).toContain('ambiguous');
    expect(line).toContain('2 candidates');
  });

  it('unsupported WITH a provider names both the capability and the provider', () => {
    const line = describeError({ code: 'unsupported', capability: 'search', provider: 'bundled' });
    expect(line).toContain('search');
    expect(line).toContain('bundled');
  });

  it('unsupported WITHOUT a provider names only the capability', () => {
    const line = describeError({ code: 'unsupported', capability: 'search' });
    expect(line).toContain('search');
    expect(line).not.toContain('provider "');
  });

  it('provider_error surfaces the provider message verbatim', () => {
    const line = describeError({ code: 'provider_error', provider: 'bundled', message: 'disk read failed' });
    expect(line).toBe('disk read failed');
  });

  it('bad_request joins the issue list', () => {
    const line = describeError({ code: 'bad_request', issues: ['ref.name: Required', 'limit: too large'] });
    expect(line).toContain('ref.name: Required');
    expect(line).toContain('limit: too large');
  });

  it('out_of_bounds surfaces the detail', () => {
    const line = describeError({ code: 'out_of_bounds', provider: 'fs', detail: 'path escapes permitted root' });
    expect(line).toContain('path escapes permitted root');
  });

  it('content_too_large names the byte limit', () => {
    const line = describeError({ code: 'content_too_large', provider: 'fs', limitBytes: 1048576 });
    expect(line).toContain('1048576');
  });

  it('isolation_failed surfaces the reason', () => {
    const line = describeError({ code: 'isolation_failed', provider: 'remote', reason: 'sandbox unavailable' });
    expect(line).toContain('sandbox unavailable');
  });

  it('aggregate_error renders each nested failure with its provider', () => {
    const error: SkillRuntimeError = {
      code: 'aggregate_error',
      failures: [
        { provider: 'p1', error: { code: 'not_found', ref: nameRef } },
        { provider: 'p2', error: { code: 'provider_error', provider: 'p2', message: 'boom' } },
      ],
    };
    const line = describeError(error);
    expect(line).toContain('p1:');
    expect(line).toContain('p2:');
    expect(line).toContain('boom');
  });
});

describe('describeError: refLabel renders every SkillRef kind', () => {
  it('labels a name ref', () => {
    expect(describeError({ code: 'not_found', ref: nameRef })).toContain('"runtime-concepts"');
  });

  it('labels an fqid ref', () => {
    expect(describeError({ code: 'not_found', ref: fqidRef })).toContain('"bundled:runtime-concepts"');
  });

  it('labels a descriptor ref by its name', () => {
    expect(describeError({ code: 'not_found', ref: descriptorRef })).toContain('"runtime-concepts"');
  });
});

describe('renderError: wraps the diagnostic as an MCP tool error', () => {
  it('prefixes the tool name and sets isError', () => {
    const result = renderError('read_skill', { code: 'not_found', ref: nameRef });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text.startsWith('read_skill: ')).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });
});
