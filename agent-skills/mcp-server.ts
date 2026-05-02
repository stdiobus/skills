/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MCP Skills Server — standalone executable.
 *
 * Exposes the 12 agent skills, their reference materials, and the skills
 * manifest as five MCP tools over stdio transport (JSON-RPC 2.0 / NDJSON).
 *
 * Start: `node out/dist/mcp-server.js`
 * Or:    `npx @stdiobus/skills`
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SkillName } from './types.js';
import { createFileResolver } from './lib/file-resolver.js';
import { buildSearchIndex } from './lib/search-index.js';
import { handleListSkills } from './tools/list-skills.js';
import { handleReadSkill } from './tools/read-skill.js';
import { handleListReferences } from './tools/list-references.js';
import { handleReadReference } from './tools/read-reference.js';
import { handleSearchSkills } from './tools/search-skills.js';

/** All valid skill name values as a tuple for z.enum(). */
const VALID_SKILLS = Object.values(SkillName) as [string, ...string[]];

async function main(): Promise<void> {
  const resolver = createFileResolver();
  const manifest = await resolver.readManifest();

  // Pre-load all 12 SKILL.md contents for the search index
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

  server.tool(
    'list_skills',
    'List all available skills with their layers and metadata',
    {},
    async () => handleListSkills(resolver),
  );

  server.tool(
    'read_skill',
    'Read the full SKILL.md content for a specific skill',
    { skill: z.enum(VALID_SKILLS) },
    async (args) => handleReadSkill(args, resolver),
  );

  server.tool(
    'list_references',
    'List reference files available for a specific skill',
    { skill: z.enum(VALID_SKILLS) },
    async (args) => handleListReferences(args, resolver),
  );

  server.tool(
    'read_reference',
    'Read a specific reference file for a skill',
    {
      skill: z.enum(VALID_SKILLS),
      reference: z.string().min(1),
    },
    async (args) => handleReadReference(args, resolver),
  );

  server.tool(
    'search_skills',
    'Search skills by keyword or topic',
    { query: z.string().min(1) },
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
