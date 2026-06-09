/**
 * @stdiobus/skills — esbuild build configuration
 *
 * Single bundled output per target. tsc handles .d.ts separately.
 *
 * Entry: src/index.ts → dist/index.js
 * All internal modules bundled. External deps resolved at runtime.
 */

import { build } from 'esbuild';
import { builtinModules } from 'node:module';

// ─── Externals ──────────────────────────────────────────────────

const nodeBuiltins = builtinModules.flatMap(m => [m, `node:${m}`]);

// Native addons MUST stay external — esbuild cannot inline a `.node` binary, and
// @stdiobus/node resolves its prebuilt binary relative to its own package dir
// (`__dirname/../../prebuilds`). Bundling it would break that path resolution and crash
// the addon load at startup. It is a runtime `dependency`, resolved from node_modules.
const runtimeExternals = ['@stdiobus/node'];

const external = [...nodeBuiltins, ...runtimeExternals];

// The advanced runtime-composition subpath (`@stdiobus/skills/runtime`) additionally keeps
// the heavy declared dependencies EXTERNAL (resolved from the consumer's node_modules at
// runtime, where they are installed transitively) so the bundle stays small and the
// published tarball stays well under its size budget. The MCP server bundle deliberately
// inlines the SDK for a self-contained executable; the library subpath does not need to.
const runtimeSubpathExternal = [
  ...external,
  '@modelcontextprotocol/sdk',
  '@modelcontextprotocol/sdk/*',
  'zod',
];

// ─── Shared ESM banner ──────────────────────────────────────────
//
// `createFileResolver` resolves the installed package root from `__dirname`
// (`path.resolve(__dirname, '..', '..')`). esbuild's ESM output does NOT define
// `__dirname`/`__filename`, so any bundle whose code path reaches `createFileResolver`
// must reconstruct them from `import.meta.url`. Both the MCP server and the stdio Bus
// worker reach it, so the definition is factored here to keep the two banners in sync.
const esmDirnameBanner = [
  'import { fileURLToPath as __kiro_fileURLToPath } from "node:url";',
  'import { dirname as __kiro_dirname } from "node:path";',
  'const __filename = __kiro_fileURLToPath(import.meta.url);',
  'const __dirname = __kiro_dirname(__filename);',
].join('\n');

// ─── Build targets ──────────────────────────────────────────────

const targets = {
  esm: {
    label: 'ESM Bundle',
    entryPoints: ['agent-skills/index.ts'],
    outfile: 'out/dist/index.mjs',
    bundle: true,
    platform: 'node',
    target: ['node20'],
    format: 'esm',
    treeShaking: true,
    minify: true,
    sourcemap: false,
    external,
    loader: { '.json': 'json' },
    logLevel: 'info',
  },
  'mcp-server': {
    label: 'MCP Server',
    entryPoints: ['agent-skills/mcp-server.ts'],
    outfile: 'out/dist/mcp-server.mjs',
    bundle: true,
    platform: 'node',
    target: ['node20'],
    format: 'esm',
    treeShaking: true,
    minify: true,
    sourcemap: false,
    external,
    banner: {
      js: ['#!/usr/bin/env node', esmDirnameBanner].join('\n'),
    },
    loader: { '.json': 'json' },
    logLevel: 'info',
  },
  runtime: {
    label: 'Runtime Composition API',
    entryPoints: ['agent-skills/runtime-bootstrap.ts'],
    outfile: 'out/dist/runtime.mjs',
    bundle: true,
    platform: 'node',
    target: ['node20'],
    format: 'esm',
    treeShaking: true,
    minify: true,
    sourcemap: false,
    external: runtimeSubpathExternal,
    // The runtime composition bundle reaches `__dirname` on two code paths: indirectly via
    // `createFileResolver` (bundled skill-asset resolution) and directly via
    // `createDefaultBus` (B6.2 — resolving the sibling `out/dist/bus-worker.mjs`). esbuild's
    // ESM output does not define `__dirname`, so this bundle needs the same shim the MCP
    // server and bus-worker targets carry.
    banner: {
      js: esmDirnameBanner,
    },
    loader: { '.json': 'json' },
    logLevel: 'info',
  },
  'bus-worker': {
    label: 'stdio Bus Worker',
    entryPoints: ['agent-skills/runtime/transport/bus-worker.ts'],
    outfile: 'out/dist/bus-worker.mjs',
    bundle: true,
    platform: 'node',
    target: ['node20'],
    format: 'esm',
    treeShaking: true,
    minify: true,
    sourcemap: false,
    // `@stdiobus/node` stays external like every other runtime/bus target: its prebuilt
    // native addon resolves relative to its own package dir, so it must not be inlined.
    external,
    // No shebang: this worker is spawned as `process.execPath out/dist/bus-worker.mjs`
    // (B6.2), never executed directly. The `__dirname` definition is required because the
    // worker resolves its packageRoot through `createFileResolver` (same as the MCP server).
    banner: {
      js: esmDirnameBanner,
    },
    loader: { '.json': 'json' },
    logLevel: 'info',
  },
};

// ─── Runner ─────────────────────────────────────────────────────

const targetFilter = process.argv[2];

for (const [name, config] of Object.entries(targets)) {
  if (targetFilter && name !== targetFilter) continue;

  const { label, ...buildConfig } = config;
  const startMs = Date.now();

  await build(buildConfig);

  const elapsed = Date.now() - startMs;
  console.log(`  ✓ ${label ?? name} → ${buildConfig.outfile ?? buildConfig.outdir} (${elapsed}ms)`);
}

console.log('\nesbuild: build complete');
