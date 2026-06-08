/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Skills MCP server builder — the single, shared 5-tool wiring (extraction of the
 * `server.registerTool(...)` body previously inlined in `mcp-server.ts`).
 *
 * ─── Why this exists ────────────────────────────────────────────────────────────────
 *
 * The production executable (`mcp-server.ts`) and the e2e federation harness
 * (`__tests__/e2e/harness/federated-mcp-server.ts`) must build the SAME MCP server
 * surface through the SAME real code path — otherwise the e2e suite would prove a
 * parallel re-implementation, not the shipped wiring. This module is a PURE extraction:
 * it performs EXACTLY the five `registerTool` registrations that `mcp-server.ts` did,
 * with identical schemas, identical open-world warning, and identical traversal guard.
 * It introduces NO behavior change — the production executable simply calls it after
 * building the runtime/manifest/publishedSkills/renderOpts exactly as before, then
 * connects the transport itself.
 *
 * Authority lives in the {@link SkillsRuntime}, not here. This builder only translates a
 * tool call into a capability input, delegates to the runtime, and renders the typed
 * {@link SkillResponse} back to MCP tool output via the pure render helpers. It owns NO
 * name-resolution logic and never consults a closed-world enum (Req 1.6, 9.1, 9.4, 9.6).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  renderListReferences,
  renderReadReference,
  renderReadSkill,
  type AdapterRenderOptions,
  type ToolResult,
} from './tool-render.js';
import { presentManifest } from './manifest-presenter.js';
import { presentSearch } from './search-presenter.js';
import type { SkillManifest } from '../types.js';
import type { SkillsRuntime } from '../runtime/contract.js';

/**
 * Open-world skill-name schema (Req 1.6, 9.1, 9.6).
 *
 * Any non-empty string is valid input; resolution and the open-world / `not_found`
 * decision move into the runtime. The tool's input parameter key set is unchanged — only
 * the validator is relaxed relative to the pre-migration `z.enum(VALID_SKILLS)` gate.
 */
const skillParam = z.string().min(1);

/**
 * Emit the Req 9.6 non-fatal open-world warning (diagnostics channel only).
 *
 * Membership in the published set decides ONLY whether to warn — it is never a
 * resolution gate. The caller still delegates to the runtime regardless, and an
 * unresolved name still surfaces as a typed `not_found` (Req 9.6, 1.6). The warning is
 * written to STDERR, never STDOUT: STDOUT is the JSON-RPC / NDJSON protocol channel and
 * must stay protocol-only. Published names emit no warning.
 */
function warnIfUnpublished(tool: string, name: string, published: ReadonlySet<string>): void {
  if (!published.has(name)) {
    process.stderr.write(
      `${tool}: warning — open-world skill name "${name}" is not in the published set\n`,
    );
  }
}

/** Construction inputs for {@link buildSkillsMcpServer}. */
export interface BuildSkillsMcpServerOptions {
  /** MCP server name reported on `initialize` (production: `@stdiobus/skills`). */
  name: string;
  /** MCP server version reported on `initialize` (production: the manifest version). */
  version: string;
  /** The transport-selected runtime every tool delegates to. */
  runtime: SkillsRuntime;
  /** The published manifest registry document rendered by `list_skills`. */
  manifest: SkillManifest;
  /** The published skill-name set — gates ONLY the open-world warning, never resolution. */
  publishedSkills: ReadonlySet<string>;
  /** Render options (staged provenance exposure). Compat default is `{ exposeProvenance: false }`. */
  renderOpts: AdapterRenderOptions;
}

/**
 * Build the 5-tool Skills MCP server over a supplied runtime — the shared wiring used by
 * both the production executable and the e2e harness.
 *
 * The caller owns transport connection: this returns the configured {@link McpServer}
 * with all five tools registered, but does NOT call `connect`. Observable behavior is
 * byte-identical to the pre-extraction inline registrations (guarded by the
 * `mcp-protocol` and `backward-compat` suites).
 *
 * @param opts - server identity, runtime, manifest, published set, and render options.
 * @returns the configured `McpServer` (transport not yet connected).
 */
export function buildSkillsMcpServer(opts: BuildSkillsMcpServerOptions): McpServer {
  const { name, version, runtime, manifest, publishedSkills, renderOpts } = opts;

  const server = new McpServer({ name, version }, { capabilities: { tools: {} } });

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
  // published result shape. Ranking comes from the bundled provider's native keyword index.
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

  return server;
}
