/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Staged Provenance Exposure Tests
// Feature: federated-skills-runtime — Task 11.1 (Migration Step 9)
//
// Purpose: prove the OPT-IN, DECLARED, VERSIONED provenance exposure behaves as
//          a staged change:
//
//   - DEFAULT (flag OFF): the render helpers produce output BYTE-IDENTICAL to
//     the compatibility phase. `read_skill`/`read_reference` render the raw body;
//     `list_references` renders a plain JSON string array. NO provenance tokens
//     appear anywhere in the rendered output (Req 9.7).
//   - OPT-IN (flag ON): the runtime-backed body/reference tools produce the
//     declared `provenance.v1` staged shape that ADDS provenance alongside the
//     existing content (Req 9.9). The exact declared shape/version is asserted.
//
// The helpers are pure (no process spawn) and are driven by a REAL runtime wired
// EXACTLY as the adapter wires it: the bundled FilesystemSkillProvider over the
// real FileResolver, through the in-process runtime. No mocking — published
// content is read from disk, so the default-off path is checked byte-for-byte.
//
// Validates: Requirements 9.7, 9.9
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';

import { createFileResolver } from '../../lib/file-resolver.js';
import { FilesystemSkillProvider } from '../../runtime/providers/filesystem-provider.js';
import { SkillProviderRegistry, createRuntimeFromRegistry } from '../../runtime/registry.js';
import { bundledTrustPolicy } from '../../runtime/trust.js';
import {
  COMPAT_RENDER_OPTIONS,
  EXPOSE_PROVENANCE_ENV,
  PROVENANCE_SHAPE_VERSION,
  renderListReferences,
  renderReadReference,
  renderReadSkill,
  resolveExposeProvenance,
  type AdapterRenderOptions,
} from '../../lib/tool-render.js';
import type { SkillsRuntime } from '../../runtime/contract.js';

// Repo root: .../agent-skills/__tests__/mcp-server -> up 3 levels.
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..');
const AGENT_SKILLS_DIR = path.join(PACKAGE_ROOT, 'agent-skills');

/** A published skill used for byte-for-byte and provenance assertions. */
const PUBLISHED_SKILL = 'runtime-concepts';
/** A reference known to exist for the published skill. */
const PUBLISHED_REFERENCE = 'domain-model.md';

/** Provenance envelope keys that must NEVER appear in compatibility-phase output. */
const PROVENANCE_TOKENS = [
  'provenance',
  'resolvedFrom',
  'aggregateDiagnostics',
  'provenanceSeed',
  PROVENANCE_SHAPE_VERSION,
];

const ON: AdapterRenderOptions = { exposeProvenance: true };

/** Wire the runtime EXACTLY as the bundled adapter does. */
function makeBundledRuntime(): SkillsRuntime {
  const resolver = createFileResolver();
  const provider = new FilesystemSkillProvider();
  const registry = new SkillProviderRegistry([
    { provider, trust: bundledTrustPolicy(resolver.packageRoot) },
  ]);
  return createRuntimeFromRegistry({ kind: 'in-process' }, registry);
}

const runtime = makeBundledRuntime();

// =============================================================================
// PART A — Declared flag plumbing (resolveExposeProvenance / version marker)
// =============================================================================

describe('staged provenance: declared opt-in flag (Req 9.9)', () => {
  it('declares the versioned staged shape as "provenance.v1"', () => {
    expect(PROVENANCE_SHAPE_VERSION).toBe('provenance.v1');
  });

  it('declares the opt-in env var name', () => {
    expect(EXPOSE_PROVENANCE_ENV).toBe('STDIOBUS_SKILLS_EXPOSE_PROVENANCE');
  });

  it('defaults OFF when the env var is unset (Req 9.7)', () => {
    expect(resolveExposeProvenance({})).toBe(false);
    expect(COMPAT_RENDER_OPTIONS.exposeProvenance).toBe(false);
  });

  it('enables ONLY for the exact strings "1" and "true"', () => {
    expect(resolveExposeProvenance({ [EXPOSE_PROVENANCE_ENV]: '1' })).toBe(true);
    expect(resolveExposeProvenance({ [EXPOSE_PROVENANCE_ENV]: 'true' })).toBe(true);
  });

  it('stays OFF for any other value (no implicit enable)', () => {
    for (const v of ['0', 'false', 'yes', 'TRUE', 'on', '']) {
      expect(resolveExposeProvenance({ [EXPOSE_PROVENANCE_ENV]: v })).toBe(false);
    }
  });
});

// =============================================================================
// PART B — DEFAULT (flag OFF): byte-identical compatibility output, no provenance
// =============================================================================

