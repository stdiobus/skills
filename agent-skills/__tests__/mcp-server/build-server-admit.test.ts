/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Unit Test: buildSkillsMcpServer — additive `admit_skill` tool (Task 13.1)
// Validates: Requirements 16.1, 16.2, 16.3 (visibility wiring), 16.4, 15.1
// Purpose: Prove the OPT-IN admit_skill registration is purely additive (the five
//          read tools are unchanged), delegates to the single `skills.add.v1`
//          request seam holding no admission logic, and renders success vs
//          quarantine exactly (record-only identity vs describeError + isError).
// =============================================================================

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildSkillsMcpServer } from '../../lib/build-server.js';
import { COMPAT_RENDER_OPTIONS, describeError } from '../../lib/tool-render.js';
import { AdmissionCapabilities } from '../../runtime/capabilities.js';
import type { CapabilityRef, SkillResponse, SkillRuntimeError, SkillsRuntime } from '../../runtime/contract.js';
import type { SkillManifest } from '../../types.js';

/** The five read tools that must ALWAYS be present and unchanged (Req 15.1). */
const READ_TOOLS = ['list_references', 'list_skills', 'read_reference', 'read_skill', 'search_skills'];

/** A minimal published manifest — only the fields the builder stores/needs to construct. */
const MANIFEST: SkillManifest = {
  version: '9.9.9',
  frameworkVersion: '0.5.x',
  skills: [
    { name: 'runtime-concepts', layer: 1, versionRange: '0.5.x', status: 'stable', lastValidated: '2026-01-01' },
  ],
  lastValidated: '2026-01-01',
};

/**
 * Minimal {@link SkillsRuntime} stub. The read-tool handlers are not exercised by these
 * tests (we only list tools and call `admit_skill`), so they return a benign typed error;
 * only `request` is configurable, capturing the input and returning the scripted response.
 */
class StubRuntime implements SkillsRuntime {
  lastRequest: { method: string; input: unknown } | null = null;

  constructor(private readonly requestImpl: (input: unknown) => SkillResponse<unknown>) { }

  private notImpl(): SkillResponse<never> {
    return { ok: false, error: { code: 'unsupported', capability: 'stub' } };
  }

  async read(): Promise<SkillResponse<never>> {
    return this.notImpl();
  }
  async list(): Promise<SkillResponse<never>> {
    return this.notImpl();
  }
  async search(): Promise<SkillResponse<never>> {
    return this.notImpl();
  }
  async getReferences(): Promise<SkillResponse<never>> {
    return this.notImpl();
  }
  async readReference(): Promise<SkillResponse<never>> {
    return this.notImpl();
  }
  async capabilities(): Promise<never[]> {
    return [];
  }
  async request<TInput, TOutput>(
    capability: CapabilityRef<TInput, TOutput>,
    input: TInput,
  ): Promise<SkillResponse<TOutput>> {
    this.lastRequest = { method: capability.method, input };
    return this.requestImpl(input) as SkillResponse<TOutput>;
  }
}

/** Build a server over the stub runtime and connect a client over an in-memory transport. */
async function connect(
  runtime: SkillsRuntime,
  admitSkill: boolean,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = buildSkillsMcpServer({
    name: '@stdiobus/skills-test',
    version: MANIFEST.version,
    runtime,
    manifest: MANIFEST,
    publishedSkills: new Set(MANIFEST.skills.map((s) => s.name)),
    renderOpts: COMPAT_RENDER_OPTIONS,
    admitSkill,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('buildSkillsMcpServer — admit_skill (Task 13.1)', () => {
  it('omits admit_skill by default — exactly the five read tools (Req 15.1)', async () => {
    const runtime = new StubRuntime(() => ({ ok: false, error: { code: 'unsupported', capability: 'x' } }));
    const { client, close } = await connect(runtime, false);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual(READ_TOOLS);
      expect(names).not.toContain('admit_skill');
    } finally {
      await close();
    }
  });

  it('registers admit_skill additively when opted in — five read tools unchanged (Req 16.1, 15.1)', async () => {
    const runtime = new StubRuntime(() => ({ ok: false, error: { code: 'unsupported', capability: 'x' } }));
    const { client, close } = await connect(runtime, true);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      // Additive: the five read tools are all still present, plus admit_skill.
      for (const t of READ_TOOLS) expect(names).toContain(t);
      expect(names).toContain('admit_skill');
      expect(names).toHaveLength(READ_TOOLS.length + 1);
    } finally {
      await close();
    }
  });

  it('delegates to the single skills.add.v1 request seam and renders success identity (Req 16.2, 16.3)', async () => {
    const admitted = {
      descriptor: { fqid: 'external:copying', name: 'copying', provider: 'external', source: 'https://x/COPYING' },
      contentHash: 'sha256:deadbeef',
    };
    const runtime = new StubRuntime(() => ({
      ok: true,
      data: admitted,
      provenance: { fqid: 'external:copying', provider: 'external', source: 'https://x/COPYING' },
    }));
    const { client, close } = await connect(runtime, true);
    try {
      const result = await client.callTool({
        name: 'admit_skill',
        arguments: { factoryId: 'http', namespace: 'external', url: 'https://x/COPYING' },
      });

      // Delegated through the production skills.add.v1 capability — no admission logic in the tool.
      expect(runtime.lastRequest?.method).toBe(AdmissionCapabilities.add.method);
      // The tool built the RAW wire descriptor with the omitted bounds defaulted.
      expect(runtime.lastRequest?.input).toEqual({
        factoryId: 'http',
        namespace: 'external',
        config: { url: 'https://x/COPYING', maxContentBytes: 1_000_000, timeoutMs: 30_000 },
      });

      // Success renders the admitted identity + record-only contentHash, not an error.
      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0].text)).toEqual(admitted);
    } finally {
      await close();
    }
  });

  it('forwards caller-supplied bounds into the raw descriptor', async () => {
    const runtime = new StubRuntime(() => ({
      ok: true,
      data: { descriptor: { fqid: 'e:s', name: 's', provider: 'e', source: 'https://x/s' }, contentHash: 'h' },
      provenance: { fqid: 'e:s', provider: 'e', source: 'https://x/s' },
    }));
    const { client, close } = await connect(runtime, true);
    try {
      await client.callTool({
        name: 'admit_skill',
        arguments: { factoryId: 'http', namespace: 'e', url: 'https://x/s', maxContentBytes: 42, timeoutMs: 7 },
      });
      expect(runtime.lastRequest?.input).toEqual({
        factoryId: 'http',
        namespace: 'e',
        config: { url: 'https://x/s', maxContentBytes: 42, timeoutMs: 7 },
      });
    } finally {
      await close();
    }
  });

  it('renders a quarantine as a tool error via describeError, never throwing (Req 16.4, 9.1)', async () => {
    const cause: SkillRuntimeError = { code: 'bad_request', issues: ['url must be https'] };
    const quarantine: SkillRuntimeError = { code: 'quarantined', stage: 'validate', cause };
    const runtime = new StubRuntime(() => ({ ok: false, error: quarantine }));
    const { client, close } = await connect(runtime, true);
    try {
      const result = await client.callTool({
        name: 'admit_skill',
        arguments: { factoryId: 'http', namespace: 'external', url: 'http://insecure/x' },
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toBe(describeError(quarantine));
      expect(content[0].text).toContain('quarantined at stage "validate"');
    } finally {
      await close();
    }
  });
});
