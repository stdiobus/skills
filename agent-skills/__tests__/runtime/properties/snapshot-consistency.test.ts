/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Property 3 — Per-operation provider snapshot consistency (Task 4.2)
//
// Subject: InProcessSkillsRuntime threaded over a ProviderView (runtime/in-process-runtime.ts).
//
// Design Property 3 (design §"Correctness Properties"): for any interleaving of an
// `admit` with an in-flight operation, that operation's resolved/read/federated result is
// computed against the SINGLE snapshot captured at its entry; only a SUBSEQUENT operation
// observes the admitted provider.
//
// Invariants validated here:
//   1. An `admit` interleaved AFTER a `read`/`list` has captured its entry snapshot does
//      NOT change that in-flight operation's provider set (Req 10.2, 10.3, 10.5).
//   2. The NEXT operation, begun after the admit, DOES see the admitted provider
//      (dynamic visibility — Req 10.4).
//   3. The single-bundled-provider baseline is byte-for-byte identical whether the runtime
//      is constructed from a plain array (wrapped in a ConstantProviderView) or from an
//      explicit ConstantProviderView over the same array (Req 10.1, 15.2).
//
// Validates: Requirements 10.2, 10.3, 10.4, 10.5, 15.2
// =============================================================================

import fc from 'fast-check';

import { InProcessSkillsRuntime } from '../../../runtime/in-process-runtime.js';
import { ConstantProviderView, MutableProviderView } from '../../../runtime/registry.js';
import { FilesystemSkillProvider } from '../../../runtime/providers/filesystem-provider.js';
import type {
  ResolvedSkill,
  SkillDescriptor,
  SkillProvider,
  SkillRef,
  SkillResponse,
} from '../../../runtime/contract.js';

// -----------------------------------------------------------------------------
// A controllable "gate" — a promise the test releases by hand, so an `admit` can
// be deterministically interleaved while a provider call is suspended mid-flight.
// -----------------------------------------------------------------------------

interface Gate {
  readonly wait: Promise<void>;
  release(): void;
}

