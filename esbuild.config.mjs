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
      js: [
        '#!/usr/bin/env node',
        'import { fileURLToPath as __mcp_fileURLToPath } from "node:url";',
        'import { dirname as __mcp_dirname } from "node:path";',
        'const __filename = __mcp_fileURLToPath(import.meta.url);',
        'const __dirname = __mcp_dirname(__filename);',
      ].join('\n'),
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
