/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Adapter Delegation + Open-World Tool-Call Tests
// Feature: federated-skills-runtime — Task 5.3
//
// Purpose: prove the rewritten MCP_Adapter (agent-skills/mcp-server.ts) is a
//          thin, delegate-only adapter over the SkillsRuntime, that it accepts
//          open-world skill names (no closed-world enum gate), and that
//          provenance is NOT surfaced at the MCP response level during the
//          compatibility phase.
//
// Three things are asserted (per Task 5.3):
//
//   1. Handlers are delegate-only — the adapter holds no skill-name resolution
//      logic of its own. Verified two ways:
//        (a) STRUCTURAL: the adapter source uses the open-world schema
//            `z.string().min(1)`, has no `z.enum(...)` skill gate / `VALID_SKILLS`
//            allow-list, and routes each tool through `runtime.<op>(...)`.
//        (b) BEHAVIORAL: a non-published name is ACCEPTED as input (not rejected
//            at the schema layer) — proving resolution moved into the runtime.
//
//   2. Open-world tool calls:
//        - A non-published name that NO provider resolves returns a typed
//          `not_found` rendered as a tool error (`isError: true`), NOT a JSON-RPC
//          schema/validation error and NOT a process crash. The server keeps
//          serving subsequent calls (non-fatal — see Req 9.6 note below).
//        - A non-published name that A PROVIDER resolves succeeds, with no enum
//          gate in the way (direct runtime+registry delegation test, wired
//          exactly as the adapter wires it).
//
//   3. Provenance absence at the MCP level (Req 9.7):
//        - A successful `read_skill` renders ONLY the raw SKILL.md body — no
//          provenance envelope. `list_references` renders ONLY a JSON array of
//          string paths. Contrasted against the runtime response, which DOES
//          carry a provenance envelope: provenance exists internally but is
//          stripped before MCP output.
//
//   4. Open-world non-fatal warning (Req 9.6): when a skill-addressing tool
//      receives a name that is NOT in the published set, the adapter emits a
//      non-fatal warning to STDERR (the diagnostics channel), while the call
//      still returns a normal tool result (typed `not_found` -> `isError: true`
//      for the bundled deployment). A PUBLISHED name emits NO warning, and STDOUT
//      stays strictly protocol-only (JSON-RPC / NDJSON). Membership in the
//      published set decides ONLY whether to warn — it is never a resolution
//      gate. The McpClient harness captures the child process's STDERR stream to
//      assert the warning; assertions poll the stream so they are not racy.
//
// Validates: Requirements 9.4, 9.6, 9.7
// =============================================================================

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

import { InProcessSkillsRuntime } from '../../runtime/in-process-runtime.js';
import {
  SkillProviderRegistry,
  createRuntimeFromRegistry,
} from '../../runtime/registry.js';
import type {
  ReferenceContent,
  ReferenceDescriptor,
  ResolvedSkill,
  SkillContent,
  SkillProvider,
  SkillRef,
  SkillResponse,
} from '../../runtime/contract.js';

// Repo root: .../agent-skills/__tests__/mcp-server -> up 3 levels.
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..');
const AGENT_SKILLS_DIR = path.join(PACKAGE_ROOT, 'agent-skills');
const ADAPTER_SOURCE_PATH = path.join(AGENT_SKILLS_DIR, 'mcp-server.ts');
const MCP_SERVER_PATH = path.join(PACKAGE_ROOT, 'out', 'dist', 'mcp-server.mjs');

/** A name that is NOT in the published `SkillName` set / manifest. */
const OPEN_WORLD_NAME = 'definitely-not-a-real-skill';
/** A published skill used for the byte-for-byte / provenance-absence checks. */
const PUBLISHED_SKILL = 'runtime-concepts';

// =============================================================================
// PART A — Delegate-only: structural assertions over the adapter source
//
// These pin the adapter's "no resolution logic" property to concrete source
// facts: the open-world schema is used, the closed-world enum gate is gone, and
// every skill-addressing tool delegates to the runtime.
// =============================================================================

