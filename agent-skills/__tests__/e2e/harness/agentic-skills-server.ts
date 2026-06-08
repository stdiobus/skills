/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agentic skills delegation harness (e2e — run via `tsx` as ESM).
 *
 * Demonstrates agent-to-agent (ACP) delegation: an MCP client delegates a task to a
 * DETERMINISTIC local agent (no LLM) that fulfils it through a REAL federated
 * {@link SkillsRuntime} (bundled + developer sandbox). The agent parses a tiny command
 * grammar from the prompt text and answers from the runtime:
 *
 *   - `read <name>`     → the skill's SKILL.md body (federated; ambiguous published names
 *                          resolve deterministically against the bundled provider);
 *   - `search <query>`  → federated search results as JSON `[{ skill, score }]`;
 *   - `list`            → the federated skill names as JSON `string[]`.
 *
 * The agent is registered with {@link McpAgenticServer}, which exposes the 8 agentic MCP
 * tools (`bridge_health`, `agents_discover`, `sessions_*`, `tasks_delegate`) over stdio.
 *
 * `@stdiobus/mcp-agentic` is imported at RUNTIME here (this file runs as ESM under tsx),
 * never from a `.test.ts` file (those run under ts-jest CommonJS and would break on the
 * ESM-only package). STDOUT stays protocol-only; diagnostics go to STDERR.
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { McpAgenticServer } from '@stdiobus/mcp-agentic';
import type { AgentHandler, AgentResult } from '@stdiobus/mcp-agentic';
import { createRuntimeFromRegistry, SkillProviderRegistry } from '../../../runtime/registry.js';
import { FilesystemSkillProvider } from '../../../runtime/providers/filesystem-provider.js';
import { bundledTrustPolicy } from '../../../runtime/trust.js';
import { describeError } from '../../../lib/tool-render.js';
import type { SkillsRuntime } from '../../../runtime/contract.js';

const AGENT_ID = 'skills-agent';

function readArg(flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function diag(message: string): void {
  process.stderr.write(`[agentic-skills-server] ${message}\n`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..', '..', '..', '..');
const sandboxRoot = readArg('sandbox');

if (!sandboxRoot) {
  diag('fatal: missing required --sandbox=<path> argument');
  process.exit(2);
}

// Federated runtime [bundled, sandbox]. Sandbox uses the list+substring search fallback
// (resilient to the broken-skill edge case), matching the other harnesses.
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
const runtime: SkillsRuntime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

/** Read a skill body by name; resolve a published-name ambiguity to the bundled provider. */
async function readSkillBody(name: string): Promise<string> {
  const resp = await runtime.read({ ref: { kind: 'name', name } });
  if (resp.ok) return resp.data.body;
  // Deterministic conflict resolution: a federated published-name collision resolves to the
  // bundled (first-party) provider, so delegation returns the real published content.
  if (resp.error.code === 'ambiguous') {
    const bundled = await runtime.read({ ref: { kind: 'name', name, provider: 'bundled' } });
    if (bundled.ok) return bundled.data.body;
    return `error: ${describeError(bundled.error)}`;
  }
  return `error: ${describeError(resp.error)}`;
}

/** The deterministic skills agent — no LLM, pure runtime delegation. */
const skillsAgent: AgentHandler = {
  id: AGENT_ID,
  capabilities: ['skills.read', 'skills.search', 'skills.list'],
  async prompt(_sessionId: string, input: string): Promise<AgentResult> {
    const trimmed = input.trim();
    const spaceIdx = trimmed.indexOf(' ');
    const verb = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
    const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

    let text: string;
    switch (verb) {
      case 'read': {
        text = await readSkillBody(rest);
        break;
      }
      case 'search': {
        const resp = await runtime.search({ query: rest });
        text = resp.ok
          ? JSON.stringify(resp.data.map((r) => ({ skill: r.descriptor.name, score: r.score })))
          : `error: ${describeError(resp.error)}`;
        break;
      }
      case 'list': {
        const resp = await runtime.list();
        text = resp.ok
          ? JSON.stringify(resp.data.map((d) => d.name))
          : `error: ${describeError(resp.error)}`;
        break;
      }
      default:
        text = `error: unknown command "${verb}" (expected read|search|list)`;
    }

    return { text, stopReason: 'end_turn' };
  },
};

async function main(): Promise<void> {
  const server = new McpAgenticServer({
    agents: [skillsAgent],
    defaultAgentId: AGENT_ID,
    silent: true,
  });
  await server.start();
  diag(`ready (packageRoot=${packageRoot}, sandbox=${sandboxRoot})`);
}

main().catch((err) => {
  process.stderr.write(`[agentic-skills-server] fatal error: ${err}\n`);
  process.exit(1);
});
