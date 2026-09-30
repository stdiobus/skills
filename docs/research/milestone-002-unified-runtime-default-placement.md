<!--
  @license
  Copyright 2026-present Raman Marozau, raman@stdiobus.com
  SPDX-License-Identifier: Apache-2.0
-->

# R&D Milestone-002 Amendment — Unified Runtime & Bus-Hosted Default Placement

> Status: **Accepted direction** · Date: 2026-06-09 · Scope: `@stdiobus/skills`
> Amends: `docs/research/milestone-002-provider-boundary.md` (and honors M-001 invariants
> `docs/research/milestone-001-federated-skills-runtime.md`).
> This is an **M-002 amendment**, NOT a Milestone-003 — it corrects the implementation to match the
> owner-confirmed intent of M-001/M-002 (one runtime on the bus), it does not add a new capability domain.
> Companion dialogue logs (immutable, non-normative):
> `.ai/architecture/architecture-default-placement-relocate-to-bus-2026-06-09.md`,
> `.ai/architecture/architecture-uniform-runtime-authority-bus-default-2026-06-09.md`,
> `.ai/architecture/architecture-unified-runtime-rd-milestone-confirm-2026-06-09.md`.

## 0. The One Thing This Amendment Must Deliver

> **`@stdiobus/skills` must have exactly ONE production runtime, assembled ONE way, dispatched ONE way,
> with the stdio Bus as the default hosted authority — so there is no "works one way here, another way
> there".** Today the package ships **two** runtimes that have silently drifted apart, and the request
> handler is smeared across four places. This amendment collapses both duplications into one composition
> factory and one capability dispatcher, then makes the default deployment bus-hosted, uniformly.

Final formula (companion-confirmed):

> **One production composition factory + one runtime capability dispatcher (single authority request
> path), wrapped by transport-specific codecs/adapters. Default deployment is a bus-hosted, EPHEMERAL
> per-call authority; in-process is an explicit flag-selected deployment. No per-call mixing, no silent
> fallback, no composition drift, no `OriginAllowlist`. Durable cross-request admission is the next
> (bus-to-bus) milestone, not this one.**

## 1. Purpose

This document fixes the research direction that closes the real gap exposed after Milestone-002 and its
B1–B6 bugfixes: the project built the whole bus substrate (transport factory, `BusSkillsRuntime`,
packaged `bus-worker.mjs`, admission, governance) but the **default shipped consumption never became the
bus**, and worse, the two entrypoints that DO exist (`mcp-server.ts` and `bus-worker.ts`) have become
**two different runtimes**. It records: what is true in the code today (facts), the problem, the
invariants any fix must hold, the decisions, the target shape, and the ordered path. It is a milestone
narrative, not the formal spec; formal acceptance lives in the provider-boundary spec amendment.

## 2. Current State (facts, verified from code)

Strictly descriptive. Verified by reading the sources and `grep`.

**Two production compositions exist and have DRIFTED:**

- `agent-skills/mcp-server.ts` (the published `bin`) builds its runtime **directly**:
  - `new FilesystemSkillProvider({ search: true })` — bundled provider's **native keyword index** is on;
  - `OriginAllowlist.fromEnv()` + `new HttpSkillProviderBlueprint(originAllowlist)` — operator origin
    allowlist is wired;
  - composes the full admission stack (view, namespaces, trust, blueprint registry, `AdmissionController`,
    `AdmissionCapabilityHandler`) **in-process**, and registers the `admit_skill` tool.
- `agent-skills/runtime/transport/bus-worker.ts` (the bundled worker) builds its runtime **separately**:
  - `new FilesystemSkillProvider({ packageRoot })` — `search` is **NOT** enabled → the runtime serves
    `search_skills` via the `list + substring` fallback, **not** the native ranking;
  - `new HttpSkillProviderBlueprint()` — **NO** origin allowlist (a security/governance divergence);
  - its own hand-wired copy of the same admission stack.

