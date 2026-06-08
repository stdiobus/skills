/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Developer-sandbox skill-package builder (e2e fixture).
 *
 * Writes a REAL on-disk skill package under `<tmp>/agent-skills/` shaped exactly like the
 * published bundle: a `skills-manifest.json` (same field set as the real manifest) plus,
 * for each listed skill, a `SKILL.md` with valid frontmatter + the fixed body section
 * order, a `references/` tree, and (for at least one skill) a `templates/*.ts` file. The
 * federated e2e harness points a REAL {@link FilesystemSkillProvider} at this root, so the
 * package is consumed through the exact production disk-I/O path — nothing is mocked.
 *
 * ─── Deliberate edge cases (each a SEPARATE skill, so failure containment is testable) ──
 *
 *  (a) {@link MISSING_SKILL_NAME} — a manifest entry whose `SKILL.md` is intentionally
 *      ABSENT on disk. `resolve()` succeeds (the entry exists) but `read()` throws ENOENT,
 *      which the runtime returns as a typed `provider_error` (rendered `isError: true`).
 *      This proves a broken skill does not poison its valid siblings.
 *  (b) {@link BROKEN_REF_SKILL_NAME} — a fully valid skill whose `References` section names
 *      a file that does NOT exist in its `references/` directory. Reading that missing
 *      reference returns a typed error, while the skill itself reads fine.
 *  (c) {@link DUPLICATE_BUNDLED_NAME} — a skill whose `name` deliberately DUPLICATES a
 *      bundled skill name (`runtime-concepts`). Registered alongside the bundled provider
 *      it produces two candidates with distinct FQIDs (`bundled:…` vs `sandbox:…`), which
 *      the runtime surfaces as a typed `ambiguous` error — exercising cross-provider
 *      identity-conflict handling explicitly, not incidentally.
 *
 * The builder returns the sandbox `packageRoot`, a descriptor of every skill it created
 * (name + valid/broken classification), and a `cleanup()` that removes the temp tree.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** A sandbox skill whose name collides with a bundled skill (cross-provider ambiguity). */
export const DUPLICATE_BUNDLED_NAME = 'runtime-concepts';
/** A manifest entry whose SKILL.md is intentionally missing on disk (failure containment). */
export const MISSING_SKILL_NAME = 'sandbox-missing-skill';
/** A valid skill whose `References` section names a non-existent reference file. */
export const BROKEN_REF_SKILL_NAME = 'sandbox-broken-ref';
/** The primary fully-valid sandbox skill (used for byte-for-byte read + search hits). */
export const VALID_SKILL_NAME = 'sandbox-lambda-basics';
/** A second fully-valid sandbox skill (the surviving sibling in failure-containment tests). */
export const VALID_SIBLING_NAME = 'sandbox-events-guide';

/** A reference file that genuinely exists under {@link VALID_SKILL_NAME}/references/. */
export const VALID_REFERENCE_PATH = 'overview.md';
/** A template reference that genuinely exists under {@link VALID_SKILL_NAME}/references/. */
export const VALID_TEMPLATE_PATH = 'templates/handler.ts';
/** A reference path that does NOT exist under {@link BROKEN_REF_SKILL_NAME}/references/. */
export const MISSING_REFERENCE_PATH = 'does-not-exist.md';

/** Classification of a single skill the builder wrote to disk. */
export interface SandboxSkillDescriptor {
  /** Skill directory + manifest name. */
  name: string;
  /** Manifest layer number. */
  layer: number;
  /** Whether the skill reads cleanly end-to-end (SKILL.md present and readable). */
  valid: boolean;
  /** Human-readable reason a skill is classified broken (omitted when valid). */
  reason?: string;
}

/** The result of building a sandbox skill package. */
export interface SandboxResult {
  /** Absolute package root to hand to `new FilesystemSkillProvider({ packageRoot })`. */
  packageRoot: string;
  /** Absolute path to `<packageRoot>/agent-skills`. */
  agentSkillsDir: string;
  /** Absolute path to the written `skills-manifest.json`. */
  manifestPath: string;
  /** Every skill the builder created, with valid/broken classification. */
  skills: SandboxSkillDescriptor[];
  /** Names of the skills that read cleanly end-to-end. */
  validSkillNames: string[];
  /** Remove the entire temp tree (idempotent). */
  cleanup: () => void;
}

