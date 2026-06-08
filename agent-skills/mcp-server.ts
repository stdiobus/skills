/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MCP Skills Server — standalone executable (thin adapter).
 *
 * Exposes the 12 agent skills, their reference materials, and the skills
 * manifest as five MCP tools over stdio transport (JSON-RPC 2.0 / NDJSON).
 *
 * Start: `node out/dist/mcp-server.mjs`
 * Or:    `npx @stdiobus/skills`
 *
 * ─── Delegate-only adapter (Migration Step 3 — design §1, Req 9.4) ─────────────────
 *
 * Authority lives in the {@link SkillsRuntime}, not here. This adapter only:
 *   1. translates a tool call into a {@link SkillRef} / capability input,
 *   2. delegates to a transport-selected {@link SkillsRuntime}
 *      (default in-process, obtained from the provider registry), and
 *   3. renders the returned {@link SkillResponse} back to MCP tool output.
 *
 * The closed-world `z.enum(VALID_SKILLS)` gate is replaced with open-world
 * `z.string().min(1)` (Req 1.6, 9.1, 9.6): a non-published skill name is accepted as
 * input and, if no provider resolves it, surfaces as a typed `not_found` rendered as a
 * tool error (`isError: true`) — never a schema rejection or process termination.
 *
 * Open-world warning (Req 9.6): when a skill-addressing tool (`read_skill`,
 * `list_references`, `read_reference`) receives a `skill` name that is not in the
 * published set (the manifest's skill names), the adapter emits a non-fatal warning to
 * STDERR (the diagnostics channel). STDOUT stays strictly protocol-only (JSON-RPC /
 * NDJSON). Published-set membership decides ONLY whether to warn — it is never a
 * resolution gate: the call still delegates to the runtime and an unresolved name still
 * returns typed `not_found`. Published names emit no warning.
 *
 * Backward compatibility during the compatibility phase (Req 9.1, 9.2, 9.7, 9.8):
 *   - `read_skill` of a published name renders `SkillContent.body` raw — byte-for-byte
 *     identical, because the bundled provider reuses the same `FileResolver`.
 *   - `list_references` renders `JSON.stringify(paths)` (the same JSON array of paths).
 *   - `read_reference` renders the raw file body and preserves the `..` traversal guard.
 *   - `list_skills` delegates to `runtime.list()` and renders the result through the
 *     `ManifestPresenter`, which reconstructs the published manifest registry document
 *     (`JSON.stringify(manifest, null, 2)`) from the runtime's AUTHORITATIVE skill set —
 *     byte-for-byte identical because the bundled provider lists exactly the manifest
 *     skills in manifest order (Req 9.4, 9.8).
 *   - `search_skills` delegates to `runtime.search()` and renders the result through the
 *     `SearchPresenter`, preserving the published `{skill,score,description,layer,
 *     layerName}` shape and ranking. The legacy keyword index is now the bundled provider's
 *     native `search` implementation (enabled via `{ search: true }`), NOT an adapter
 *     side-channel (Req 9.4, 9.1).
 *   - Provenance is NOT surfaced at the MCP response level (Req 9.7); the renderers emit
 *     only the typed `data`, never the provenance envelope.
 *
 * ─── Staged provenance exposure (Migration Step 9 — design §1, §"Migration / Rollout
 *     Sequence" step 9, Req 9.7, 9.9) ───────────────────────────────────────────────
 *
 * Provenance exposure at the MCP response level is an OPT-IN, DECLARED, VERSIONED staged
 * change — never an implicit mutation of the existing shape (Req 9.9). It is governed by a
 * single declared flag {@link AdapterRenderOptions.exposeProvenance}, sourced for the
 * standalone executable from the {@link EXPOSE_PROVENANCE_ENV} environment variable and
 * DEFAULTING OFF (Req 9.7):
 *
 *   - OFF (default): the body/reference renderers emit output BYTE-IDENTICAL to the
 *     compatibility phase (raw body for `read_skill`/`read_reference`; a JSON string array
 *     for `list_references`). No provenance leaks into MCP output.
 *   - ON (explicit opt-in): the runtime-backed body/reference tools emit the declared
 *     `provenance.v1` envelope ({@link PROVENANCE_SHAPE_VERSION}) that ADDS provenance
 *     alongside the existing content:
 *       · `read_skill` / `read_reference` → `{ version, body, provenance }`
 *       · `list_references`              → `{ version, references, provenance }`
 *     where `provenance` is the declared minimum identity set `{ fqid, provider, source }`
 *     plus the optional `resolvedFrom`.
 *
 * `list_skills` (serves the manifest registry document) and `search_skills` (serves the
 * keyword index) are UNAFFECTED by the flag: both delegate to the runtime, but neither is
 * backed by a single runtime `SkillResponse` provenance envelope (one renders an aggregate
 * registry document, the other a ranked list), so there is nothing to stage for them. The
 * staged shape applies only to the runtime-backed body/reference tools `read_skill`,
 * `list_references`, and `read_reference`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createFileResolver } from './lib/file-resolver.js';
import {
  COMPAT_RENDER_OPTIONS,
  EXPOSE_PROVENANCE_ENV,
  PROVENANCE_SHAPE_VERSION,
  renderListReferences,
  renderReadReference,
  renderReadSkill,
  resolveExposeProvenance,
  type AdapterRenderOptions,
  type ToolResult,
} from './lib/tool-render.js';
import { presentManifest } from './lib/manifest-presenter.js';
import { presentSearch } from './lib/search-presenter.js';
import { FilesystemSkillProvider } from './runtime/providers/filesystem-provider.js';
import { SkillProviderRegistry, createRuntimeFromRegistry } from './runtime/registry.js';
import { bundledTrustPolicy } from './runtime/trust.js';

/**
 * Open-world skill-name schema (Req 1.6, 9.1, 9.6).
 *
 * Replaces the pre-migration `z.enum(VALID_SKILLS)` gate. Any non-empty string is valid
 * input; resolution and the open-world / `not_found` decision move into the runtime. The
 * tool's input parameter key set is unchanged — only the validator is relaxed.
 */
const skillParam = z.string().min(1);

/**
 * Emit the Req 9.6 non-fatal open-world warning (diagnostics channel only).
 *
 * Membership in the published set decides ONLY whether to warn — it is never a
 * resolution gate. The caller still delegates to the runtime regardless, and an
 * unresolved name still surfaces as a typed `not_found` (Req 9.6, 1.6).
 *
 * The warning is written to STDERR, never STDOUT: STDOUT is the JSON-RPC / NDJSON
 * protocol channel and must stay protocol-only. Published names emit no warning.
 */
function warnIfUnpublished(tool: string, name: string, published: ReadonlySet<string>): void {
  if (!published.has(name)) {
    process.stderr.write(
      `${tool}: warning — open-world skill name "${name}" is not in the published set\n`,
    );
  }
}

async function main(): Promise<void> {
  // Bundled provider + registry → transport-selected runtime (default in-process).
  // The provider reuses the existing FileResolver, so published-name reads are
  // byte-for-byte identical (Req 3.6, 9.2).
  const resolver = createFileResolver();
  // Enable the bundled provider's NATIVE search so `runtime.search()` serves the keyword
  // index (preserving published ranking) instead of the list+substring fallback (Req 9.4).
  const provider = new FilesystemSkillProvider({ search: true });
  // The bundled (first-party) provider registers as `trusted` (design §9, Req 11.1). The
  // runtime's path-traversal boundary (Task 9.2/23, Req 11.4) enforces containment against
  // the provider's DECLARED resource root (`resourceRoot` → the resolved skill's references
  // directory), so it rejects any reference path that escapes that skill's references root —
  // including a cross-skill path with no `..` — as a returned `out_of_bounds` error. The
  // coarse `permittedRoot` = package root is retained only as a backstop for paths the
  // provider does not scope. This is internal registration metadata only — it is not
  // surfaced at MCP tool output, and valid published reference reads stay byte-for-byte
  // identical.
  const registry = new SkillProviderRegistry([
    { provider, trust: bundledTrustPolicy(resolver.packageRoot) },
  ]);
  const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

  // The published manifest registry document (rendered by `list_skills`) is read from the
  // manifest source: it is the published document template whose per-entry metadata
  // (`versionRange`/`status`/…) is not carried on runtime descriptors. The runtime remains
  // AUTHORITATIVE for membership/order via `runtime.list()`; the manifest only supplies the
  // document fields the `ManifestPresenter` joins back (Req 9.8). The adapter holds no
  // name-resolution logic of its own.
  const manifest = await resolver.readManifest();

  // Published set (Req 9.6): the manifest's skill names. Used ONLY to decide whether to
  // emit the non-fatal open-world warning — never as a resolution/allow-list gate.
  const publishedSkills: ReadonlySet<string> = new Set(manifest.skills.map((s) => s.name));

  // Staged provenance exposure (Task 11.1, Req 9.7/9.9): DEFAULT OFF. Sourced from the
  // declared EXPOSE_PROVENANCE_ENV for the standalone executable. When off, the renderers
  // produce output byte-identical to the compatibility phase; when on, they produce the
  // declared `provenance.v1` staged shape. This is the single, declared opt-in point.
  const renderOpts: AdapterRenderOptions = { exposeProvenance: resolveExposeProvenance() };
  if (renderOpts.exposeProvenance) {
    process.stderr.write(
      `staged provenance exposure ENABLED (${PROVENANCE_SHAPE_VERSION}) via ${EXPOSE_PROVENANCE_ENV}\n`,
    );
  }

  const server = new McpServer(
    { name: '@stdiobus/skills', version: manifest.version },
    { capabilities: { tools: {} } },
  );

  // --- Tool registrations ---

  // list_skills: delegate to the runtime; render the AUTHORITATIVE descriptor list back
  // into the published manifest registry document (byte-for-byte for the bundled set).
  server.registerTool(
    'list_skills',
    {
      description: 'List all available skills with their layers and metadata',
      inputSchema: {},
    },
    async (): Promise<ToolResult> => presentManifest(await runtime.list(), manifest),
  );

  // read_skill: delegate to the runtime; render SkillContent.body raw.
  server.registerTool(
    'read_skill',
    {
      description: 'Read the full SKILL.md content for a specific skill',
      inputSchema: { skill: skillParam },
    },
    async (args): Promise<ToolResult> => {
      warnIfUnpublished('read_skill', args.skill, publishedSkills);
      const resp = await runtime.read({ ref: { kind: 'name', name: args.skill } });
      return renderReadSkill(resp, renderOpts);
    },
  );

  // list_references: delegate to the runtime; render JSON array of reference paths.
  server.registerTool(
    'list_references',
    {
      description: 'List reference files available for a specific skill',
      inputSchema: { skill: skillParam },
    },
    async (args): Promise<ToolResult> => {
      warnIfUnpublished('list_references', args.skill, publishedSkills);
      const resp = await runtime.getReferences({ ref: { kind: 'name', name: args.skill } });
      return renderListReferences(resp, renderOpts);
    },
  );

  // read_reference: preserve the directory-traversal guard, then delegate; render body raw.
  server.registerTool(
    'read_reference',
    {
      description: 'Read a specific reference file for a skill',
      inputSchema: {
        skill: skillParam,
        reference: z.string().min(1),
      },
    },
    async (args): Promise<ToolResult> => {
      warnIfUnpublished('read_reference', args.skill, publishedSkills);
      // Security guard (read-only, no name-resolution): reject traversal before delegating,
      // preserving the existing observable error text byte-for-byte.
      if (args.reference.includes('..')) {
        return {
          content: [
            {
              type: 'text',
              text: 'read_reference: Invalid reference path — directory traversal ("..") is not allowed.',
            },
          ],
          isError: true,
        };
      }
      const resp = await runtime.readReference({
        ref: { kind: 'name', name: args.skill },
        reference: args.reference,
      });
      return renderReadReference(resp, renderOpts);
    },
  );

  // search_skills: delegate to the runtime; render the ranked results back into the
  // published result shape. Ranking comes from the bundled provider's native keyword index
  // (enabled above), so `runtime.search()` preserves the published ordering (Req 9.4).
  server.registerTool(
    'search_skills',
    {
      description: 'Search skills by keyword or topic',
      inputSchema: { query: z.string().min(1) },
    },
    async (args): Promise<ToolResult> => {
      // Input validation (NOT name resolution): preserve the pre-migration non-empty-query
      // contract — a whitespace-only query is a tool error, not a delegated search.
      if (args.query.trim().length === 0) {
        return {
          content: [{ type: 'text', text: 'search_skills: Query must be a non-empty string.' }],
          isError: true,
        };
      }
      return presentSearch(await runtime.search({ query: args.query }));
    },
  );

  // --- Connect transport ---

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP server fatal error: ${err}\n`);
  process.exit(1);
});