Consequence: the same operation can behave differently depending on which runtime serves it
(`search_skills` ranking differs; admission origin governance differs). This is exactly the
"here it works like this, there like that" the owner rejects, present in shipped code.

**The request handler (recognize a capability → perform the action) is smeared across four places:**

1. `runtime/transport/bus-worker.ts` — a `DISPATCH` table (`method string → runtime call`);
2. `runtime/in-process-runtime.ts` — `request()` `switch(capability.method)` (`method → *From helper` /
   `skills.add.v1 → admission.handle`);
3. `lib/build-server.ts` (MCP adapter) — read tools call the typed runtime methods **directly**
   (`runtime.read/list/search/...`), while `admit_skill` goes through `runtime.request(...)`;
4. `runtime/transport/param-codec.ts` — `CAPABILITY_SCHEMAS` (`method → input schema`).

Admission is reachable by **two different routes**: in-process `request() → admission.handle`, and over
the bus `DISPATCH → admissionHandler.handle` (bypassing `request()`).

**Already-correct building blocks (no rework needed, only consolidation):**

- One `SkillsRuntime` capability contract (`runtime/contract.ts`) and capability-optional `SkillProvider`.
- The deployment seam `createSkillsRuntime({ kind: 'in-process' | 'stdio-bus' })` (`transport/factory.ts`)
  selects transport ONCE for the whole runtime.
- `BusSkillsRuntime` implements the SAME contract over `StdioBus.request`; `bus-worker.mjs` hosts the same
  `InProcessSkillsRuntime` + `AdmissionController`.
- `FilesystemSkillProvider` and `HttpSkillProvider` are both `SkillProvider`s — the runtime treats them
  uniformly.
- B6 made the worker bundled, packaged, and spawnable from the installed package.

**Default today:** `bin: mcp-skills → mcp-server.mjs` runs the in-process runtime directly; the bus is not
on the default path.

## 3. Problem Statement

The drift points in §2 are **symptoms**. The problem is a missing single source of assembly and dispatch:

> The product ships TWO production runtimes (different composition) reached through FOUR different handler
> sites (different dispatch). There is no single definition of "the production runtime" nor of "how a
> capability request is handled". Choosing a bus-hosted default on top of this would not relocate the
> runtime — it would cement a second, subtly different runtime as the default.

Treating this as "flip `mcp-server.ts` to `stdio-bus`" would miss the point and is unsafe: it must be
preceded by collapsing the two duplications.

## 4. Architectural Invariants (any implementation must hold)

This section outranks §5; decisions may be refined, invariants hold the architecture from sliding back.

1. **One runtime authority per deployment.** A deployment has exactly one `SkillsRuntime` authority; MCP
   is only an adapter and is never the runtime authority.
2. **Uniformity is at the capability→runtime boundary**, not "one transport per provider". All operations
   go through the same runtime contract; provider placement varies ONLY behind the `SkillProvider`
   contract, never as MCP/tool-level branching (M-001 §5.5 — no split-brain).
3. **Transport is a deployment detail, not a per-call tax** (M-001 §5.7). A deployment chooses in-process
   OR bus once and applies it uniformly; the in-process path is never serialized/validated as a wire path.
4. **Separate layers, not one mega-handler.** Keep three distinct concerns:
   - a **capability dispatcher** (`CapabilityRef/method → runtime.read/list/search/.../request`),
   - a **transport codec** (`ParamCodec`) that exists ONLY on the bus/NDJSON wire boundary,
   - the **MCP adapter** (MCP schema + rendering), which holds no runtime authority.
   The dispatcher must not absorb the codec (that would tax the in-process path — violates §5.7).
5. **Single composition, single dispatch (no drift).** There is exactly one production composition
   (providers, search, trust, namespaces, admission) and one capability-dispatch definition; every
   process that hosts authority uses them. (Note: the `OriginAllowlist` is removed — see Inv 11.)
6. **Composition is a FACTORY, not a singleton.** A shared composition factory is called by **separate
   composition roots** (`mcp-server.ts`, `bus-worker.ts`). No module-global instance, no exported mutable
   runtime, no runtime object shared across processes.
