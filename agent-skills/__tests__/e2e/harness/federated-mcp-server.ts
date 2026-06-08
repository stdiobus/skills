/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Federated MCP server harness (e2e composition root, run via `tsx` as ESM).
 *
 * A THIN composition root — deliberately not an alternate server implementation. It wires
 * a real federated {@link SkillProviderRegistry} (bundled + a developer-sandbox provider)
 * into the real in-process {@link createRuntimeFromRegistry} runtime, then builds the
 * 5-tool MCP surface through the SAME {@link buildSkillsMcpServer} the production executable
 * uses and connects the real `StdioServerTransport`. Nothing here is mocked: real providers,
 * real runtime, real MCP SDK transport, real filesystem.
 *
 * The only difference from production is the registry composition: production registers the
 * bundled provider alone; this harness adds a second `FilesystemSkillProvider` rooted at the
 * sandbox package created by the e2e test. The sandbox root is passed as a CLI argument
 * (`--sandbox=<path>`) so it is robust regardless of environment inheritance.
 *
 * STDOUT is the JSON-RPC / NDJSON protocol channel and stays protocol-only; ALL diagnostics
 * go to STDERR.
 *
 * ─── Sandbox provider search mode ────────────────────────────────────────────────────
 * The bundled provider enables NATIVE keyword search (`search: true`), preserving published
 * ranking exactly as production does. The sandbox provider intentionally uses the runtime's
 * list+substring search FALLBACK (`search: false`). Native search builds an all-or-nothing
 * keyword index over EVERY manifest skill, so a deliberately-missing `SKILL.md` (the
 * failure-containment edge case) would make a native index build fail as a whole and make
 * the sandbox contribute nothing to federated search. The list+substring fallback resolves
 * names without reading bodies, so it is resilient to the broken skill AND still surfaces
 * sandbox skills by name through `runtime.search()` — the genuinely federation-correct,
 * failure-contained path.
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createFileResolver } from '../../../lib/file-resolver.js';
import { buildSkillsMcpServer } from '../../../lib/build-server.js';
import { COMPAT_RENDER_OPTIONS } from '../../../lib/tool-render.js';
import { FilesystemSkillProvider } from '../../../runtime/providers/filesystem-provider.js';
import { SkillProviderRegistry, createRuntimeFromRegistry } from '../../../runtime/registry.js';
import { bundledTrustPolicy } from '../../../runtime/trust.js';

/** Read a `--flag=value` argument from argv, or return undefined when absent. */
function readArg(flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function diag(message: string): void {
  process.stderr.write(`[federated-mcp-server] ${message}\n`);
}

async function main(): Promise<void> {
  const sandboxRoot = readArg('sandbox');
  if (!sandboxRoot) {
    diag('fatal: missing required --sandbox=<path> argument');
    process.exit(2);
  }

  // The repo (package) root is four levels up: harness -> e2e -> __tests__ -> agent-skills.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(here, '..', '..', '..', '..');

  // Bundled provider (NATIVE search) + sandbox provider (list+substring fallback search),
  // in precedence order [bundled, sandbox]. Both are REAL FilesystemSkillProviders over
  // real on-disk package roots.
  const bundledResolver = createFileResolver(packageRoot);
  const registry = new SkillProviderRegistry([
    {
      provider: new FilesystemSkillProvider({ search: true, packageRoot }),
      trust: bundledTrustPolicy(packageRoot),
    },
    {
      provider: new FilesystemSkillProvider({ id: 'sandbox', packageRoot: sandboxRoot, search: false }),
      trust: bundledTrustPolicy(sandboxRoot),
    },
  ]);
  const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

  // The published manifest registry document (rendered by list_skills) and the published
  // skill-name set (gates ONLY the open-world warning) come from the BUNDLED manifest.
  const manifest = await bundledResolver.readManifest();
  const publishedSkills: ReadonlySet<string> = new Set(manifest.skills.map((s) => s.name));

  const server = buildSkillsMcpServer({
    name: '@stdiobus/skills-e2e-federated',
    version: manifest.version,
    runtime,
    manifest,
    publishedSkills,
    renderOpts: COMPAT_RENDER_OPTIONS,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  diag(`ready (packageRoot=${packageRoot}, sandbox=${sandboxRoot})`);
}

main().catch((err) => {
  process.stderr.write(`[federated-mcp-server] fatal error: ${err}\n`);
  process.exit(1);
});
