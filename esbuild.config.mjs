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

const runtimeExternals = [];

const external = [...nodeBuiltins, ...runtimeExternals];

// ─── Build targets ──────────────────────────────────────────────

const targets = {
  esm: {
    label: 'ESM Bundle',
    entryPoints: ['agent-skills/index.ts'],
    outfile: 'out/dist/index.js',
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
