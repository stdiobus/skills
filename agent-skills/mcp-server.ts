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
 *   - `list_skills` serves the manifest document `JSON.stringify(manifest, null, 2)`
 *     unchanged — this is the published list contract (a registry document, NOT the
 *     runtime's `SkillDescriptor[]`), so it is served from the manifest source directly.
 *   - `search_skills` keeps the existing keyword search index, preserving the published
 *     result shape and ranking (the bundled provider declares `search: false`, so the
 *     runtime would otherwise fall back to list+substring and change ranking).
 *   - Provenance is NOT surfaced at the MCP response level (Req 9.7); the renderers emit
 *     only the typed `data`, never the provenance envelope.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createFileResolver } from './lib/file-resolver.js';
import { buildSearchIndex } from './lib/search-index.js';
import { handleListSkills } from './tools/list-skills.js';
import { handleSearchSkills } from './tools/search-skills.js';
import { FilesystemSkillProvider } from './runtime/providers/filesystem-provider.js';
import { SkillProviderRegistry, createRuntimeFromRegistry } from './runtime/registry.js';
import { bundledTrustPolicy } from './runtime/trust.js';
import type { SkillRef, SkillRuntimeError } from './runtime/contract.js';

/** MCP tool result shape (unchanged from the pre-migration contract). */
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/**
 * Open-world skill-name schema (Req 1.6, 9.1, 9.6).
 *
 * Replaces the pre-migration `z.enum(VALID_SKILLS)` gate. Any non-empty string is valid
 * input; resolution and the open-world / `not_found` decision move into the runtime. The
 * tool's input parameter key set is unchanged — only the validator is relaxed.
 */
const skillParam = z.string().min(1);

// ---------------------------------------------------------------------------
// SkillResponse → MCP output rendering (provenance stripped per Req 9.7)
// ---------------------------------------------------------------------------

/** Human-facing label for a {@link SkillRef} in a rendered error. */
function refLabel(ref: SkillRef): string {
  switch (ref.kind) {
    case 'name':
      return `"${ref.name}"`;
    case 'fqid':
      return `"${ref.fqid}"`;
    case 'descriptor':
      return `"${ref.descriptor.name}"`;
  }
}

/** Render a typed {@link SkillRuntimeError} into a single diagnostic line. */
function describeError(error: SkillRuntimeError): string {
  switch (error.code) {
    case 'not_found':
      return `skill not found: ${refLabel(error.ref)}`;
    case 'ambiguous':
      return `ambiguous skill ${refLabel(error.ref)} resolves to ${error.candidates.length} candidates`;
    case 'unsupported':
      return error.provider
        ? `capability "${error.capability}" is not supported by provider "${error.provider}"`
        : `capability "${error.capability}" is not supported`;
    case 'provider_error':
      return error.message;
    case 'bad_request':
      return error.issues.join('; ');
    case 'out_of_bounds':
      return error.detail;
    case 'content_too_large':
      return `content exceeds the maximum size of ${error.limitBytes} bytes`;
    case 'isolation_failed':
      return error.reason;
    case 'aggregate_error':
      return error.failures.map((f) => `${f.provider}: ${describeError(f.error)}`).join('; ');
  }
}

/** Render a typed runtime error as an MCP tool error (`isError: true`). */
function renderError(tool: string, error: SkillRuntimeError): ToolResult {
  return {
    content: [{ type: 'text', text: `${tool}: ${describeError(error)}` }],
    isError: true,
  };
}

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
  const provider = new FilesystemSkillProvider();
  // The bundled (first-party) provider registers as `trusted` (design §9, Req 11.1) with
  // `permittedRoot` = the package root, so the runtime's path-traversal boundary (Task 9.2,
  // Req 11.4) rejects any reference path that escapes the package as a returned
  // `out_of_bounds` error. This is internal registration metadata only — it is not surfaced
  // at MCP tool output, and valid published reference reads stay byte-for-byte identical.
  const registry = new SkillProviderRegistry([
    { provider, trust: bundledTrustPolicy(resolver.packageRoot) },
  ]);
  const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

  // The manifest document (for `list_skills`) and the keyword search index (for
  // `search_skills`) are served from the manifest source directly — these are the
  // published document/search contracts, not skill-name resolution. The adapter holds
  // no name-resolution logic of its own.
  const manifest = await resolver.readManifest();

  // Published set (Req 9.6): the manifest's skill names. Used ONLY to decide whether to
  // emit the non-fatal open-world warning — never as a resolution/allow-list gate.
  const publishedSkills: ReadonlySet<string> = new Set(manifest.skills.map((s) => s.name));

  // Pre-load all SKILL.md contents for the search index (unchanged behavior).
  const skillContents = new Map<string, string>();
  for (const skill of manifest.skills) {
    skillContents.set(skill.name, await resolver.readSkill(skill.name));
  }
  const searchIndex = buildSearchIndex(manifest, skillContents);

  const server = new McpServer(
    { name: '@stdiobus/skills', version: manifest.version },
    { capabilities: { tools: {} } },
  );

  // --- Tool registrations ---

  // list_skills: serve the manifest registry document byte-for-byte (published list
  // contract — NOT the runtime's SkillDescriptor[]).
  server.registerTool(
    'list_skills',
    {
      description: 'List all available skills with their layers and metadata',
      inputSchema: {},
    },
    async () => handleListSkills(resolver),
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
      if (resp.ok) {
        return { content: [{ type: 'text', text: resp.data.body }] };
      }
      return renderError('read_skill', resp.error);
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
      if (resp.ok) {
        const paths = resp.data.map((d) => d.path);
        return { content: [{ type: 'text', text: JSON.stringify(paths) }] };
      }
      return renderError('list_references', resp.error);
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
      if (resp.ok) {
        return { content: [{ type: 'text', text: resp.data.body }] };
      }
      return renderError('read_reference', resp.error);
    },
  );

  // search_skills: keep the existing keyword search index (preserves result shape/ranking).
  server.registerTool(
    'search_skills',
    {
      description: 'Search skills by keyword or topic',
      inputSchema: { query: z.string().min(1) },
    },
    async (args) => handleSearchSkills(args, searchIndex),
  );

  // --- Connect transport ---

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP server fatal error: ${err}\n`);
  process.exit(1);
});