describe('adapter is delegate-only (structural — Req 9.4)', () => {
  const rawSource = fs.readFileSync(ADAPTER_SOURCE_PATH, 'utf-8');
  // Strip comments before inspecting LIVE code: the adapter's doc comment
  // legitimately documents the old `z.enum(VALID_SKILLS)` pattern it replaced,
  // which must not count as a surviving gate.
  const source = rawSource
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/\/\/.*$/gm, ''); // line comments

  it('uses the open-world skill schema z.string().min(1)', () => {
    expect(source).toMatch(/z\.string\(\)\.min\(1\)/);
  });

  it('has no closed-world enum gate or VALID_SKILLS allow-list (live code)', () => {
    // The pre-migration gate was `z.enum(VALID_SKILLS)`; neither the enum gate
    // nor a name allow-list may survive as executable code in a delegate-only adapter.
    expect(source).not.toMatch(/z\.enum\s*\(/);
    expect(source).not.toContain('VALID_SKILLS');
  });

  it('delegates each skill-addressing tool to the SkillsRuntime', () => {
    // The handlers translate to a SkillRef and call the runtime — they do not
    // resolve names themselves.
    expect(source).toMatch(/runtime\.read\s*\(/);
    expect(source).toMatch(/runtime\.getReferences\s*\(/);
    expect(source).toMatch(/runtime\.readReference\s*\(/);
    expect(source).toMatch(/createRuntimeFromRegistry\s*\(/);
  });
});

// =============================================================================
// PART B — Open-world tool calls over the real built server (child process)
//
// Drives the bundled, delegate-only server over stdio NDJSON. The bundled
// FilesystemSkillProvider resolves ONLY manifest skills, so an open-world name
// exercises the "no provider resolves" branch end-to-end.
// =============================================================================

/** Minimal NDJSON / JSON-RPC client over a spawned MCP server child process. */
class McpClient {
  private proc: ChildProcess | null = null;
  private buffer = '';
  private stderr = '';
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  async start(): Promise<void> {
    this.proc = spawn('node', [MCP_SERVER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: PACKAGE_ROOT,
      env: { ...process.env, NODE_ENV: 'test' },
    });
    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8');
      this.drain();
    });
    this.proc.stderr!.on('data', (chunk: Buffer) => {
      // Diagnostics channel: capture so tests can assert the Req 9.6 warning.
      this.stderr += chunk.toString('utf-8');
    });
    await new Promise((r) => setTimeout(r, 200));
  }

  /** True while the child process is still alive (not crashed/exited). */
  isAlive(): boolean {
    return Boolean(this.proc && this.proc.exitCode === null && !this.proc.killed);
  }

  /** Snapshot of everything the child has written to STDERR so far. */
  stderrText(): string {
    return this.stderr;
  }

  /**
   * Poll the captured STDERR until `substring` appears or the timeout elapses.
   * STDERR and STDOUT are independent pipes, so a warning written before the
   * JSON-RPC reply may arrive at the parent slightly after the reply. Polling
   * removes that race and keeps the assertion non-flaky.
   */
  async waitForStderr(substring: string, timeoutMs = 3_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.stderr.includes(substring)) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return this.stderr.includes(substring);
  }

  private drain(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          p.resolve(msg);
        }
      } catch {
        /* non-JSON line */
      }
    }
  }

  request(method: string, params?: unknown, timeoutMs = 15_000): Promise<any> {
    if (!this.proc?.stdin) throw new Error('server not started');
    const id = this.nextId++;
    const req: any = { jsonrpc: '2.0', id, method };
    if (params !== undefined) req.params = params;
    const promise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.proc.stdin.write(JSON.stringify(req) + '\n');
    return promise;
  }

  notify(method: string, params?: unknown): void {
    if (!this.proc?.stdin) throw new Error('server not started');
    const n: any = { jsonrpc: '2.0', method };
    if (params !== undefined) n.params = params;
    this.proc.stdin.write(JSON.stringify(n) + '\n');
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('server stopped'));
    }
    this.pending.clear();
    const proc = this.proc;
    this.proc = null;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 2000);
      proc.on('exit', () => {
        clearTimeout(t);
        resolve();
      });
      proc.kill('SIGTERM');
    });
  }
}

async function callTool(client: McpClient, name: string, args: Record<string, unknown>): Promise<any> {
  // Return the FULL JSON-RPC envelope so tests can distinguish a tool-level
  // error (`result.isError`) from a protocol-level error (`error`).
  return client.request('tools/call', { name, arguments: args });
}

