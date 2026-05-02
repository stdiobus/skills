#!/usr/bin/env tsx
/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * verify-package.ts — Real-world package verification.
 *
 * Builds a tarball, installs it in an isolated temp directory, and verifies
 * every export, bin entry, skill content, and MCP server startup exactly as
 * a real consumer would experience after `npm install @stdiobus/skills`.
 *
 * This is NOT a test framework. It is a direct verification script that
 * exercises the published package through the same paths a real user takes.
 *
 * Usage:  yarn verify:package
 *         tsx agent-skills/scripts/verify-package.ts
 */

import { execSync, spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Config ─────────────────────────────────────────────────────

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..');
const TIMEOUT = 60_000;
const MCP_TIMEOUT = 15_000;

// ─── Helpers ────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (err: any) {
    failed++;
    const msg = err.message ?? String(err);
    failures.push(`${label}: ${msg}`);
    console.error(`  ✗ ${label}`);
    console.error(`    ${msg}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(cmd: string, cwd: string): string {
  return execSync(cmd, {
    cwd,
    encoding: 'utf-8',
    timeout: TIMEOUT,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

async function checkAsync(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (err: any) {
    failed++;
    const msg = err.message ?? String(err);
    failures.push(`${label}: ${msg}`);
    console.error(`  ✗ ${label}`);
    console.error(`    ${msg}`);
  }
}

/**
 * Minimal MCP client: spawns the server, sends JSON-RPC requests over stdio,
 * reads NDJSON responses. No SDK, no dependencies — raw protocol.
 */
class McpClient {
  private proc: ChildProcess;
  private buffer = '';
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private nextId = 1;

  constructor(serverPath: string, cwd: string) {
    this.proc = spawn('node', [serverPath], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test' },
    });
    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8');
      this.drain();
    });
  }

  private drain(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!.resolve(msg);
          this.pending.delete(msg.id);
        }
      } catch { /* ignore non-JSON lines */ }
    }
  }

  send(method: string, params?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
      }, MCP_TIMEOUT);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} });
      this.proc.stdin!.write(msg + '\n');
    });
  }

  async initialize(): Promise<any> {
    const resp = await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'verify-package', version: '1.0.0' },
    });
    // Send initialized notification (no id, no response expected)
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return resp;
  }

  async close(): Promise<void> {
    this.proc.stdin!.end();
    return new Promise((resolve) => {
      this.proc.on('close', () => resolve());
      setTimeout(() => { this.proc.kill(); resolve(); }, 3000);
    });
  }
}

// ─── Setup ──────────────────────────────────────────────────────

console.log('\n📦 verify-package: building and packing tarball...\n');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-verify-'));
const consumerDir = path.join(tmpDir, 'consumer');
fs.mkdirSync(consumerDir, { recursive: true });

async function main(): Promise<void> {
  try {
    // Build
    run('node esbuild.config.mjs', PACKAGE_ROOT);
    try { run('npx tsc -p tsconfig.types.json', PACKAGE_ROOT); } catch { /* warnings ok */ }

    // Pack
    const packOutput = run(`npm pack --pack-destination ${tmpDir}`, PACKAGE_ROOT);
    const tgzName = packOutput.split('\n').pop()!;
    const tgzPath = path.join(tmpDir, tgzName);
    assert(fs.existsSync(tgzPath), `Tarball not found: ${tgzPath}`);

    // Create consumer project and install
    fs.writeFileSync(
      path.join(consumerDir, 'package.json'),
      JSON.stringify({ name: 'test-consumer', version: '1.0.0', type: 'module', private: true }),
    );
    run(`npm install ${tgzPath}`, consumerDir);

    const pkgDir = path.join(consumerDir, 'node_modules', '@stdiobus', 'skills');
    assert(fs.existsSync(pkgDir), 'Package not installed');

    console.log('📦 Tarball installed. Running checks...\n');

    // ─── 1. Structure ───────────────────────────────────────────

    console.log('── Structure ──');

    check('package.json has correct name', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'));
      assert(pkg.name === '@stdiobus/skills', `Expected @stdiobus/skills, got ${pkg.name}`);
    });

    check('ESM library bundle exists (index.mjs)', () => {
      assert(fs.existsSync(path.join(pkgDir, 'out', 'dist', 'index.mjs')), 'index.mjs missing');
    });

    check('MCP server bundle exists (mcp-server.mjs)', () => {
      assert(fs.existsSync(path.join(pkgDir, 'out', 'dist', 'mcp-server.mjs')), 'mcp-server.mjs missing');
    });

    check('MCP server has shebang', () => {
      const content = fs.readFileSync(path.join(pkgDir, 'out', 'dist', 'mcp-server.mjs'), 'utf-8');
      assert(content.startsWith('#!/usr/bin/env node'), 'Missing shebang');
    });

    check('TypeScript declarations exist', () => {
      assert(fs.existsSync(path.join(pkgDir, 'out', 'tsc', 'index.d.ts')), 'index.d.ts missing');
      assert(fs.existsSync(path.join(pkgDir, 'out', 'tsc', 'types.d.ts')), 'types.d.ts missing');
    });

    check('skills-manifest.json exists', () => {
      assert(fs.existsSync(path.join(pkgDir, 'agent-skills', 'skills-manifest.json')), 'manifest missing');
    });

    check('README.md included', () => {
      assert(fs.existsSync(path.join(pkgDir, 'README.md')), 'README.md missing');
    });

    check('LICENSE included', () => {
      assert(fs.existsSync(path.join(pkgDir, 'LICENSE')), 'LICENSE missing');
    });

    // ─── 2. Exports ─────────────────────────────────────────────

    console.log('\n── Exports ──');

    check('import { SkillName } from "@stdiobus/skills" resolves', () => {
      const result = run(
        `node --input-type=module -e "import { SkillName } from '@stdiobus/skills'; console.log(JSON.stringify(Object.values(SkillName)));"`,
        consumerDir,
      );
      const skills = JSON.parse(result);
      assert(Array.isArray(skills), 'SkillName values is not an array');
      assert(skills.length === 12, `Expected 12 skills, got ${skills.length}`);
      assert(skills.includes('runtime-concepts'), 'Missing runtime-concepts');
      assert(skills.includes('runtime-patterns-http'), 'Missing runtime-patterns-http');
    });

    check('import manifest from "@stdiobus/skills/skills-manifest" resolves', () => {
      const result = run(
        `node --input-type=module -e "import m from '@stdiobus/skills/skills-manifest' with { type: 'json' }; console.log(JSON.stringify({ v: m.version, c: m.skills.length }));"`,
        consumerDir,
      );
      const data = JSON.parse(result);
      assert(data.v === '1.0.0', `Expected version 1.0.0, got ${data.v}`);
      assert(data.c === 12, `Expected 12 skills, got ${data.c}`);
    });

    // ─── 3. Skill content ──────────────────────────────────────

    console.log('\n── Skill Content ──');

    const EXPECTED_SKILLS = [
      'runtime-concepts', 'runtime-lifecycle',
      'runtime-api-core', 'runtime-api-integrations',
      'runtime-patterns-http', 'runtime-patterns-async',
      'runtime-patterns-data-events', 'runtime-ssr-and-web',
      'runtime-constraints-and-guardrails',
      'runtime-errors-and-diagnostics', 'runtime-versioning-and-migration',
      'runtime-validation-and-ci',
    ];

    for (const skill of EXPECTED_SKILLS) {
      check(`SKILL.md exists: ${skill}`, () => {
        const p = path.join(pkgDir, 'agent-skills', skill, 'SKILL.md');
        assert(fs.existsSync(p), `${p} missing`);
        const content = fs.readFileSync(p, 'utf-8');
        assert(content.startsWith('---\n'), 'Missing YAML frontmatter opening');
        assert(content.indexOf('---', 4) > 4, 'Missing YAML frontmatter closing');
      });

      check(`references/ exists: ${skill}`, () => {
        const p = path.join(pkgDir, 'agent-skills', skill, 'references');
        assert(fs.existsSync(p), `${p} missing`);
      });
    }

    check('pattern skills have template files', () => {
      for (const skill of ['runtime-patterns-http', 'runtime-patterns-async', 'runtime-patterns-data-events']) {
        const dir = path.join(pkgDir, 'agent-skills', skill, 'references', 'templates');
        assert(fs.existsSync(dir), `${skill}/references/templates/ missing`);
        const templates = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
        assert(templates.length > 0, `${skill} has no .ts templates`);
      }
    });

    check('error-catalog.json is valid JSON', () => {
      const p = path.join(pkgDir, 'agent-skills', 'runtime-errors-and-diagnostics', 'references', 'error-catalog.json');
      assert(fs.existsSync(p), 'error-catalog.json missing');
      const catalog = JSON.parse(fs.readFileSync(p, 'utf-8'));
      assert(Array.isArray(catalog.categories), 'categories is not an array');
      assert(catalog.categories.length > 0, 'categories is empty');
    });

    // ─── 4. bin ─────────────────────────────────────────────────

    console.log('\n── bin: mcp-skills ──');

    check('bin entry points to mcp-server.mjs', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'));
      assert(pkg.bin['mcp-skills'] === 'out/dist/mcp-server.mjs', `Unexpected bin: ${JSON.stringify(pkg.bin)}`);
    });

    check('bin symlink exists in .bin/', () => {
      const binPath = path.join(consumerDir, 'node_modules', '.bin', 'mcp-skills');
      assert(fs.existsSync(binPath), '.bin/mcp-skills symlink missing');
    });

    check('MCP server starts without MODULE_NOT_FOUND', () => {
      try {
        execSync(
          `echo '' | node ${path.join(pkgDir, 'out', 'dist', 'mcp-server.mjs')}`,
          { cwd: consumerDir, timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] },
        );
      } catch (err: any) {
        const stderr = err.stderr?.toString() ?? '';
        assert(!stderr.match(/Cannot find module/i), `MODULE_NOT_FOUND: ${stderr}`);
        assert(!stderr.match(/ERR_MODULE_NOT_FOUND/i), `ERR_MODULE_NOT_FOUND: ${stderr}`);
        assert(!stderr.match(/SyntaxError/i), `SyntaxError: ${stderr}`);
      }
    });

    // ─── 5. MCP Protocol Round-Trip ─────────────────────────────

    console.log('\n── MCP Protocol (JSON-RPC over stdio) ──');

    const serverPath = path.join(pkgDir, 'out', 'dist', 'mcp-server.mjs');
    let client: McpClient | null = null;

    try {
      client = new McpClient(serverPath, consumerDir);

      await checkAsync('initialize handshake succeeds', async () => {
        const resp = await client!.initialize();
        assert(resp.result != null, 'No result in initialize response');
        assert(resp.result.serverInfo?.name === '@stdiobus/skills', `Unexpected server name: ${resp.result.serverInfo?.name}`);
        assert(resp.result.capabilities?.tools != null, 'Missing tools capability');
      });

      await checkAsync('tools/list returns 5 tools', async () => {
        const resp = await client!.send('tools/list');
        assert(resp.result?.tools != null, 'No tools in response');
        const names = resp.result.tools.map((t: any) => t.name).sort();
        assert(names.length === 5, `Expected 5 tools, got ${names.length}`);
        const expected = ['list_references', 'list_skills', 'read_reference', 'read_skill', 'search_skills'];
        assert(JSON.stringify(names) === JSON.stringify(expected), `Unexpected tools: ${names.join(', ')}`);
      });

      await checkAsync('list_skills returns 12 skills with layers', async () => {
        const resp = await client!.send('tools/call', { name: 'list_skills', arguments: {} });
        assert(resp.result?.content?.[0]?.text != null, 'No content in list_skills response');
        const manifest = JSON.parse(resp.result.content[0].text);
        assert(manifest.skills?.length === 12, `Expected 12 skills, got ${manifest.skills?.length}`);
        for (const skill of manifest.skills) {
          assert(typeof skill.name === 'string', `Skill missing name`);
          assert(typeof skill.layer === 'number', `Skill ${skill.name} missing layer`);
          assert(skill.status === 'valid', `Skill ${skill.name} status is ${skill.status}`);
        }
      });

      await checkAsync('read_skill returns SKILL.md content with frontmatter', async () => {
        const resp = await client!.send('tools/call', { name: 'read_skill', arguments: { skill: 'runtime-concepts' } });
        assert(resp.result?.content?.[0]?.text != null, 'No content in read_skill response');
        const content = resp.result.content[0].text;
        assert(content.startsWith('---\n'), 'Missing YAML frontmatter');
        assert(content.includes('name: runtime-concepts'), 'Wrong skill name in frontmatter');
        assert(content.includes('## Overview'), 'Missing Overview section');
      });

      await checkAsync('list_references returns files for a skill', async () => {
        const resp = await client!.send('tools/call', { name: 'list_references', arguments: { skill: 'runtime-patterns-http' } });
        assert(resp.result?.content?.[0]?.text != null, 'No content in list_references response');
        const refs = JSON.parse(resp.result.content[0].text);
        assert(Array.isArray(refs), 'References is not an array');
        assert(refs.length > 0, 'No references returned');
        assert(refs.some((r: string) => r.includes('templates/')), 'No template files in references');
      });

      await checkAsync('read_reference returns template content', async () => {
        const resp = await client!.send('tools/call', {
          name: 'read_reference',
          arguments: { skill: 'runtime-patterns-http', reference: 'templates/single-get.ts' },
        });
        assert(resp.result?.content?.[0]?.text != null, 'No content in read_reference response');
        const content = resp.result.content[0].text;
        assert(content.includes('import'), 'Template does not contain import statement');
        assert(content.includes('LambdaDefinition'), 'Template does not reference LambdaDefinition');
      });

      await checkAsync('read_reference rejects directory traversal', async () => {
        const resp = await client!.send('tools/call', {
          name: 'read_reference',
          arguments: { skill: 'runtime-concepts', reference: '../../package.json' },
        });
        assert(resp.result?.isError === true, 'Directory traversal was not rejected');
      });

      await checkAsync('search_skills returns ranked results', async () => {
        const resp = await client!.send('tools/call', { name: 'search_skills', arguments: { query: 'http endpoint' } });
        assert(resp.result?.content?.[0]?.text != null, 'No content in search_skills response');
        const results = JSON.parse(resp.result.content[0].text);
        assert(Array.isArray(results), 'Search results is not an array');
        assert(results.length > 0, 'No search results');
        assert(results[0].skill != null, 'Search result missing skill field');
        assert(typeof results[0].score === 'number', 'Search result missing score');
        assert(typeof results[0].description === 'string', 'Search result missing description');
        assert(typeof results[0].layer === 'number', 'Search result missing layer');
        assert(typeof results[0].layerName === 'string', 'Search result missing layerName');
        // Results should be sorted by score descending
        for (let i = 1; i < results.length; i++) {
          assert(results[i].score <= results[i - 1].score, 'Results not sorted by score descending');
        }
      });

      await checkAsync('search_skills returns empty for nonsense query', async () => {
        const resp = await client!.send('tools/call', { name: 'search_skills', arguments: { query: 'xyzzy_nonexistent_zzz' } });
        assert(resp.result?.content?.[0]?.text != null, 'No content');
        const results = JSON.parse(resp.result.content[0].text);
        assert(Array.isArray(results), 'Not an array');
        assert(results.length === 0, `Expected 0 results, got ${results.length}`);
      });

      await checkAsync('read_skill rejects invalid skill name', async () => {
        const resp = await client!.send('tools/call', { name: 'read_skill', arguments: { skill: 'nonexistent-skill' } });
        assert(resp.result?.isError === true, 'Invalid skill name was not rejected');
      });

    } finally {
      if (client) await client.close();
    }

    // ─── 6. Cleanliness ────────────────────────────────────────

    console.log('\n── Cleanliness ──');

    check('no __tests__ in published package', () => {
      assert(!fs.existsSync(path.join(pkgDir, '__tests__')), '__tests__ found at root');
      assert(!fs.existsSync(path.join(pkgDir, 'agent-skills', '__tests__')), 'agent-skills/__tests__ found');
    });

    check('no scripts/ in published package', () => {
      assert(!fs.existsSync(path.join(pkgDir, 'agent-skills', 'scripts')), 'agent-skills/scripts/ found');
    });

    check('no .ts source files in dist/', () => {
      const distFiles = fs.readdirSync(path.join(pkgDir, 'out', 'dist'));
      const tsFiles = distFiles.filter((f) => f.endsWith('.ts'));
      assert(tsFiles.length === 0, `.ts files in dist: ${tsFiles.join(', ')}`);
    });

    check('tarball under 500KB', () => {
      const stat = fs.statSync(tgzPath);
      assert(stat.size < 500 * 1024, `Tarball is ${(stat.size / 1024).toFixed(1)}KB, expected < 500KB`);
    });

    // ─── Summary ───────────────────────────────────────────────

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  ✓ ${passed} passed`);
    if (failed > 0) {
      console.log(`  ✗ ${failed} failed\n`);
      for (const f of failures) {
        console.error(`    • ${f}`);
      }
      console.log('');
      process.exit(1);
    } else {
      console.log(`  0 failed\n`);
      console.log('  Package verification complete. All checks passed.\n');
    }

  } finally {
    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`\nFatal error: ${err.message ?? err}\n`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