7. **No per-call mixing, no silent fallback.** A deployment never mixes transports per operation and never
   silently falls back bus→in-process.
8. **Capability discovery must not drift from the dispatchable set.** `capabilities()` must reflect the
   actual handled capability surface (including admission where exposed), not a stale static list.
9. **The bus worker is an EPHEMERAL per-call transport, not a stateful session server.** The bus spins a
   worker proportionally to a request; the worker does the task and goes away. `admit_skill` and
   `read_skill` are **two independent requests** — correctness MUST NOT depend on worker reuse or on any
   in-memory state (admitted providers) surviving between requests. There is no `instances: 1`-as-session-
   state invariant and no durable admission store in this milestone. The single persistence case
   ("a request fetched from an external source and the result must be RECORDED to survive a process going
   down") is the EXPLICIT next-milestone **bus-to-bus (шина-шина)** work — out of scope here.
10. **HTTPS acquisition uses standard resilience only.** The `acquire` step wraps the HTTPS fetch in
    try/catch with a **bounded retry** (a few attempts, backoff — best practice) and, on exhaustion,
    returns a **clear typed error** (returned, never thrown). Nothing beyond standard practice; deeper
    recovery/persistence is the bus-to-bus milestone. No SSL keys / client certs / custom TLS — platform
    TLS as-is (already true).
11. **No `OriginAllowlist`.** The owner's requirement is to reach a public external HTTPS source without
    SSL keys or governance machinery. The `OriginAllowlist` (incl. `withOriginAllowlist` in
    `http-skill-provider.ts`) was unrequested scope-creep and is **removed from both entrypoints**.
    External content stays safe by being untrusted-as-data, size/time-bounded, never executed, and
    namespace-governed — not by restricting origins.
12. **Bus-hosted authority is a DEPLOYMENT layer, not M-002 provider placement.** "Runtime hosted in a bus
    worker" is distinct from M-002 §12-B "worker-hosted provider placement"; provider placement inside the
    worker still stays in-process for this scope.

## 5. Decisions Reached

*Decision · Rationale · Implication.*

- **Extract one shared production-composition factory.**
  Rationale: kill the search-ranking drift (Inv 5).
  Implication: a factory builds `providers (+search:true) · trust · namespaces · admission · blueprint
  registry`; it is called by **every process that hosts authority** — `bus-worker.ts` always, and
  `mcp-server.ts` only in explicit in-process mode. In bus-default `mcp-server.ts` does NOT build a second
  authority composition (it gets a `BusSkillsRuntime`); it may read the packaged manifest for rendering
  metadata only. Each entrypoint stays its own composition root; the factory returns fresh instances, no
  module singleton, no exported mutable runtime.
- **Remove the `OriginAllowlist` (unrequested scope-creep).**
  Rationale: Inv 11 — the requirement is to reach public external HTTPS without SSL keys / origin
  governance; the allowlist (incl. `withOriginAllowlist`) was vibecoded scope-creep and is the source of
  half the drift.
  Implication: delete it from both entrypoints and from `http-skill-provider.ts`; safety stays on
  untrusted-as-data + bounds + no-execution + namespace governance.
- **Unify capability dispatch — one authority request path.**
  Rationale: remove the parallel handler sites and the parallel admission route (Inv 4).
  Implication: a shared capability catalog; the bus worker, after `ParamCodec.decode`, delegates to
  `runtime.request(capability, input)` (NOT a direct `admissionHandler.handle`); `InProcessSkillsRuntime.
  request()` stays the single authority-side dispatcher; the MCP adapter keeps its tool→method mapping
  (adapter mapping, not authority dispatch); `capabilities()` reflects the real dispatchable set.
- **Make the default deployment bus-hosted (ephemeral, per-call).**
  Rationale: this is a `@stdiobus` product; the default consumption must be the bus (§0). The bus is a
  TRANSPORT, not a standing server (Inv 9).
  Implication: `mcp-server.ts` default obtains a `BusSkillsRuntime`; every MCP tool goes
  MCP → `BusSkillsRuntime` → `bus-worker` → authoritative `InProcessSkillsRuntime`. No reliance on a worker
  surviving between requests; no durable admission state here (deferred to bus-to-bus).
- **Keep in-process as an explicit deployment selected by a startup flag; default = bus.**
  Rationale: tests and environments without the native addon need it (Inv 3, 7).
  Implication: default is bus; a startup flag/env (`--transport=in-process` / `STDIOBUS_SKILLS_TRANSPORT=
  in-process`) forces the whole-runtime in-process mode. Never mixed per-call. Whether in-process is a
  publicly-advertised mode or test/embedded-only is a minor policy left to the spec.
- **HTTPS acquire uses standard resilience only.**
  Rationale: Inv 10 — bounded retry + clear typed error; deeper recovery is bus-to-bus.
  Implication: `acquire`/`HttpSkillProvider.read` retries the fetch a bounded number of times with backoff,
  then returns a clear typed error; no durable record.
- **Keep `ParamCodec` strictly on the wire boundary.**
  Rationale: Inv 4 — the in-process path must not serialize/validate as a wire path.
  Implication: codec wraps the dispatcher only on the bus transport.

## 6. Target Architecture

```text
                         ┌───────────────────────────────────────────────┐
                         │ shared composition FACTORY (one definition)    │
                         │  providers (+search) · trust · namespaces       │
                         │  · admission · blueprint registry               │
                         └───────────────────────────────────────────────┘
                              ▲ called by each composition root ▲
        ┌─────────────────────┘                                 └─────────────────────┐
        │ composition root: mcp-server.ts                        composition root: bus-worker.ts
        ▼                                                                              ▼
  MCP adapter (tools + render)                                   bus worker (transport entry)
        │ delegates to                                                  │ ParamCodec (wire codec)
        ▼                                                               ▼
  one runtime capability DISPATCHER  ◄──────── same dispatcher ────────►  one runtime capability DISPATCHER
        │                                                               │
        ▼                                                               ▼
  SkillsRuntime authority  (default: BusSkillsRuntime → bus-worker → InProcessSkillsRuntime;
                            alt: InProcessSkillsRuntime loopback)
        └────────────────────────► providers (filesystem, http, …) behind SkillProvider
```

- Default: MCP tool → `BusSkillsRuntime` → `StdioBus.request` → `bus-worker.mjs` (the authority) → reply.
- Alt (explicit): MCP tool → in-process `InProcessSkillsRuntime` (loopback, no serialization).
- The dispatcher and composition are identical on both; only the transport wrapper differs.

## 7. Path to Done (ordered — composition parity FIRST)

Order matters: a shared dispatcher on top of two different compositions would give a false sense of SOLID
while preserving behavioral drift. So:

1. **Unify production composition** (highest present risk): one shared composition factory; bring
   `bus-worker.ts` to production parity (`search: true`, same trust/namespace/admission). **Remove the
   `OriginAllowlist` (incl. `withOriginAllowlist`) from both entrypoints and `http-skill-provider.ts`.**
   The factory is called by every process that hosts authority (worker always; mcp-server only in-process
   mode); each entrypoint stays its own composition root (no singleton).
2. **Unify capability dispatch**: one shared capability catalog; the bus worker delegates to
   `runtime.request(capability, input)` (no parallel `admissionHandler.handle` route);
   `InProcessSkillsRuntime.request()` stays the single authority-side dispatcher; the MCP adapter keeps its
   tool→method mapping; align `capabilities()` with the dispatchable set.
3. **Make the default MCP server bus-hosted, ephemeral per-call** (only after parity): `mcp-server.ts`
   selects the bus transport; a startup flag/env forces in-process. Lifecycle: lazy start, graceful stop on
   signals, worker fault → typed `bus:<pool>` error (never a throw), no silent fallback. No reliance on a
   worker surviving between requests.
4. **HTTPS resilience**: bounded retry + clear typed error on the acquire fetch (no durable record).
5. **Lock invariants + acceptance gates** (§8). No `instances:1`-as-state; durable read-back across worker
   lifetimes is explicitly deferred to the bus-to-bus milestone.

## 8. Acceptance Gates (not just tests)

- `verify-package` and the live E2E prove the **installed default** MCP path is **bus-hosted** (the
  request path actually goes through the bundled bus worker), via the package's own worker — not a
  hand-copied harness.
- **`admit_skill` and `read_skill` are independent bus requests**: correctness MUST NOT depend on worker
  reuse or on in-memory state surviving between them. Durable read-back across worker lifetimes is **out of
  scope** (bus-to-bus milestone) and is asserted as such, not as a passing admit→read-back-later test.
- **Search-ranking parity**: `search_skills` returns the native-index ranking on the default (bus) path,
  byte-for-byte with the pre-amendment behavior (compatibility-critical).
- **HTTPS acquire** has bounded retry + a clear typed error on exhaustion (returned, never thrown).
- **No `OriginAllowlist`** remains in either entrypoint or `http-skill-provider.ts`.
- **MCP reads the packaged manifest for rendering metadata only**; membership/resolution authority stays
  the runtime (`runtime.list()`), never the manifest — guard against a manifest-driven `list_skills`.
- **No silent fallback** bus→in-process; **no per-call mixing**.
- Gates run: `yarn build` → `yarn ci` (typecheck → validate → test) → `yarn test:coverage` (80% held) →
  `yarn verify:package` → installed live-E2E. The installed bus-default proof runs where the native kernel
  is available; the deterministic worker NDJSON round-trip remains the packaging proof.

## 9. Risks & Boundaries

- **Native addon + child process cost.** Bus-default adds the `@stdiobus/node` native addon load and a
  child worker for every consumer. Accepted as the cost of being a stdio Bus product; in-process remains
  the explicit escape for environments that cannot or should not pay it.
- **Admission is per-call, not durable.** The bus worker is ephemeral; admitted providers live only for
  the request and are not relied upon between requests. The "fetched-external → must record → survive a
  process going down" case is the EXPLICIT next-milestone **bus-to-bus (шина-шина)** work, deliberately
  deferred — not a hidden defect.
- **Do not over-claim.** This is bus-hosted runtime AUTHORITY (a deployment layer). It is NOT M-002 §12-B
  worker-hosted provider placement, NOT an external multi-agent orchestration, NOT a marketplace. No
  per-call serialization of the in-process path.

## 10. Scope Boundary

In scope: one composition factory; one capability dispatcher (single authority request path); bus-hosted
ephemeral per-call default; in-process via startup flag; **removal of `OriginAllowlist`**; HTTPS bounded
retry + clear typed error; parity acceptance gates. Out of scope: Milestone-003; durable/record-and-survive
admission state (the bus-to-bus milestone); `instances:1`-as-session-state; pools >1 as a state mechanism;
worker-hosted/remote PROVIDER placement (M-002 §12 descriptor-shape, unexercised); origin-governance /
SSL-key / certificate features; any new capability domain.

## 11. References

- `docs/research/milestone-001-federated-skills-runtime.md` — §5.5 (no split-brain), §5.7 (transport is a
  deployment detail, not a per-call tax).
- `docs/research/milestone-002-provider-boundary.md` — provider boundary, admission, §12 placement spike.
- `.kiro/specs/provider-boundary/{requirements,design,tasks,tasks-bugfix}.md` — formal spec + bugfix backlog
  (B1–B6); this amendment's tasks land as an M-002 default-placement amendment there.
- Code: `agent-skills/mcp-server.ts`, `runtime/transport/{factory,bus-runtime,bus-worker,param-codec}.ts`,
  `runtime/in-process-runtime.ts`, `lib/build-server.ts`, `runtime/providers/{filesystem,http-skill}-provider.ts`,
  `runtime/admission/**`, `runtime/admission/origin-allowlist.ts`.
- Companion dialogue logs listed in the header (non-normative).