describe('staged provenance OFF: output byte-identical to compatibility phase (Req 9.7)', () => {
  it('read_skill renders the raw SKILL.md body byte-for-byte, with NO provenance', async () => {
    const resp = await runtime.read({ ref: { kind: 'name', name: PUBLISHED_SKILL } });
    expect(resp.ok).toBe(true);

    const onDisk = fs.readFileSync(
      path.join(AGENT_SKILLS_DIR, PUBLISHED_SKILL, 'SKILL.md'),
      'utf-8',
    );

    // Default (no opts) and explicit-off must be identical and equal to raw body.
    const def = renderReadSkill(resp);
    const off = renderReadSkill(resp, COMPAT_RENDER_OPTIONS);
    expect(def).toEqual(off);
    expect(def.isError).toBeFalsy();
    expect(def.content[0].text).toBe(onDisk);

    const asJson = JSON.stringify(def);
    for (const token of PROVENANCE_TOKENS) {
      expect(asJson).not.toContain(token);
    }
  });

  it('list_references renders a plain JSON string array, with NO provenance', async () => {
    const resp = await runtime.getReferences({ ref: { kind: 'name', name: PUBLISHED_SKILL } });
    expect(resp.ok).toBe(true);

    const rendered = renderListReferences(resp);
    expect(rendered.isError).toBeFalsy();

    const parsed = JSON.parse(rendered.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    for (const el of parsed) {
      expect(typeof el).toBe('string');
    }

    const asJson = JSON.stringify(rendered);
    for (const token of PROVENANCE_TOKENS) {
      expect(asJson).not.toContain(token);
    }
  });

  it('read_reference renders the raw reference body, with NO provenance', async () => {
    const resp = await runtime.readReference({
      ref: { kind: 'name', name: PUBLISHED_SKILL },
      reference: PUBLISHED_REFERENCE,
    });
    expect(resp.ok).toBe(true);

    const rendered = renderReadReference(resp);
    expect(rendered.isError).toBeFalsy();
    expect(rendered.content[0].text.length).toBeGreaterThan(0);
    if (resp.ok) {
      expect(rendered.content[0].text).toBe(resp.data.body);
    }

    const asJson = JSON.stringify(rendered);
    for (const token of PROVENANCE_TOKENS) {
      expect(asJson).not.toContain(token);
    }
  });
});

// =============================================================================
// PART C — OPT-IN (flag ON): the declared `provenance.v1` staged shape
// =============================================================================

describe('staged provenance ON: declared provenance.v1 envelope (Req 9.9)', () => {
  it('read_skill ON produces { version, body, provenance } with the body preserved', async () => {
    const resp = await runtime.read({ ref: { kind: 'name', name: PUBLISHED_SKILL } });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;

    const rendered = renderReadSkill(resp, ON);
    expect(rendered.isError).toBeFalsy();

    const envelope = JSON.parse(rendered.content[0].text);
    // Exact declared shape: version + body + provenance, nothing else.
    expect(Object.keys(envelope).sort()).toEqual(['body', 'provenance', 'version']);
    expect(envelope.version).toBe('provenance.v1');
    // Body is preserved verbatim alongside the added provenance.
    expect(envelope.body).toBe(resp.data.body);

    // Declared minimum identity set { fqid, provider, source }.
    expect(envelope.provenance.fqid).toBe(`bundled:${PUBLISHED_SKILL}`);
    expect(envelope.provenance.provider).toBe('bundled');
    expect(typeof envelope.provenance.source).toBe('string');
    expect(envelope.provenance.source.length).toBeGreaterThan(0);
  });

  it('list_references ON produces { version, references, provenance }', async () => {
    const resp = await runtime.getReferences({ ref: { kind: 'name', name: PUBLISHED_SKILL } });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;

    const rendered = renderListReferences(resp, ON);
    expect(rendered.isError).toBeFalsy();

    const envelope = JSON.parse(rendered.content[0].text);
    expect(Object.keys(envelope).sort()).toEqual(['provenance', 'references', 'version']);
    expect(envelope.version).toBe('provenance.v1');

    // `references` is the SAME plain string array the compat shape produced.
    expect(Array.isArray(envelope.references)).toBe(true);
    expect(envelope.references).toEqual(resp.data.map((d) => d.path));
    for (const el of envelope.references) {
      expect(typeof el).toBe('string');
    }

    expect(envelope.provenance.fqid).toBe(`bundled:${PUBLISHED_SKILL}`);
    expect(envelope.provenance.provider).toBe('bundled');
    expect(typeof envelope.provenance.source).toBe('string');
  });

  it('read_reference ON produces { version, body, provenance } with the body preserved', async () => {
    const resp = await runtime.readReference({
      ref: { kind: 'name', name: PUBLISHED_SKILL },
      reference: PUBLISHED_REFERENCE,
    });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;

    const rendered = renderReadReference(resp, ON);
    expect(rendered.isError).toBeFalsy();

    const envelope = JSON.parse(rendered.content[0].text);
    expect(Object.keys(envelope).sort()).toEqual(['body', 'provenance', 'version']);
    expect(envelope.version).toBe('provenance.v1');
    expect(envelope.body).toBe(resp.data.body);

    expect(envelope.provenance.fqid).toBe(`bundled:${PUBLISHED_SKILL}`);
    expect(envelope.provenance.provider).toBe('bundled');
  });

  it('the staged shape is produced ONLY under the explicit opt-in (off != on)', async () => {
    const resp = await runtime.read({ ref: { kind: 'name', name: PUBLISHED_SKILL } });
    expect(resp.ok).toBe(true);

    const off = renderReadSkill(resp);
    const on = renderReadSkill(resp, ON);

    // OFF is the raw body; ON is the JSON envelope — they must differ.
    expect(on.content[0].text).not.toBe(off.content[0].text);
    expect(() => JSON.parse(off.content[0].text)).toThrow(); // raw markdown, not JSON
    expect(() => JSON.parse(on.content[0].text)).not.toThrow();
  });
});

// =============================================================================
// PART D — Error responses are unaffected by the flag (provenance only on success)
// =============================================================================

describe('staged provenance: error rendering is flag-independent', () => {
  const UNRESOLVED = 'definitely-not-a-real-skill-xyz';

  it('an unresolved name renders a typed not_found tool error in BOTH modes', async () => {
    const resp = await runtime.read({ ref: { kind: 'name', name: UNRESOLVED } });
    expect(resp.ok).toBe(false);

    const off = renderReadSkill(resp);
    const on = renderReadSkill(resp, ON);

    for (const rendered of [off, on]) {
      expect(rendered.isError).toBe(true);
      expect(rendered.content[0].text).toContain('not found');
      expect(rendered.content[0].text).toContain(UNRESOLVED);
    }
    // No staged envelope is emitted for an error, regardless of the flag.
    expect(off.content[0].text).toBe(on.content[0].text);
  });
});
