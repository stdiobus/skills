/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live, installed-package E2E — provider boundary over BOTH transports (Milestone-002, Task 11.2).
 *
 * The milestone proof (Req 14.1–14.6), MOCK-FREE and driven through the INSTALLED package — no
 * source-tree shortcuts. The flow, exactly as a real consumer experiences it:
 *
 *   1. build → `npm pack` a tarball → install it into a CLEAN consumer project (Req 14.1);
 *   2. boot the INSTALLED production MCP stdio server (`out/dist/mcp-server.mjs`) and assert the
 *      default FIVE-tool surface plus a BUNDLED skill read BYTE-FOR-BYTE (Req 14.3, 15.1);
 *   3. over an installed-package admission-capable MCP server (a separately-enabled surface,
 *      Req 15.3), admit an external provider via the PRODUCTION `skills.add.v1` path, FETCH its
 *      skill over REAL HTTPS from a real provider (a pinned public GitHub raw URL), then READ the
 *      admitted skill back over MCP (Req 14.2);
 *   4. over the INSTALLED stdio Bus worker (mirroring the production dispatch), admit the same
 *      provider via the SAME production path, read the admitted skill back, and FEDERATE it with
 *      the bundled provider — proving BOTH transports wrap the same in-process runtime COMPOSITION
 *      (in-process provider materialization; no new worker, no second StdioBus) (Req 14.2);
 *   5. exercise quarantine paths as RETURNED typed results (invalid config; namespace spoof) (Req 14.5).
 *
 * ─── NO FALLBACK (locked DoD, milestone §10 risk; Req 14.5) ─────────────────────────────────
 *
 * The live E2E uses a REAL HTTPS provider ONLY — there is NO localhost, fixture, mock,
 * cached-success, or any fallback path anywhere in this file or its harnesses. If the real
 * provider is unavailable, admission fails and THIS TEST FAILS HONESTLY rather than degrading to a
 * substitute. That is the intended behavior, not a flake to paper over.
 *
 * ─── CLEANUP (Req 14.6) ─────────────────────────────────────────────────────────────────────
 *
 * The harness cleans up every process it spawns (the installed MCP stdio servers and the stdio Bus
 * worker) and every temp artifact it creates (tarball, consumer project) on BOTH pass and fail
 * (try/finally + afterAll). This is TEST-PROCESS cleanup only; M-002 implements no provider
 * removal/dispose/eviction.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { McpStdioClient } from './lib/mcp-stdio-client.js';
import { BusStdioClient } from './lib/bus-stdio-client.js';

// The package root is four levels up: e2e -> __tests__ -> agent-skills -> packageRoot.
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..');
const HARNESS_DIR = path.join(__dirname, 'harness', 'installed');

/**
 * REAL HTTPS provider — a pinned, immutable public GitHub raw URL (the same origin Task 7.1 / §10
 * used). NO localhost, NO fixture, NO fallback. The HttpSkillProvider derives the skill name from
 * the URL basename: `.../COPYING` → `copying`.
 */
const REAL_HTTPS_URL = 'https://raw.githubusercontent.com/git/git/v2.43.0/COPYING';
/** The skill name the HTTPS provider mints from {@link REAL_HTTPS_URL} (URL basename, kebab-cased). */
const ADMITTED_SKILL_NAME = 'copying';
/** A stable substring of the real fetched body (git's COPYING is GPLv2), proving real acquisition. */
const ADMITTED_BODY_MARKER = 'GNU GENERAL PUBLIC LICENSE';
/** A bundled skill used for the byte-for-byte assertion. */
const BUNDLED_SKILL = 'runtime-concepts';

/** Capability wire methods (kept as literals so the test does not import the package internals). */
const M_ADD = 'skills.add.v1';
const M_READ = 'skills.read.v1';
const M_LIST = 'skills.list.v1';

jest.setTimeout(600_000);

let tmpDir = '';
let consumerDir = '';
let pkgDir = '';
let tgzPath = '';

/** Run a command synchronously, returning trimmed stdout. */
function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 300_000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