function makeGate(): Gate {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

interface SkillSpec {
  readonly id: string;
  readonly name: string;
  readonly fqid: string;
  readonly body: string;
}

/**
 * A real (non-mock) SkillProvider over a single skill. When `gate` is supplied, `resolve`
 * suspends on it BEFORE returning, so the test can admit another provider while the
 * operation that called `resolve` is in-flight.
 */
function makeProvider(spec: SkillSpec, gate?: Promise<void>): SkillProvider {
  const resolved: ResolvedSkill = {
    descriptor: { fqid: spec.fqid, name: spec.name, provider: spec.id, source: `mem://${spec.id}` },
    providerId: spec.id,
    providerLocalRef: `${spec.id}:local`,
    provenanceSeed: { source: `mem://${spec.id}` },
  };

  const matches = (ref: SkillRef): boolean => {
    if (ref.kind === 'name') return (!ref.provider || ref.provider === spec.id) && ref.name === spec.name;
    if (ref.kind === 'fqid') return ref.fqid === spec.fqid;
    return ref.descriptor.fqid === spec.fqid;
  };

  return {
    id: spec.id,
    capabilities: { read: true, list: true, search: false, references: false },
    async resolve(ref: SkillRef): Promise<ResolvedSkill[]> {
      if (gate) await gate;
      return matches(ref) ? [resolved] : [];
    },
    async read(r: ResolvedSkill) {
      return { descriptor: r.descriptor, body: spec.body };
    },
    async list() {
      return [resolved];
    },
  };
}

// =============================================================================
// Invariant 1 + 2 — interleaved admit; in-flight snapshot frozen; next op sees admit
// =============================================================================

describe('Property 3 — in-flight read is computed against its entry snapshot (Req 10.2, 10.3, 10.5)', () => {
  it('an admit interleaved while resolve is in-flight does not make the in-flight read ambiguous', async () => {
    const gate = makeGate();
    const p0 = makeProvider({ id: 'p0', name: 'x', fqid: 'p0:x', body: 'BODY-A' }, gate.wait);
    const view = new MutableProviderView([p0]);
    const runtime = new InProcessSkillsRuntime(view);

    // Begin the read WITHOUT awaiting: it synchronously captures the entry snapshot [p0]
    // and suspends inside p0.resolve at the gate.
    const inFlight = runtime.read({ ref: { kind: 'name', name: 'x' } });

    // Interleave an admit of a provider that COLLIDES on name 'x' with a DIFFERENT fqid —
    // had the in-flight op re-read the view, it would now resolve to two candidates and
    // return `ambiguous`.
    const pAdmitted = makeProvider({ id: 'padm', name: 'x', fqid: 'padm:x', body: 'BODY-Z' });
    view.admit(pAdmitted);

    gate.release();
    const resp = await inFlight;

    // In-flight op only ever saw [p0]: it resolves cleanly to p0's single skill.
    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect(resp.data.body).toBe('BODY-A');
      expect(resp.data.descriptor.fqid).toBe('p0:x');
    }
  });

  it('the NEXT operation after the admit observes the admitted provider (Req 10.4)', async () => {
    const p0 = makeProvider({ id: 'p0', name: 'x', fqid: 'p0:x', body: 'BODY-A' });
    const view = new MutableProviderView([p0]);
    const runtime = new InProcessSkillsRuntime(view);

    // Baseline: single provider resolves cleanly.
    const before = await runtime.read({ ref: { kind: 'name', name: 'x' } });
    expect(before.ok).toBe(true);

    // Admit a name-colliding provider with a distinct fqid.
    view.admit(makeProvider({ id: 'padm', name: 'x', fqid: 'padm:x', body: 'BODY-Z' }));

    // The next read sees BOTH providers → ambiguous with both candidates, none selected.
    const after = await runtime.read({ ref: { kind: 'name', name: 'x' } });
    expect(after.ok).toBe(false);
    if (!after.ok) {
      expect(after.error.code).toBe('ambiguous');
      if (after.error.code === 'ambiguous') {
        const fqids = after.error.candidates.map((c: SkillDescriptor) => c.fqid).sort();
        expect(fqids).toEqual(['p0:x', 'padm:x']);
      }
    }

    // A subsequent list also aggregates across both providers.
    const listed = await runtime.list();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      const fqids = listed.data.map((d) => d.fqid).sort();
      expect(fqids).toEqual(['p0:x', 'padm:x']);
    }
  });

  it('PROPERTY: for any bundled set + interleaved admit, the in-flight op equals the entry snapshot result', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }), // number of bundled providers
        fc.boolean(), // admitted provider collides on the target name?
        fc.constantFrom<'read' | 'list'>('read', 'list'),
        async (bundledCount, collides, op) => {
          const gate = makeGate();

          // p0 resolves the target name 'x'; it is the GATED provider so the admit can
          // interleave while the operation is suspended inside p0.resolve.
          const p0 = makeProvider({ id: 'p0', name: 'x', fqid: 'p0:x', body: 'A' }, gate.wait);

          // The remaining bundled providers carry distinct, non-colliding skills.
          const rest: SkillProvider[] = [];
          for (let i = 1; i < bundledCount; i++) {
            rest.push(makeProvider({ id: `p${i}`, name: `s${i}`, fqid: `p${i}:s${i}`, body: `B${i}` }));
          }
          const bundled = [p0, ...rest];

          const view = new MutableProviderView(bundled);
          const runtime = new InProcessSkillsRuntime(view);

          // The admitted provider either collides on name 'x' (distinct fqid) or is unrelated.
          const admitted = collides
            ? makeProvider({ id: 'padm', name: 'x', fqid: 'padm:x', body: 'Z' })
            : makeProvider({ id: 'padm', name: 'unrelated', fqid: 'padm:unrelated', body: 'Z' });

          // Reference baseline: the same operation over a CONSTANT view of exactly the
          // entry snapshot (bundled providers, ungated), computed independently.
          const baselineRuntime = new InProcessSkillsRuntime(
            new ConstantProviderView([
              makeProvider({ id: 'p0', name: 'x', fqid: 'p0:x', body: 'A' }),
              ...rest,
            ]),
          );

          let inFlight: Promise<SkillResponse<unknown>>;
          let baseline: Promise<SkillResponse<unknown>>;
          if (op === 'read') {
            inFlight = runtime.read({ ref: { kind: 'name', name: 'x' } });
            baseline = baselineRuntime.read({ ref: { kind: 'name', name: 'x' } });
          } else {
            inFlight = runtime.list();
            baseline = baselineRuntime.list();
          }

          // Interleave the admit while the gated p0.resolve is suspended.
          view.admit(admitted);
          gate.release();

          const [got, want] = await Promise.all([inFlight, baseline]);

          // The in-flight operation's OUTCOME shape must match the entry-snapshot baseline:
          // the admitted provider must be invisible to it regardless of collision.
          expect(got.ok).toBe(want.ok);
          if (got.ok && want.ok) {
            if (op === 'read') {
              const g = got.data as { body: string; descriptor: SkillDescriptor };
              const w = want.data as { body: string; descriptor: SkillDescriptor };
              expect(g.body).toBe(w.body);
              expect(g.descriptor.fqid).toBe(w.descriptor.fqid);
            } else {
              const g = (got.data as SkillDescriptor[]).map((d) => d.fqid).sort();
              const w = (want.data as SkillDescriptor[]).map((d) => d.fqid).sort();
              expect(g).toEqual(w);
              // The admitted fqid is never present in the in-flight result.
              expect(g).not.toContain('padm:x');
              expect(g).not.toContain('padm:unrelated');
            }
          }

          // Dynamic visibility: a NEW operation after the admit sees the admitted provider.
          if (op === 'list') {
            const next = await runtime.list();
            expect(next.ok).toBe(true);
            if (next.ok) {
              const fqids = next.data.map((d) => d.fqid);
              expect(fqids).toContain(collides ? 'padm:x' : 'padm:unrelated');
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Invariant 3 — single-provider baseline: array ctor === ConstantProviderView ctor
// =============================================================================

describe('Property 3 — single-bundled-provider baseline is byte-for-byte unchanged (Req 10.1, 15.2)', () => {
  const SKILL = 'runtime-concepts';

  // The array constructor (backward-compat path, wrapped in a ConstantProviderView) and an
  // explicit ConstantProviderView over the same provider must produce identical output.
  const fromArray = new InProcessSkillsRuntime([new FilesystemSkillProvider()]);
  const fromView = new InProcessSkillsRuntime(new ConstantProviderView([new FilesystemSkillProvider()]));

  it('read() output is identical for the array ctor and the explicit ConstantProviderView ctor', async () => {
    const a = await fromArray.read({ ref: { kind: 'name', name: SKILL } });
    const b = await fromView.read({ ref: { kind: 'name', name: SKILL } });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a).toEqual(b);
    if (a.ok) {
      expect(typeof a.data.body).toBe('string');
      expect(a.data.body.length).toBeGreaterThan(0);
    }
  });

  it('list() output is identical for the array ctor and the explicit ConstantProviderView ctor', async () => {
    const a = await fromArray.list();
    const b = await fromView.list();
    expect(a).toEqual(b);
  });

  it('search() output is identical for the array ctor and the explicit ConstantProviderView ctor', async () => {
    const a = await fromArray.search({ query: 'runtime' });
    const b = await fromView.search({ query: 'runtime' });
    expect(a).toEqual(b);
  });
});
