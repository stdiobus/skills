/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Integration Test: Package Exports & Tarball Verification
// Feature: npm-package-integrity
// Purpose: Builds a tarball with `npm pack`, installs it in an isolated temp
//          directory, and verifies every export path, bin entry, skill content
//          access, and MCP server startup from the consumer's perspective.
// =============================================================================

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..');
const PACK_TIMEOUT = 60_000;
const MCP_STARTUP_TIMEOUT = 10_000;

let tmpDir: string;
let consumerDir: string;
let installedPkgDir: string;

/**
 * Run a shell command synchronously, returning stdout.
 */
function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', timeout: PACK_TIMEOUT, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

beforeAll(() => {
  // 1. Create isolated temp directory
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-pkg-test-'));
  consumerDir = path.join(tmpDir, 'consumer');
  fs.mkdirSync(consumerDir, { recursive: true });

  // 2. Build the package (esbuild + tsc)
  run('node esbuild.config.mjs', PACKAGE_ROOT);
  try {
    run('npx tsc -p tsconfig.types.json', PACKAGE_ROOT);
  } catch {
    // tsc may warn but still emit declarations
  }

  // 3. Create tarball
  const packOutput = run(`npm pack --pack-destination ${tmpDir}`, PACKAGE_ROOT);
  const tgzName = packOutput.split('\n').pop()!;
  const tgzPath = path.join(tmpDir, tgzName);
  expect(fs.existsSync(tgzPath)).toBe(true);

  // 4. Create consumer package.json and install
  fs.writeFileSync(
    path.join(consumerDir, 'package.json'),
    JSON.stringify({ name: 'test-consumer', version: '1.0.0', type: 'module', private: true }),
  );
  run(`npm install ${tgzPath}`, consumerDir);

  installedPkgDir = path.join(consumerDir, 'node_modules', '@stdiobus', 'skills');
}, PACK_TIMEOUT);