beforeAll(() => {
  // 1. Build the shipped artifacts (incl. out/dist/runtime.mjs + the .d.ts) and pack a tarball.
  run('node esbuild.config.mjs', PACKAGE_ROOT);
  try {
    run('npx tsc -p tsconfig.types.json', PACKAGE_ROOT);
  } catch {
    /* declaration-only build: type warnings do not block packing */
  }

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-live-e2e-'));
  const packOutput = run(`npm pack --pack-destination ${tmpDir}`, PACKAGE_ROOT);
  const tgzName = packOutput.split('\n').pop()!.trim();
  tgzPath = path.join(tmpDir, tgzName);
  if (!fs.existsSync(tgzPath)) throw new Error(`tarball not produced at ${tgzPath}`);

  // 2. Create a CLEAN consumer project and install the tarball (a real consumer install).
  consumerDir = path.join(tmpDir, 'consumer');
  fs.mkdirSync(consumerDir, { recursive: true });
  fs.writeFileSync(
    path.join(consumerDir, 'package.json'),
    JSON.stringify({ name: 'live-e2e-consumer', version: '1.0.0', type: 'module', private: true }),
  );
  run(`npm install ${tgzPath}`, consumerDir);

  pkgDir = path.join(consumerDir, 'node_modules', '@stdiobus', 'skills');
  if (!fs.existsSync(pkgDir)) throw new Error('installed package not found in consumer');

  // 3. Copy the admission harnesses into the consumer (they import ONLY from the installed package).
  for (const harness of ['mcp-admit-server.mjs', 'bus-admit-worker.mjs']) {
    fs.copyFileSync(path.join(HARNESS_DIR, harness), path.join(consumerDir, harness));
  }
});