/** Frontmatter + body inputs for a generated SKILL.md. */
interface SkillSpec {
  name: string;
  layer: number;
  layerName: string;
  description: string;
  /** The `References` section bullet lines (markdown). */
  referenceLines: string[];
}

/** Render a valid SKILL.md (frontmatter + fixed section order) for the given spec. */
function renderSkillMd(spec: SkillSpec): string {
  return `---
name: ${spec.name}
description: >
  ${spec.description}
license: Elastic-2.0
compatibility: Requires @worktif/runtime >=0.5.0 <1.0.0
metadata:
  author: sandbox-author
  version: "1.0.0"
  framework: "@worktif/runtime"
  frameworkVersionRange: ">=0.5.0 <1.0.0"
  layer: "${spec.layer}"
  layerName: "${spec.layerName}"
---

## Overview

${spec.description}

## When to Use

- When exercising the federated skills runtime end to end against a developer sandbox.

## Core Concepts

### Sandbox skill

A sandbox skill is authored on disk exactly like a bundled skill and served through the
same \`FilesystemSkillProvider\`.

\`\`\`typescript
const value: number = 42;
\`\`\`

## Instructions

Use this skill only inside the e2e harness.

## Common Mistakes

### ❌ WRONG: assuming sandbox skills are published

\`\`\`typescript
const published = false; // sandbox skills are not in the published manifest document
\`\`\`

### ✅ CORRECT: addressing sandbox skills through the federated runtime

\`\`\`typescript
const federated = true;
\`\`\`

## References

${spec.referenceLines.join('\n')}
`;
}

/** Write a file, creating parent directories as needed. */
function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf-8');
}

/**
 * Build a developer-sandbox skill package in a fresh temp directory.
 *
 * @param baseTmpDir - optional base directory for the temp tree (defaults to the OS temp
 *   dir). A unique `skills-e2e-*` subdirectory is always created via `fs.mkdtempSync`.
 * @returns the sandbox package root, per-skill classification, and a `cleanup()` function.
 */