describe('open-world tool calls over the built server (Req 9.4, 9.6)', () => {
  let client: McpClient;

  beforeAll(async () => {
    if (!fs.existsSync(MCP_SERVER_PATH)) {
      throw new Error(`MCP server bundle not found at ${MCP_SERVER_PATH}. Run "yarn build" first.`);
    }
    client = new McpClient();
    await client.start();
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'adapter-delegation-test', version: '1.0.0' },
    });
    client.notify('notifications/initialized');
    await new Promise((r) => setTimeout(r, 50));
  }, 20_000);

  afterAll(async () => {
    await client?.stop();
  });

  it('accepts a non-published name as input (no schema/validation rejection)', async () => {
    const envelope = await callTool(client, 'read_skill', { skill: OPEN_WORLD_NAME });
    // A JSON-RPC schema rejection would populate `error`; an open-world adapter
    // returns a normal tool `result` instead. This is the core delegate-only proof.
    expect(envelope.error).toBeUndefined();
    expect(envelope.result).toBeDefined();
  });

  it('renders an unresolved open-world name as a typed not_found tool error', async () => {
    const envelope = await callTool(client, 'read_skill', { skill: OPEN_WORLD_NAME });
    const result = envelope.result;
    expect(result.isError).toBe(true);
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0].type).toBe('text');
    const text: string = result.content[0].text;
    // Typed not_found surfaced through the renderer (`read_skill: skill not found: "<name>"`).
    expect(text).toContain('not found');
    expect(text).toContain(OPEN_WORLD_NAME);
  });

  it('list_references of an unresolved open-world name is a typed not_found tool error', async () => {
    const envelope = await callTool(client, 'list_references', { skill: OPEN_WORLD_NAME });
    expect(envelope.error).toBeUndefined();
    expect(envelope.result.isError).toBe(true);
    expect(envelope.result.content[0].text).toContain('not found');
  });

  it('is non-fatal: the server stays alive and keeps serving after the unresolved call', async () => {
    // Req 9.6: an unresolved open-world name must NOT terminate the process.
    // (No explicit warning side-channel exists; the non-fatal contract is the
    // tool-level error + continued service.)
    await callTool(client, 'read_skill', { skill: OPEN_WORLD_NAME });
    expect(client.isAlive()).toBe(true);

    // A subsequent published-name call still succeeds — service uninterrupted.
    const ok = await callTool(client, 'read_skill', { skill: PUBLISHED_SKILL });
    expect(ok.error).toBeUndefined();
    expect(ok.result.isError).toBeFalsy();
    expect(ok.result.content[0].text.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// PART C — Provider-resolves branch + provenance absence at the MCP level
//
// (i) Direct runtime+registry delegation (wired exactly as the adapter wires it)
//     proves a non-published name that a PROVIDER resolves succeeds — no enum
//     gate. It also shows the runtime response DOES carry provenance.
// (ii) The adapter's render mapping is mirrored locally to prove MCP-level output
//     contains ONLY the typed data (body / path array) and never the provenance
//     envelope (Req 9.7).
// =============================================================================

/**
 * A minimal real SkillProvider that resolves a single OPEN-WORLD name (absent
 * from the published set). It genuinely implements the contract — no mocking.
 */
function makeOpenWorldProvider(): SkillProvider {
  const fqid = `external:${OPEN_WORLD_NAME}`;
  const source = `external://acme/${OPEN_WORLD_NAME}`;
  const body = '# Open-world skill body\n\nResolved by a non-bundled provider.';
  const references: Record<string, string> = { 'guide.md': 'reference guide body' };

  const toResolved = (): ResolvedSkill => ({
    descriptor: { fqid, name: OPEN_WORLD_NAME, provider: 'external', source },
    providerId: 'external',
    providerLocalRef: '__private__',
    provenanceSeed: { source },
  });

  const matches = (ref: SkillRef): boolean => {
    switch (ref.kind) {
      case 'name':
        return ref.name === OPEN_WORLD_NAME && (!ref.provider || ref.provider === 'external');
      case 'fqid':
        return ref.fqid === fqid;
      case 'descriptor':
        return ref.descriptor.fqid === fqid;
    }
  };

  return {
    id: 'external',
    capabilities: { read: true, list: true, search: false, references: true },
    async resolve(ref) {
      return matches(ref) ? [toResolved()] : [];
    },
    async read(resolved): Promise<SkillContent> {
      return { descriptor: resolved.descriptor, body };
    },
    async list() {
      return [toResolved()];
    },
    async listReferences(): Promise<ReferenceDescriptor[]> {
      return Object.keys(references).map((p) => ({ path: p }));
    },
    async readReference(_resolved, reference): Promise<ReferenceContent> {
      return { path: reference, body: references[reference] ?? '' };
    },
  };
}

// --- Local mirror of the adapter's SkillResponse -> MCP output rendering. ---
// Mirrors agent-skills/mcp-server.ts: on success it emits ONLY the typed data
// (raw body / JSON path array); provenance is never included. Kept tiny and
// success-only so the provenance-absence assertion is meaningful.
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function renderReadSkill(resp: SkillResponse<SkillContent>): ToolResult {
  if (resp.ok) return { content: [{ type: 'text', text: resp.data.body }] };
  return { content: [{ type: 'text', text: 'read_skill: error' }], isError: true };
}

function renderListReferences(resp: SkillResponse<ReferenceDescriptor[]>): ToolResult {
  if (resp.ok) {
    const paths = resp.data.map((d) => d.path);
    return { content: [{ type: 'text', text: JSON.stringify(paths) }] };
  }
  return { content: [{ type: 'text', text: 'list_references: error' }], isError: true };
}

/** Provenance envelope keys that must never appear in rendered MCP output. */
const PROVENANCE_TOKENS = ['provenance', 'resolvedFrom', 'aggregateDiagnostics', 'provenanceSeed'];

describe('provider-resolves branch + provenance absence (Req 9.4, 9.7)', () => {
  // Wire the runtime EXACTLY as the adapter does: registry -> in-process runtime.
  const registry = new SkillProviderRegistry([{ provider: makeOpenWorldProvider() }]);
  const runtime = createRuntimeFromRegistry({ kind: 'in-process' }, registry);

  it('a non-published name that a provider resolves succeeds (no enum gate)', async () => {
    const resp = await runtime.read({ ref: { kind: 'name', name: OPEN_WORLD_NAME } });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data.body).toContain('Open-world skill body');
    expect(resp.data.descriptor.name).toBe(OPEN_WORLD_NAME);
    expect(resp.data.descriptor.provider).toBe('external');
  });

  it('the runtime response carries a provenance envelope (present internally)', async () => {
    const resp = await runtime.read({ ref: { kind: 'name', name: OPEN_WORLD_NAME } });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    // Provenance exists at the runtime level (Req 9.7: added internally first).
    expect(resp.provenance.fqid).toBe(`external:${OPEN_WORLD_NAME}`);
    expect(resp.provenance.provider).toBe('external');
    expect(typeof resp.provenance.source).toBe('string');
  });

  it('rendered read_skill output is the raw body ONLY — provenance stripped', async () => {
    const resp = await runtime.read({ ref: { kind: 'name', name: OPEN_WORLD_NAME } });
    const rendered = renderReadSkill(resp);
    expect(rendered.isError).toBeFalsy();
    expect(rendered.content[0].text).toBe(
      '# Open-world skill body\n\nResolved by a non-bundled provider.',
    );
    // No provenance envelope leaks into MCP output.
    const asJson = JSON.stringify(rendered);
    for (const token of PROVENANCE_TOKENS) {
      expect(asJson).not.toContain(token);
    }
  });

  it('rendered list_references output is a plain JSON string array — no provenance', async () => {
    const resp = await runtime.getReferences({ ref: { kind: 'name', name: OPEN_WORLD_NAME } });
    const rendered = renderListReferences(resp);
    expect(rendered.isError).toBeFalsy();
    const parsed = JSON.parse(rendered.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual(['guide.md']);
    // Every element is a bare string path, not a descriptor/provenance object.
    for (const el of parsed) {
      expect(typeof el).toBe('string');
    }
    const asJson = JSON.stringify(rendered);
    for (const token of PROVENANCE_TOKENS) {
      expect(asJson).not.toContain(token);
    }
  });
});

// =============================================================================
// PART D — Provenance absence end-to-end over the built server (Req 9.7)
//
// The published-name read output must be byte-for-byte the raw SKILL.md body
// (no envelope), and the list_references output a plain string array.
// =============================================================================

describe('provenance absent from MCP-level output over the built server (Req 9.7)', () => {
  let client: McpClient;

  beforeAll(async () => {
    if (!fs.existsSync(MCP_SERVER_PATH)) {
      throw new Error(`MCP server bundle not found at ${MCP_SERVER_PATH}. Run "yarn build" first.`);
    }
    client = new McpClient();
    await client.start();
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'adapter-delegation-test', version: '1.0.0' },
    });
    client.notify('notifications/initialized');
    await new Promise((r) => setTimeout(r, 50));
  }, 20_000);

  afterAll(async () => {
    await client?.stop();
  });

  it('read_skill output equals the raw SKILL.md body with no provenance envelope', async () => {
    const envelope = await callTool(client, 'read_skill', { skill: PUBLISHED_SKILL });
    expect(envelope.error).toBeUndefined();
    const text: string = envelope.result.content[0].text;

    const onDisk = fs.readFileSync(
      path.join(AGENT_SKILLS_DIR, PUBLISHED_SKILL, 'SKILL.md'),
      'utf-8',
    );
    // Byte-for-byte raw body — an envelope would change this exact equality.
    expect(text).toBe(onDisk);
    // Defensive: provenance envelope keys never appear in the output.
    expect(text).not.toContain('resolvedFrom');
    expect(text).not.toContain('aggregateDiagnostics');
  });

  it('list_references output is a JSON array of string paths (no provenance objects)', async () => {
    const envelope = await callTool(client, 'list_references', { skill: PUBLISHED_SKILL });
    expect(envelope.error).toBeUndefined();
    const refs = JSON.parse(envelope.result.content[0].text);
    expect(Array.isArray(refs)).toBe(true);
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) {
      expect(typeof r).toBe('string');
    }
  });
});