afterAll(() => {
  // Clean up temp directory
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('Package Exports & Tarball Verification', () => {
  // ─── Structural checks ──────────────────────────────────────

  describe('installed package structure', () => {
    it('package is installed at the expected path', () => {
      expect(fs.existsSync(installedPkgDir)).toBe(true);
    });

    it('package.json exists and has correct name', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(installedPkgDir, 'package.json'), 'utf-8'));
      expect(pkg.name).toBe('@stdiobus/skills');
    });

    it('ESM library bundle exists', () => {
      expect(fs.existsSync(path.join(installedPkgDir, 'out', 'dist', 'index.mjs'))).toBe(true);
    });

    it('MCP server bundle exists', () => {
      expect(fs.existsSync(path.join(installedPkgDir, 'out', 'dist', 'mcp-server.mjs'))).toBe(true);
    });

    it('MCP server bundle has shebang', () => {
      const content = fs.readFileSync(path.join(installedPkgDir, 'out', 'dist', 'mcp-server.mjs'), 'utf-8');
      expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
    });

    it('TypeScript declarations exist', () => {
      expect(fs.existsSync(path.join(installedPkgDir, 'out', 'tsc', 'index.d.ts'))).toBe(true);
      expect(fs.existsSync(path.join(installedPkgDir, 'out', 'tsc', 'types.d.ts'))).toBe(true);
    });

    it('skills-manifest.json exists', () => {
      expect(fs.existsSync(path.join(installedPkgDir, 'agent-skills', 'skills-manifest.json'))).toBe(true);
    });

    it('README.md is included', () => {
      expect(fs.existsSync(path.join(installedPkgDir, 'README.md'))).toBe(true);
    });

    it('LICENSE is included', () => {
      expect(fs.existsSync(path.join(installedPkgDir, 'LICENSE'))).toBe(true);
    });
  });

  // ─── Export: main entry point ───────────────────────────────

  describe('export: @stdiobus/skills (main entry)', () => {
    it('resolves the main export via Node', () => {
      const result = run(
        `node --input-type=module -e "import { SkillName } from '@stdiobus/skills'; console.log(JSON.stringify(Object.values(SkillName)));"`,
        consumerDir,
      );
      const skills = JSON.parse(result);
      expect(skills).toBeInstanceOf(Array);
      expect(skills.length).toBe(12);
      expect(skills).toContain('runtime-concepts');
      expect(skills).toContain('runtime-patterns-http');
    });

    it('exports SkillName enum with all 12 members', () => {
      const result = run(
        `node --input-type=module -e "import { SkillName } from '@stdiobus/skills'; console.log(Object.keys(SkillName).length);"`,
        consumerDir,
      );
      expect(parseInt(result, 10)).toBe(12);
    });
  });

  // ─── Export: skills-manifest ────────────────────────────────

  describe('export: @stdiobus/skills/skills-manifest', () => {
    it('resolves the manifest export', () => {
      const result = run(
        `node --input-type=module -e "import manifest from '@stdiobus/skills/skills-manifest' with { type: 'json' }; console.log(manifest.skills.length);"`,
        consumerDir,
      );
      expect(parseInt(result, 10)).toBe(12);
    });

    it('manifest has correct structure', () => {
      const result = run(
        `node --input-type=module -e "import manifest from '@stdiobus/skills/skills-manifest' with { type: 'json' }; console.log(JSON.stringify({ v: manifest.version, fv: manifest.frameworkVersion, count: manifest.skills.length }));"`,
        consumerDir,
      );
      const data = JSON.parse(result);
      expect(data.v).toBe('1.0.0');
      expect(data.fv).toBe('0.5.0-beta.2');
      expect(data.count).toBe(12);
    });
  });

  // ─── Skill content access ──────────────────────────────────

  describe('skill content files', () => {
    const EXPECTED_SKILLS = [
      'runtime-concepts',
      'runtime-lifecycle',
      'runtime-api-core',
      'runtime-api-integrations',
      'runtime-patterns-http',
      'runtime-patterns-async',
      'runtime-patterns-data-events',
      'runtime-ssr-and-web',
      'runtime-constraints-and-guardrails',
      'runtime-errors-and-diagnostics',
      'runtime-versioning-and-migration',
      'runtime-validation-and-ci',
    ];

    it.each(EXPECTED_SKILLS)('SKILL.md exists for %s', (skillName) => {
      const skillPath = path.join(installedPkgDir, 'agent-skills', skillName, 'SKILL.md');
      expect(fs.existsSync(skillPath)).toBe(true);
    });

    it.each(EXPECTED_SKILLS)('SKILL.md for %s has YAML frontmatter', (skillName) => {
      const content = fs.readFileSync(
        path.join(installedPkgDir, 'agent-skills', skillName, 'SKILL.md'),
        'utf-8',
      );
      expect(content.startsWith('---\n')).toBe(true);
      expect(content.indexOf('---', 4)).toBeGreaterThan(4);
    });

    it.each(EXPECTED_SKILLS)('references/ directory exists for %s', (skillName) => {
      const refsDir = path.join(installedPkgDir, 'agent-skills', skillName, 'references');
      expect(fs.existsSync(refsDir)).toBe(true);
    });

    it('pattern skills include template files', () => {
      const patternSkills = ['runtime-patterns-http', 'runtime-patterns-async', 'runtime-patterns-data-events'];
      for (const skill of patternSkills) {
        const templatesDir = path.join(installedPkgDir, 'agent-skills', skill, 'references', 'templates');
        expect(fs.existsSync(templatesDir)).toBe(true);
        const templates = fs.readdirSync(templatesDir).filter((f) => f.endsWith('.ts'));
        expect(templates.length).toBeGreaterThan(0);
      }
    });

    it('error-catalog.json is included and valid JSON', () => {
      const catalogPath = path.join(
        installedPkgDir,
        'agent-skills',
        'runtime-errors-and-diagnostics',
        'references',
        'error-catalog.json',
      );
      expect(fs.existsSync(catalogPath)).toBe(true);
      const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
      expect(catalog.categories).toBeInstanceOf(Array);
      expect(catalog.categories.length).toBeGreaterThan(0);
    });
  });

  // ─── bin entry ─────────────────────────────────────────────

  describe('bin: mcp-skills', () => {
    it('bin entry is defined in installed package.json', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(installedPkgDir, 'package.json'), 'utf-8'));
      expect(pkg.bin).toBeDefined();
      expect(pkg.bin['mcp-skills']).toBe('out/dist/mcp-server.mjs');
    });

    it('bin symlink exists in node_modules/.bin', () => {
      const binPath = path.join(consumerDir, 'node_modules', '.bin', 'mcp-skills');
      expect(fs.existsSync(binPath)).toBe(true);
    });

    it('npx mcp-skills --help does not crash (exits cleanly or starts server)', () => {
      // The MCP server reads from stdin, so without input it will hang.
      // We verify it starts without immediate crash by sending EOF.
      try {
        execSync(
          `echo '' | node ${path.join(installedPkgDir, 'out', 'dist', 'mcp-server.mjs')}`,
          { cwd: consumerDir, timeout: MCP_STARTUP_TIMEOUT, stdio: ['pipe', 'pipe', 'pipe'] },
        );
      } catch (err: any) {
        // Server may exit with non-zero when stdin closes — that's fine.
        // We only care that it doesn't crash with MODULE_NOT_FOUND or similar.
        const stderr = err.stderr?.toString() ?? '';
        expect(stderr).not.toMatch(/Cannot find module/i);
        expect(stderr).not.toMatch(/MODULE_NOT_FOUND/i);
        expect(stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/i);
        expect(stderr).not.toMatch(/SyntaxError/i);
      }
    });
  });

  // ─── No test artifacts in published package ────────────────

  describe('package cleanliness', () => {
    it('does not include source .ts files (except SKILL.md references)', () => {
      const distFiles = fs.readdirSync(path.join(installedPkgDir, 'out', 'dist'));
      const tsFiles = distFiles.filter((f) => f.endsWith('.ts'));
      expect(tsFiles).toEqual([]);
    });

    it('does not include __tests__ directory at package root', () => {
      expect(fs.existsSync(path.join(installedPkgDir, '__tests__'))).toBe(false);
      expect(fs.existsSync(path.join(installedPkgDir, 'agent-skills', '__tests__'))).toBe(false);
    });

    it('does not include scripts directory', () => {
      expect(fs.existsSync(path.join(installedPkgDir, 'agent-skills', 'scripts'))).toBe(false);
    });

    it('does not include node_modules', () => {
      // The installed package should not bundle its own node_modules
      // (dependencies are installed at the consumer level)
      const pkgNodeModules = path.join(installedPkgDir, 'node_modules');
      if (fs.existsSync(pkgNodeModules)) {
        // npm may create node_modules for hoisting — that's fine
        // but it should not contain the package's own source
        expect(fs.existsSync(path.join(pkgNodeModules, '@stdiobus', 'skills'))).toBe(false);
      }
    });
  });

  // ─── Tarball size sanity check ─────────────────────────────

  describe('tarball sanity', () => {
    it('tarball is under 500KB', () => {
      const tgzFiles = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tgz'));
      expect(tgzFiles.length).toBe(1);
      const stat = fs.statSync(path.join(tmpDir, tgzFiles[0]));
      expect(stat.size).toBeLessThan(500 * 1024);
    });
  });
});
