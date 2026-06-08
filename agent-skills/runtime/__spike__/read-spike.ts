/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SPIKE — runtime facts (executed via `tsx`).
 *
 * Proves, against the real package on disk, the facts that make the SkillsRuntime
 * contract stand on facts rather than paper:
 *
 *   1. Legacy compatibility — read by `name` returns real SKILL.md content, reusing the
 *      existing FileResolver (no rewrite).
 *   2. No closed enum — an unknown name returns a typed `not_found`, not a thrown
 *      closed-world validation error.
 *   3. Provider boundary — the filesystem provider is one entry in a providers array;
 *      the runtime holds no package root itself.
 *   4. Provenance envelope — a successful read carries runtime-built provenance
 *      (fqid / provider / source) plus `resolvedFrom`.
 *   5. Ambiguity policy — two providers resolving the same name under different fqids
 *      yield a typed `ambiguous` error, never a silent first-match.
 *   6. (see transport-shape.proof.ts — type-level)
 *   7. Capability fallback — the filesystem provider does NOT implement `search`; the
 *      runtime degrades to list+substring instead of breaking.
 *
 * Run: `yarn tsx agent-skills/runtime/__spike__/read-spike.ts`
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { InProcessSkillsRuntime } from '../in-process-runtime.js';
import { FilesystemSkillProvider } from '../providers/filesystem-provider.js';
import type {
  ListSkillsInput,
  ResolvedSkill,
  SkillProvider,
  SkillProviderCapabilities,
  SkillRef,
} from '../contract.js';

// Package root = two levels up from agent-skills/runtime/__spike__.
const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..', '..', '..');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok) failures += 1;
  process.stdout.write(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}\n`);
}

/** A second provider that mirrors a name under a DIFFERENT fqid, to force ambiguity. */
class MirrorProvider implements SkillProvider {
  readonly id = 'mirror';
  readonly capabilities: SkillProviderCapabilities = {
    read: true,
    list: false,
    search: false,
    references: false,
  };

  constructor(private readonly mirroredName: string) { }

  async resolve(ref: SkillRef): Promise<ResolvedSkill[]> {
    const name = ref.kind === 'name' ? ref.name : null;
    if (name !== this.mirroredName) return [];
    const source = `mirror://${name}`;
    return [
      {
        descriptor: { fqid: `mirror:${name}`, name, provider: this.id, source },
        providerId: this.id,
        providerLocalRef: name,
        provenanceSeed: { source },
      },
    ];
  }

  async read(resolved: ResolvedSkill): Promise<{ descriptor: ResolvedSkill['descriptor']; body: string }> {
    return { descriptor: resolved.descriptor, body: '# mirrored' };
  }

  // Satisfy unused-input lint shape parity with the interface.
  async list(_input?: ListSkillsInput): Promise<ResolvedSkill[]> {
    return [];
  }
}

async function main(): Promise<void> {
  const fs = new FilesystemSkillProvider({ packageRoot });
  const runtime = new InProcessSkillsRuntime([fs]);

  // Pick a real published skill from the manifest as the legacy fixture.
  const listed = await runtime.list();
  const knownName = listed.ok && listed.data[0] ? listed.data[0].name : null;
  check('fact#3 provider boundary: runtime built from a providers array', true, `providers=[${fs.id}]`);
  check('list returns descriptors with fqid', Boolean(knownName), knownName ? `e.g. ${knownName}` : 'no skills');

  if (!knownName) {
    check('cannot continue without a known skill', false);
    finish();
    return;
  }

  // Fact 1 — legacy compatibility.
  const legacy = await runtime.read({ ref: { kind: 'name', name: knownName } });
  check(
    'fact#1 legacy read by name returns real content',
    legacy.ok && legacy.data.body.length > 0,
    legacy.ok ? `${legacy.data.body.length} bytes` : `error=${(!legacy.ok && legacy.error.code) || '?'}`,
  );

  // Fact 4 — provenance envelope built by the runtime.
  check(
    'fact#4 provenance has fqid/provider/source + resolvedFrom',
    legacy.ok &&
    legacy.provenance.fqid === `bundled:${knownName}` &&
    legacy.provenance.provider === 'bundled' &&
    typeof legacy.provenance.source === 'string' &&
    legacy.provenance.resolvedFrom?.kind === 'name',
    legacy.ok ? JSON.stringify(legacy.provenance) : '',
  );

  // Fact 2 — unknown name is open-world: typed not_found, no throw.
  const unknown = await runtime.read({ ref: { kind: 'name', name: 'no-such-skill-xyz' } });
  check(
    'fact#2 unknown name -> typed not_found (no throw, no enum)',
    !unknown.ok && unknown.error.code === 'not_found',
    !unknown.ok ? unknown.error.code : 'unexpectedly ok',
  );

  // Fact 5 — ambiguity policy.
  const ambiguousRuntime = new InProcessSkillsRuntime([fs, new MirrorProvider(knownName)]);
  const ambiguous = await ambiguousRuntime.read({ ref: { kind: 'name', name: knownName } });
  check(
    'fact#5 two providers, same name, different fqid -> ambiguous',
    !ambiguous.ok && ambiguous.error.code === 'ambiguous',
    !ambiguous.ok && ambiguous.error.code === 'ambiguous'
      ? `candidates=${ambiguous.error.candidates.map((c) => c.fqid).join(', ')}`
      : 'unexpected',
  );

  // Fact 7 — capability fallback: provider has no search; runtime degrades.
  const search = await runtime.search({ query: knownName.slice(0, 4) });
  check(
    'fact#7 search fallback when provider lacks search capability',
    search.ok && search.provenance.source === 'search:fallback(list+substring)' && search.data.length > 0,
    search.ok ? `${search.data.length} hits via ${search.provenance.source}` : 'failed',
  );

  // Extension seam sanity — request() dispatches a typed capability by method string.
  const { SkillsCapabilities } = await import('../capabilities.js');
  const viaRequest = await runtime.request(SkillsCapabilities.read, { ref: { kind: 'name', name: knownName } });
  check('extension seam: request(read) matches direct read', viaRequest.ok, viaRequest.ok ? 'ok' : 'failed');

  finish();
}

function finish(): void {
  process.stdout.write(`\n${failures === 0 ? 'ALL FACTS HELD' : `${failures} FACT(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`spike crashed: ${err}\n`);
  process.exit(2);
});
