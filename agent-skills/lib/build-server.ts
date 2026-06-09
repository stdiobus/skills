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
  describeError,
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
import { AdmissionCapabilities } from '../runtime/capabilities.js';

/**
 * Default `maxContentBytes` for an {@link buildSkillsMcpServer} `admit_skill` call that omits
 * it — the same interim bound the proven e2e admit harness (`mcp-admit-server.mjs`) uses. It is
 * a per-acquisition size ceiling, not a security gate (the untrusted/bounded/namespace controls
 * still apply); changeable in one place (design §"Settled vs interim").
 */
const DEFAULT_ADMIT_MAX_CONTENT_BYTES = 1_000_000;

/**
 * Default per-operation `timeoutMs` for an `admit_skill` call that omits it — matches the
 * admission budget the production bus worker and the proven harness arm (30s). Interim/policy.
 */
const DEFAULT_ADMIT_TIMEOUT_MS = 30_000;

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
  /**
   * Opt-in: register the additive `admit_skill` tool alongside the five read tools (Req 16.1).
   *
   * Defaults to `false` so every existing caller of this builder (e.g. the e2e federated
   * harness) keeps the EXACTLY-five-tool surface byte-for-byte. The production executable
   * (`mcp-server.ts`) sets it `true` once it has composed an admission-capable `runtime` (a
   * `runtime` whose `request(skills.add.v1, …)` seam is wired to an `AdmissionController`).
   *
   * The tool holds NO admission logic (Req 16.2): it builds the wire `RawProviderDescriptor`
   * and delegates to `runtime.request(AdmissionCapabilities.add, raw)` — the single production
   * `skills.add.v1` path. Enabling it NEVER alters the names, schemas, or behavior of the five
   * read tools (Req 15.1).
   */
  admitSkill?: boolean;
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

  // admit_skill (Req 16.1–16.4): OPT-IN additive sixth tool — registered ONLY when the caller
  // composed an admission-capable runtime and set `admitSkill: true`. Never alters the five
  // read tools above (Req 15.1). This is the SAME thin shim the e2e harness `mcp-admit-server.mjs`
  // proved, promoted into the shared builder: it holds NO admission logic (Req 16.2) — it builds
  // the wire RawProviderDescriptor and delegates to the single production `skills.add.v1` path via
  // the `request` seam (`AdmissionCapabilities.add` → `AdmissionCapabilityHandler` →
  // `AdmissionController`). Success renders the admitted identity + record-only contentHash;
  // a quarantine renders `describeError(cause)` as an MCP tool error (`isError: true`), never
  // throwing across the tool boundary (Req 16.4, 9.1).
  if (opts.admitSkill) {
    server.registerTool(
      'admit_skill',
      {
        description: 'Admit an external skill provider over HTTPS via the production skills.add.v1 path',
        inputSchema: {
          factoryId: z.string().min(1),
          namespace: z.string().min(1),
          url: z.string().min(1),
          maxContentBytes: z.number().optional(),
          timeoutMs: z.number().optional(),
        },
      },
      async (args): Promise<ToolResult> => {
        // Build the RAW wire descriptor (trust / capabilityVersions omitted → normalized to the
        // least-privilege defaults at the decode boundary inside the handler) and delegate to the
        // SAME `request` seam the bus worker reaches admission through. No admission logic here.
        const raw = {
          factoryId: args.factoryId,
          namespace: args.namespace,
          config: {
            url: args.url,
            maxContentBytes: args.maxContentBytes ?? DEFAULT_ADMIT_MAX_CONTENT_BYTES,
            timeoutMs: args.timeoutMs ?? DEFAULT_ADMIT_TIMEOUT_MS,
          },
        };
        const resp = await runtime.request(AdmissionCapabilities.add, raw);
        return resp.ok
          ? { content: [{ type: 'text', text: JSON.stringify(resp.data) }] }
          : { content: [{ type: 'text', text: describeError(resp.error) }], isError: true };
      },
    );
  }

  return server;
}
