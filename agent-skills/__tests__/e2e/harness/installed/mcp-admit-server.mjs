/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Installed-package admission-capable MCP stdio server (live-E2E harness, Task 11.2).
 *
 * This file is COPIED into the clean consumer project by the live-E2E test and run with
 * `node` (cwd = consumer). It imports ONLY from the INSTALLED package — `@stdiobus/skills/runtime`
 * (the advanced runtime-composition subpath) — so it exercises the SHIPPED artifacts, never the
 * source tree. It is a SEPARATELY-ENABLED admission surface (Req 15.3): the default installed
 * `@stdiobus/skills/mcp-server` still exposes only the five bundled tools; this harness adds a
 * sixth `admit_skill` tool that is a THIN TRANSPORT SHIM into the real `skills.add.v1` capability
 * seam — it calls `runtime.request(AdmissionCapabilities.add, raw)`, the production in-process
 * admission path, and holds no admission logic of its own.
 *
 * Composition (identical placement model to the production bus worker):
 *   - the bundled FilesystemSkillProvider seeds a MutableProviderView;
 *   - the SAME view backs both the InProcessSkillsRuntime AND the AdmissionController, so an
 *     admitted provider is materialized IN-PROCESS and becomes visible to the next runtime
 *     operation with NO new worker and NO second StdioBus spawned;
 *   - the HTTPS blueprint is the one external factory; the no-credential adapter is the default.
 *
 * STDOUT is the JSON-RPC / NDJSON protocol channel; ALL diagnostics go to STDERR.
 */

import { z } from 'zod';
import {
  AdmissionCapabilities,
  AdmissionCapabilityHandler,
  AdmissionController,
  FilesystemSkillProvider,
  HttpSkillProviderBlueprint,
  InProcessSkillsRuntime,
  MutableProviderView,
  NamespaceOwnershipTable,
  OperationBudget,
  ProviderBlueprintRegistry,
  Sha256ContentHasher,
  COMPAT_RENDER_OPTIONS,
  buildSkillsMcpServer,
  createFileResolver,
  describeError,
  serveMcpStdio,
} from '@stdiobus/skills/runtime';

/** Per-operation admission budget (ms) — bounds the whole pipeline; matches the bus worker. */
const ADMISSION_BUDGET_MS = 30_000;

function readArg(flag) {
  const prefix = `--${flag}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function diag(message) {
  process.stderr.write(`[mcp-admit-server] ${message}\n`);
}

async function main() {
  const packageRoot = readArg('packageRoot');
  if (!packageRoot) {
    diag('fatal: missing required --packageRoot=<path> argument');
    process.exit(2);
  }

  // --- Composition (in-process placement; no new worker/bus) ---
  const resolver = createFileResolver(packageRoot);
  const bundled = new FilesystemSkillProvider({ search: true, packageRoot });
  const view = new MutableProviderView([bundled]);
  const namespaces = new NamespaceOwnershipTable();

  const blueprints = new ProviderBlueprintRegistry();
  blueprints.register(new HttpSkillProviderBlueprint());
  const controller = new AdmissionController(
    blueprints,
    view,
    namespaces,
    new OperationBudget(ADMISSION_BUDGET_MS),
    new Sha256ContentHasher(),
  );
  const admissionHandler = new AdmissionCapabilityHandler(controller);

  // The runtime reads from the SAME view the admission `register` stage mutates, and is wired
  // with the optional in-process admission seam so `request(skills.add.v1, ...)` is the real path.
  const runtime = new InProcessSkillsRuntime(view, undefined, undefined, admissionHandler);

  const manifest = await resolver.readManifest();
  const publishedSkills = new Set(manifest.skills.map((s) => s.name));

  // The five production tools through the SAME shared builder the production executable uses.
  const server = buildSkillsMcpServer({
    name: '@stdiobus/skills-e2e-admit',
    version: manifest.version,
    runtime,
    manifest,
    publishedSkills,
    renderOpts: COMPAT_RENDER_OPTIONS,
  });

  // Sixth tool: a THIN shim into the real `skills.add.v1` capability seam (Req 15.3 separately-
  // enabled surface). It builds the raw wire descriptor and delegates to `runtime.request`; the
  // runtime normalizes + admits through the production AdmissionController. No admission logic here.
  server.registerTool(
    'admit_skill',
    {
      description: 'Admit an external skill provider via the production skills.add.v1 path',
      inputSchema: {
        factoryId: z.string().min(1),
        namespace: z.string().min(1),
        url: z.string().min(1),
        maxContentBytes: z.number().optional(),
        timeoutMs: z.number().optional(),
      },
    },
    async (args) => {
      const raw = {
        factoryId: args.factoryId,
        namespace: args.namespace,
        config: {
          url: args.url,
          maxContentBytes: args.maxContentBytes ?? 1_000_000,
          timeoutMs: args.timeoutMs ?? ADMISSION_BUDGET_MS,
        },
      };
      const resp = await runtime.request(AdmissionCapabilities.add, raw);
      if (resp.ok) {
        return { content: [{ type: 'text', text: JSON.stringify(resp.data) }] };
      }
      return {
        content: [{ type: 'text', text: describeError(resp.error) }],
        isError: true,
      };
    },
  );

  await serveMcpStdio(server);
  diag(`ready (packageRoot=${packageRoot})`);
}

main().catch((err) => {
  process.stderr.write(`[mcp-admit-server] fatal error: ${err}\n`);
  process.exit(1);
});