// =============================================================================
// PART E — Open-world non-fatal warning on STDERR (Req 9.6)
//
// Req 9.6 requires the adapter to ACCEPT an open-world name AND emit a non-fatal
// warning. Earlier parts prove the "accept + typed not_found" half; this part
// proves the warning half end-to-end over the built server:
//
//   - A non-published name -> a warning line on STDERR (diagnostics channel),
//     while the tool call still returns a normal result (typed not_found ->
//     isError: true) and the process stays alive.
//   - A PUBLISHED name -> NO warning line for that name (membership decides only
//     whether to warn, never whether to reject).
//   - STDOUT stays protocol-only: the warning never appears in a JSON-RPC reply.
// =============================================================================

describe('open-world non-fatal warning on STDERR (Req 9.6)', () => {
  let client: McpClient;

  /** The exact warning fragment the adapter writes (sans tool/name specifics). */
  const WARNING_FRAGMENT = 'open-world skill name';

  beforeAll(async () => {
    if (!fs.existsSync(MCP_SERVER_PATH)) {
      throw new Error(`MCP server bundle not found at ${MCP_SERVER_PATH}. Run "yarn build" first.`);
    }
    client = new McpClient();
    await client.start();
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'adapter-delegation-test', version: '1.0.0' },
    });
    client.notify('notifications/initialized');
    await new Promise((r) => setTimeout(r, 50));
  }, 20_000);

  afterAll(async () => {
    await client?.stop();
  });

  it('read_skill of a non-published name emits a non-fatal STDERR warning AND still returns a tool result', async () => {
    const envelope = await callTool(client, 'read_skill', { skill: OPEN_WORLD_NAME });

    // The call still returns a NORMAL tool result (non-fatal): typed not_found,
    // not a JSON-RPC error, not a crash.
    expect(envelope.error).toBeUndefined();
    expect(envelope.result.isError).toBe(true);
    expect(envelope.result.content[0].text).toContain('not found');

    // The warning is emitted on STDERR (diagnostics channel), naming the tool and the name.
    const seen = await client.waitForStderr(
      `read_skill: warning — open-world skill name "${OPEN_WORLD_NAME}"`,
    );
    expect(seen).toBe(true);

    // Non-fatal: the server stays alive after warning + unresolved call.
    expect(client.isAlive()).toBe(true);
  });

  it('list_references and read_reference of a non-published name also warn on STDERR', async () => {
    await callTool(client, 'list_references', { skill: OPEN_WORLD_NAME });
    const sawList = await client.waitForStderr(
      `list_references: warning — open-world skill name "${OPEN_WORLD_NAME}"`,
    );
    expect(sawList).toBe(true);

    await callTool(client, 'read_reference', { skill: OPEN_WORLD_NAME, reference: 'guide.md' });
    const sawRef = await client.waitForStderr(
      `read_reference: warning — open-world skill name "${OPEN_WORLD_NAME}"`,
    );
    expect(sawRef).toBe(true);
  });

  it('the warning is NOT written to STDOUT (protocol channel stays clean)', async () => {
    // The JSON-RPC reply (STDOUT) must never carry the warning text — it is a
    // diagnostics-only message. The reply we already received above is a typed
    // not_found ("skill not found"), distinct from the warning phrasing.
    const envelope = await callTool(client, 'read_skill', { skill: OPEN_WORLD_NAME });
    const replyJson = JSON.stringify(envelope);
    expect(replyJson).not.toContain(WARNING_FRAGMENT);
  });

  it('a PUBLISHED name emits NO open-world warning', async () => {
    // Snapshot STDERR, call a published name, then confirm no new warning line
    // mentioning that published name was appended.
    const before = client.stderrText();
    const ok = await callTool(client, 'read_skill', { skill: PUBLISHED_SKILL });
    expect(ok.error).toBeUndefined();
    expect(ok.result.isError).toBeFalsy();

    // Give STDERR a brief settle window; a warning, if (wrongly) emitted, would land here.
    await new Promise((r) => setTimeout(r, 150));
    const appended = client.stderrText().slice(before.length);
    expect(appended).not.toContain(WARNING_FRAGMENT);
    expect(appended).not.toContain(PUBLISHED_SKILL);
  });
});