afterAll(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('live provider-boundary E2E (installed package, both transports, real HTTPS)', () => {
  it('production installed MCP server: 5-tool surface + bundled SKILL.md byte-for-byte (Req 14.3, 15.1)', async () => {
    const serverPath = path.join(pkgDir, 'out', 'dist', 'mcp-server.mjs');
    const client = new McpStdioClient();
    try {
      await client.start('node', [serverPath], { cwd: consumerDir });
      const init = await client.initialize();
      expect(init.result?.serverInfo?.name).toBe('@stdiobus/skills');

      // Default surface is exactly the five bundled tools — admission is NOT a default tool (Req 15.3).
      const tools = (await client.listTools()).map((t) => t.name).sort();
      expect(tools).toEqual([
        'list_references',
        'list_skills',
        'read_reference',
        'read_skill',
        'search_skills',
      ]);

      // Byte-for-byte bundled read (Req 14.3): the rendered body equals the on-disk SKILL.md exactly.
      const onDisk = fs.readFileSync(
        path.join(pkgDir, 'agent-skills', BUNDLED_SKILL, 'SKILL.md'),
        'utf-8',
      );
      const result = await client.callTool('read_skill', { skill: BUNDLED_SKILL });
      const renderedBody = result.content?.[0]?.text as string;
      expect(renderedBody).toBe(onDisk);
    } finally {
      await client.stop();
    }
  });

  it('installed MCP admit surface: admit via skills.add.v1 over REAL HTTPS, read admitted back (Req 14.1, 14.2)', async () => {
    const harness = path.join(consumerDir, 'mcp-admit-server.mjs');
    const client = new McpStdioClient();
    try {
      await client.start('node', [harness, `--packageRoot=${pkgDir}`], { cwd: consumerDir });
      await client.initialize();

      // The separately-enabled admission surface exposes the five tools PLUS admit_skill.
      const tools = (await client.listTools()).map((t) => t.name);
      expect(tools).toContain('admit_skill');
      expect(tools).toContain('read_skill');

      // Admit via the production skills.add.v1 path; the acquire stage fetches over REAL HTTPS.
      const admit = await client.callTool(
        'admit_skill',
        { factoryId: 'http', namespace: 'external', url: REAL_HTTPS_URL },
        60_000,
      );
      expect(admit.isError).toBeFalsy();
      const admitted = JSON.parse(admit.content[0].text as string);
      expect(admitted.descriptor?.name).toBe(ADMITTED_SKILL_NAME);
      expect(admitted.descriptor?.provider).toBe('external');
      // Record-only content hash is present on the admitted-provider success payload (Req 8.2).
      expect(typeof admitted.contentHash).toBe('string');
      expect(admitted.contentHash.length).toBeGreaterThan(0);

      // Read the admitted skill back over MCP — resolves the in-process HTTPS provider, fetches
      // over real HTTPS, returns the real license body (Req 14.2).
      const read = await client.callTool('read_skill', { skill: ADMITTED_SKILL_NAME }, 60_000);
      expect(read.isError).toBeFalsy();
      expect(read.content[0].text as string).toContain(ADMITTED_BODY_MARKER);
    } finally {
      await client.stop();
    }
  });

  it('installed stdio Bus worker: admit + read-back + federation + bundled byte-for-byte (Req 14.2, 14.3)', async () => {
    const harness = path.join(consumerDir, 'bus-admit-worker.mjs');
    const bus = new BusStdioClient();
    try {
      await bus.start('node', [harness, `--packageRoot=${pkgDir}`], consumerDir);

      // Bundled byte-for-byte over the bus transport (same runtime composition, same content).
      const onDisk = fs.readFileSync(
        path.join(pkgDir, 'agent-skills', BUNDLED_SKILL, 'SKILL.md'),
        'utf-8',
      );
      const bundledRead = await bus.request<any>(M_READ, { ref: { kind: 'name', name: BUNDLED_SKILL } });
      expect(bundledRead.ok).toBe(true);
      expect(bundledRead.data.body).toBe(onDisk);

      // Admit the external provider via the PRODUCTION skills.add.v1 path over the bus (real HTTPS).
      const admit = await bus.request<any>(M_ADD, {
        factoryId: 'http',
        namespace: 'external',
        config: { url: REAL_HTTPS_URL, maxContentBytes: 1_000_000, timeoutMs: 30_000 },
      });
      expect(admit.ok).toBe(true);
      expect(admit.data.descriptor.name).toBe(ADMITTED_SKILL_NAME);

      // Read the admitted skill back over the bus (Req 14.2).
      const admittedRead = await bus.request<any>(M_READ, {
        ref: { kind: 'name', name: ADMITTED_SKILL_NAME },
      });
      expect(admittedRead.ok).toBe(true);
      expect(admittedRead.data.body).toContain(ADMITTED_BODY_MARKER);

      // Federation: list aggregates the bundled provider AND the admitted provider (Req 14.2).
      const list = await bus.request<any>(M_LIST, {});
      expect(list.ok).toBe(true);
      const names = list.data.map((d: any) => d.name);
      expect(names).toContain(BUNDLED_SKILL);
      expect(names).toContain(ADMITTED_SKILL_NAME);
      const fqids = list.data.map((d: any) => d.fqid);
      expect(fqids).toContain(`external:${ADMITTED_SKILL_NAME}`);
    } finally {
      await bus.stop();
    }
  });

  it('installed stdio Bus worker: quarantine paths return typed quarantined results (Req 14.5)', async () => {
    const harness = path.join(consumerDir, 'bus-admit-worker.mjs');
    const bus = new BusStdioClient();
    try {
      await bus.start('node', [harness, `--packageRoot=${pkgDir}`], consumerDir);

      // (a) Invalid config — a non-HTTPS url is rejected at the `validate` stage BEFORE any
      //     network call, returned as a typed `quarantined` envelope (cause: bad_request). No fetch.
      const invalidConfig = await bus.request<any>(M_ADD, {
        factoryId: 'http',
        namespace: 'attacker-ns',
        config: { url: 'http://insecure.example.com/x', maxContentBytes: 1_000_000, timeoutMs: 30_000 },
      });
      expect(invalidConfig.ok).toBe(false);
      expect(invalidConfig.error.code).toBe('quarantined');
      expect(invalidConfig.error.stage).toBe('validate');
      expect(invalidConfig.error.cause.code).toBe('bad_request');

      // (b) Namespace spoof — claiming the reserved first-party `bundled` namespace is rejected at
      //     the `admit` stage (anti-spoofing, Req 5.3), returned as a typed `quarantined` envelope.
      const spoof = await bus.request<any>(M_ADD, {
        factoryId: 'http',
        namespace: 'bundled',
        config: { url: REAL_HTTPS_URL, maxContentBytes: 1_000_000, timeoutMs: 30_000 },
      });
      expect(spoof.ok).toBe(false);
      expect(spoof.error.code).toBe('quarantined');
      expect(spoof.error.stage).toBe('admit');
      expect(spoof.error.cause.code).toBe('bad_request');

      // The registry stays unchanged after quarantine: the spoofed source is NOT listed (Req 9.3).
      const list = await bus.request<any>(M_LIST, {});
      expect(list.ok).toBe(true);
      const fqids = list.data.map((d: any) => d.fqid);
      expect(fqids).not.toContain(`bundled:${ADMITTED_SKILL_NAME}`);
    } finally {
      await bus.stop();
    }
  });
});