export function buildSandbox(baseTmpDir: string = os.tmpdir()): SandboxResult {
  const packageRoot = fs.mkdtempSync(path.join(baseTmpDir, 'skills-e2e-'));
  const agentSkillsDir = path.join(packageRoot, 'agent-skills');
  fs.mkdirSync(agentSkillsDir, { recursive: true });

  const skills: SandboxSkillDescriptor[] = [
    { name: VALID_SKILL_NAME, layer: 3, valid: true },
    { name: VALID_SIBLING_NAME, layer: 3, valid: true },
    {
      name: BROKEN_REF_SKILL_NAME,
      layer: 4,
      valid: true,
      reason: 'valid SKILL.md but References names a non-existent file',
    },
    {
      name: DUPLICATE_BUNDLED_NAME,
      layer: 1,
      valid: true,
      reason: 'name duplicates a bundled skill — cross-provider ambiguity',
    },
    {
      name: MISSING_SKILL_NAME,
      layer: 5,
      valid: false,
      reason: 'manifest entry present but SKILL.md absent on disk',
    },
  ];

  // --- skills-manifest.json (same field set as the published manifest) ---
  const manifest = {
    version: '1.0.0',
    frameworkVersion: '0.5.3-kata.1',
    skills: skills.map((s) => ({
      name: s.name,
      layer: s.layer,
      versionRange: '>=0.5.0 <1.0.0',
      status: 'valid',
      lastValidated: '2026-06-08T12:00:00.000Z',
    })),
    lastValidated: '2026-06-08T12:00:00.000Z',
  };
  const manifestPath = path.join(agentSkillsDir, 'skills-manifest.json');
  writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  // --- VALID_SKILL_NAME: full skill with a reference doc + a template ---
  writeFile(
    path.join(agentSkillsDir, VALID_SKILL_NAME, 'SKILL.md'),
    renderSkillMd({
      name: VALID_SKILL_NAME,
      layer: 3,
      layerName: 'Patterns',
      description: 'Sandbox lambda basics — a fully valid sandbox skill for e2e federation.',
      referenceLines: [
        `- [Overview](references/${VALID_REFERENCE_PATH}) — sandbox reference document`,
        `- [Handler template](references/${VALID_TEMPLATE_PATH}) — canonical template`,
      ],
    }),
  );
  writeFile(
    path.join(agentSkillsDir, VALID_SKILL_NAME, 'references', VALID_REFERENCE_PATH),
    '# Sandbox lambda basics — overview\n\nThis reference is served from the developer sandbox.\n',
  );
  writeFile(
    path.join(agentSkillsDir, VALID_SKILL_NAME, 'references', VALID_TEMPLATE_PATH),
    [
      '// Canonical sandbox handler template.',
      'export const handler = async (): Promise<{ statusCode: number }> => {',
      '  return { statusCode: 200 };',
      '};',
      '',
    ].join('\n'),
  );

  // --- VALID_SIBLING_NAME: a second valid skill (surviving sibling) ---
  writeFile(
    path.join(agentSkillsDir, VALID_SIBLING_NAME, 'SKILL.md'),
    renderSkillMd({
      name: VALID_SIBLING_NAME,
      layer: 3,
      layerName: 'Patterns',
      description: 'Sandbox events guide — the valid sibling used in failure-containment tests.',
      referenceLines: [`- [Overview](references/${VALID_REFERENCE_PATH}) — sandbox reference document`],
    }),
  );
  writeFile(
    path.join(agentSkillsDir, VALID_SIBLING_NAME, 'references', VALID_REFERENCE_PATH),
    '# Sandbox events guide — overview\n\nServed from the developer sandbox.\n',
  );

  // --- BROKEN_REF_SKILL_NAME: valid skill, but References names a missing file (edge b) ---
  writeFile(
    path.join(agentSkillsDir, BROKEN_REF_SKILL_NAME, 'SKILL.md'),
    renderSkillMd({
      name: BROKEN_REF_SKILL_NAME,
      layer: 4,
      layerName: 'Guardrails',
      description: 'Sandbox broken-ref — valid skill whose References names a non-existent file.',
      referenceLines: [
        `- [Missing](references/${MISSING_REFERENCE_PATH}) — intentionally absent on disk`,
      ],
    }),
  );
  // Create the references directory (with one real, unrelated file) but NOT the referenced
  // file, so listing works yet reading the named reference fails with a typed error.
  writeFile(
    path.join(agentSkillsDir, BROKEN_REF_SKILL_NAME, 'references', '.gitkeep'),
    '',
  );

  // --- DUPLICATE_BUNDLED_NAME: collides with a bundled skill name (edge c) ---
  writeFile(
    path.join(agentSkillsDir, DUPLICATE_BUNDLED_NAME, 'SKILL.md'),
    renderSkillMd({
      name: DUPLICATE_BUNDLED_NAME,
      layer: 1,
      layerName: 'Concepts',
      description: 'Sandbox runtime-concepts — deliberately collides with the bundled name.',
      referenceLines: [`- [Overview](references/${VALID_REFERENCE_PATH}) — sandbox reference document`],
    }),
  );
  writeFile(
    path.join(agentSkillsDir, DUPLICATE_BUNDLED_NAME, 'references', VALID_REFERENCE_PATH),
    '# Sandbox runtime-concepts — overview\n\nServed from the developer sandbox.\n',
  );

  // --- MISSING_SKILL_NAME: NO SKILL.md written (edge a). References dir exists. ---
  writeFile(path.join(agentSkillsDir, MISSING_SKILL_NAME, 'references', '.gitkeep'), '');

  const validSkillNames = skills.filter((s) => s.valid).map((s) => s.name);

  const cleanup = (): void => {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  };

  return { packageRoot, agentSkillsDir, manifestPath, skills, validSkillNames, cleanup };
}
