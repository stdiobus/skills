<!--
  @license
  Copyright 2026-present Raman Marozau, raman@stdiobus.com
  SPDX-License-Identifier: Apache-2.0
-->

# R&D Milestone 002 — Provider Boundary: Federated Admission of an External Provider over the stdio Bus

> Status: **Accepted direction** · Date: 2026-06-08 · Scope: `@stdiobus/skills`
> Builds on: `docs/research/milestone-001-federated-skills-runtime.md` (Milestone-001, accepted)
> Formal spec: `.kiro/specs/provider-boundary/{requirements.md, design.md, tasks.md}`
> Seed backlog: `.kiro/specs/provider-boundary/tasks.draft.md` (Tier F, T24–T30)
> Companion dialogue logs: `.ai/architecture/architecture-provider-boundary-t28-admission-2026-06-08.md`,
> `.ai/architecture/architecture-milestone-002-scope-alignment-2026-06-08.md`,
> `.ai/architecture/architecture-milestone-002-sequencing-no-blind-code-2026-06-08.md`

## 0. The One Thing This Milestone Must Deliver

> **Milestone-002 is closed only when an agent can ADD an external skill provider through the
> provider boundary — its descriptor admitted, the provider materialized **in-process in the
> existing runtime** (no new bus or worker spawned), its skill content fetched (over HTTPS where the
> content lives), FEDERATED with the bundled provider, and READ back — proven end-to-end over the
> real transports (MCP stdio AND the existing stdio Bus worker), with no mocks.**

Every section serves that sentence. Out, explicitly and permanently: **no localhost scope, no MVP,
no Milestone-003, no certificate / TLS-trust / supply-chain feature, and — by the owner's locked
decision — no additional workers and no additional bus** (an additional bus is a different
framework, out of scope). HTTPS fetch is one detail of how an external provider obtains content; it
is **not** the milestone. The milestone is the **provider boundary** — how a provider that the
runtime was not born with crosses into the runtime and federates, **in-process under the already-running
bus**.

## 1. Purpose & Scope

This document fixes the **solution direction for Milestone-002 (Provider Boundary)**. Like
Milestone-001 it is a milestone narrative, not the implementation plan and not the formal spec. It
records, for a long-lived federated runtime (not an MVP):

- **what** M-002 adds — admitting and federating an external provider, with `fetch`/`add` as the
  originating capability,
- **how** it is shaped — the provider **placement model** over the stdio Bus (descriptor + factory
  registry), the admission pipeline, federation across providers, boundary governance, dynamic visibility,
- **for what** — a mock-free proof over **both** real transports that closes the epic,
- and **the boundary** of what is deliberately out of scope.

Formal, testable acceptance lives in `.kiro/specs/provider-boundary/requirements.md` (EARS),
referenced here by identifier; mechanical design in `design.md`; ordered work in `tasks.md`. The
in-scope minimums are drawn from `tasks.draft.md` Tier F (T24–T30).

## 2. Current State (facts, verified from code)

**Proven and in place (Milestone-001):**

- One `SkillsRuntime` contract — `read/list/search/getReferences/readReference` + the open
  `request<TInput,TOutput>` seam; every result a returned, never-thrown `SkillResponse<T>` with provenance.
- **Three proven execution paths, one contract:** the **in-process** runtime path, the thin **MCP stdio**
  adapter, and a **real stdio Bus** runtime path (native kernel + spawned worker, typed `SkillResponse` over
  NDJSON), selected by a transport factory. (In-process is an implementation path; the two *live* transports
  a consumer sees are **MCP stdio** and the **stdio Bus**.)
- Federation mechanics: an ordered provider registry, aggregate `list`/`search` with per-source
  diagnostics and FQID dedupe/conflict surfacing (`dedupeWithConflicts`) — built, but never exercised with
  a real second provider.
- A trust posture (`trust.ts`, untrusted default) and a pure, returned-never-thrown content/path guard
  (`security/boundary.ts`).
- The MCP server is a thin adapter (5 tools) over `buildSkillsMcpServer`; bundled collection is
  **17 skills** (`runtime-*` + `stdiobus-sdk-*`).
- The ecosystem already ships **`@stdiobus/workers-registry`**: real providers/agents hosted as **stdio Bus
  workers**, with OAuth/credential handling for providers that require authentication.

**The gap (why M-002 exists):**

1. **No admission.** No `fetch`/`add` capability — an agent cannot bring in a skill/provider from outside
   the bundled package (`skills add` does not exist).
2. **No provider placement model.** A *live* provider cannot cross a transport boundary, and there is no
   worker-side factory to rebuild a provider from a descriptor. So a **worker-hosted / remote** provider over
   the bus is impossible without a core unwind (`tasks.draft.md` T24).
3. **Federation is unexercised.** Only the bundled provider exists; aggregate/dedupe/conflict/partial-failure
   has never run against a real second provider.
4. **The provider set is frozen at construction.** The runtime snapshots its providers at build time, so an
   admitted provider would not become visible to later operations.
5. **No boundary governance.** There is no namespace ownership, no provider-output ingress validation, no
   per-operation lifecycle/timeout/abort, and no capability-version declaration for an untrusted external participant.

## 3. Problem Statement

The need: **an agent must acquire a provider the runtime was not born with — hosted in-process or as a stdio
Bus worker — admit it safely, federate it with the bundled provider, and use its skills through the same
runtime.** Today the runtime can only federate providers fixed at construction.

This is a missing **boundary**, not a missing function, and the bus is the transport for *providers*, not
only for MCP tool calls. Admitting an external provider forces these to become real: a **placement model**
(a serializable descriptor crosses, not a live object; a factory rebuilds it), **admission** (fetch/add),
**identity governance** (no impersonation of the bundled namespace), **content-as-data** (never executed),
**federation visibility** (the admitted provider appears in later operations), and **lifecycle** (a remote
worker can be slow/unavailable). HTTPS itself is not a project — the platform's standard TLS handles
transport security; authentication, where a provider needs it, is **reused** from `@stdiobus/workers-registry`
over the bus, not reimplemented.

## 4. Non-Relitigation Boundary (inherited from Milestone-001)

Settled by Milestone-001, not reopened: the `SkillsRuntime` contract surface and returned-never-thrown
`SkillResponse`; open-world identity and FQID (`provider:name[@version]`); capability-optional providers
with fallback; **transport transparency (in-process and stdio Bus behind one contract)**; the typed-vs-prompt
split with assistive `classify`; the bundled byte-for-byte baseline and five-tool MCP surface. M-002 adds
capability on top; it does not alter them.

## 5. The Target Solution (what we build, in plain terms)

Six parts. The placement model is the core; HTTPS fetch is a detail inside one provider.

**5.1 Provider placement model over the stdio Bus — the core (T24).** A *live* provider never crosses a
transport boundary. What crosses is a serializable **`ProviderDescriptor`**
`{ factoryId, config, namespace, trust, capabilityVersions }`; a **worker-side factory registry** rebuilds
the provider via a typed **`ProviderBlueprint<TConfig>`** keyed by `factoryId`. This gives provider
**placement**: in-process, worker-hosted (stdio Bus), or remote. This is what makes federation over the
bus possible at all. *(Locked decision: M-002 exercises the **in-process** placement only — the admitted
provider is added to the **existing runtime**, which is already hosted both as the MCP stdio server and as
the existing stdio Bus worker, so the provider is reachable over **both** transports **without spawning a new
worker or bus**. The `worker-hosted` and `remote` placements are represented in the descriptor shape and were
proven viable by the spike (§12), but are NOT spawned in M-002 — an additional bus is a different framework,
out of scope.)*

**5.2 Admission pipeline (T28) — the originating capability.** A first-class `AdmissionController` runs a
fixed, named sequence (Req 1):

```text
discover → validate (config schema + descriptor/metadata shape, size)
        → acquire (the second provider's content-acquisition step — fetch over HTTPS where the content lives; size/time-bounded; reuse existing auth when required)
        → hash-record → admit-as-data (never execute) + namespace check → register | quarantine
```

(The `acquire` step is the *provider's* behaviour — HTTPS fetch is how the second provider gets its skill,
not the boundary itself; a different provider kind could acquire differently.)

Every stage is a real decision; a rejection at any stage stops and returns a typed **quarantine**
`SkillResponse` — never a throw (Req 8). The external entry point is a typed `skills.add.v1` capability over
the existing `request` seam — not a new core method, validated at the single ParamCodec boundary (Req 2).

**5.3 The second real provider — over the boundary, not a mock.** A genuinely external provider participates
through the placement model. It is admitted **in-process into the existing runtime** (no new worker or bus);
it acquires skill content over **HTTPS** (e.g. a public GitHub raw URL, and other HTTPS providers), with
authentication **consumed** from `@stdiobus/workers-registry` over the bus where required — never
reimplemented here (Req 9). Because the existing runtime is already hosted both as the MCP stdio server and
as the existing stdio Bus worker, the in-process provider is reachable over **both** transports with nothing
new spawned. HTTPS transport security is the platform's standard TLS/CA, not a built feature (§7).

**5.4 Federation across providers (Req 4-area mechanics).** With a real second provider, the existing
aggregate `list`/`search`, FQID dedupe, conflict surfacing, and partial-failure resilience
(`dedupeWithConflicts`) are exercised for real — bundled + admitted, per-`provider.id`, with per-source
diagnostics.

**5.5 Boundary governance.** Identity: a provider may only mint FQIDs under a namespace it **owns**; an
external provider claiming `bundled:*` (or another's prefix) is quarantined, governed by one
namespace-ownership source of truth (T25, Req 4). Every value a provider returns is validated at the ingress
boundary on **every** operation (T26-minimum). Admitted content is **data, never executed/`eval`'d/`require`'d**
and stays untrusted — M-002 does not promote provider trust (Req 5, 7). A minimal **lifecycle**: per-operation
timeout + `AbortSignal` cancellation so a slow/unavailable worker cannot hang the runtime (T29, Req 10). The
descriptor carries **capability-version** declarations from day one (T30). A content hash is recorded on
provenance, **record-only** — no dedupe/equality semantics (T27).

**5.6 Dynamic visibility — the per-operation snapshot.** A newly admitted provider must be visible to the
*next* operation without corrupting an in-flight one. The runtime keeps its per-`provider.id` federation loop
but reads providers from a stable registry **view**, taking exactly **one snapshot at each operation's entry**
and threading it through every helper; mutation is copy-on-write and **add-only** (Req 6).

**Read-after-add over both transports** is the payoff: after `skills.add.v1`, a `read` of the admitted
provider's skill returns its body — proven in-process **and** over the stdio Bus.

## 6. Architectural Invariants

Hold for all M-002 work; outrank convenience.

1. **Placement, not relocation.** A serializable `ProviderDescriptor` crosses the boundary and a factory
   rebuilds the provider; a live provider object never crosses a transport.
2. **Admission is total.** Every admission returns a typed `SkillResponse`/outcome; nothing throws across the boundary.
3. **External content is data.** Never executed, `eval`'d, `require`'d, or used to derive authority; it stays untrusted.
4. **Namespace ownership at the child id.** Identity cannot be spoofed; never masked by an aggregation layer.
5. **Per-operation provider consistency.** One snapshot per operation; the world may change *between*
   operations (open-world), never *within* one; admission is add-only.
6. **Real transport, real provider.** The proof federates over **both** MCP stdio and the **stdio Bus**, with a
   real external provider — no localhost, no mock, no toy.
7. **Reuse, don't rebuild.** The bus and worker-hosting are `@stdiobus`'s; authentication is the existing
   `@stdiobus/workers-registry`; HTTPS/TLS is the platform's. M-002 builds the **boundary**, not transport,
   auth, or trust infrastructure.

## 7. Scope & Non-Goals

**In scope (binding):** provider **placement model** — descriptor + worker-side factory registry, in-process /
worker-hosted / remote (T24); the admission pipeline (Req 1, 7, 8) and `skills.add.v1` over the request seam
(Req 2); a **real second provider** participating through the boundary — admitted **in-process into the
existing runtime** (no new worker/bus), fetching content over HTTPS, auth reused from
`@stdiobus/workers-registry` (Req 9); typed `ProviderBlueprint<TConfig>` with
config validation (Req 3, 13); **federation** exercised with two real providers (aggregate/dedupe/conflict/
partial-failure); **namespace ownership / anti-spoof** (T25, Req 4); **T26-minimum** provider-output ingress
validation every operation; **lifecycle** — per-op timeout + abort (T29, Req 10); **capability-version**
declaration in the descriptor (T30); **content-hash record-only** (T27); content-as-data + untrusted (Req 5, 7);
per-operation snapshot visibility, add-only (Req 6); size/time fetch bounds.

**Out of scope — simply not done (NOT a later milestone):** any certificate / custom-TLS-trust feature (the
platform's standard HTTPS trust is used as-is); content signing / provenance attestation; package-registry
reputation, revocation, typosquatting defenses; the full provider-output sanitizer beyond the minimum;
content-hash **dedupe/equality** semantics; capability-version **negotiation** (declaration only here);
dynamic provider **removal/dispose/eviction**; ACP as a first-class surface.

**Backward compatibility (Req 12):** production still registers only the bundled provider by default; the five
tools and their shapes are unchanged; the bundled byte-for-byte baseline and green `yarn ci` are preserved.

## 8. Definition of Done

M-002 is closed when **all** hold:

1. **The §0 proof passes end-to-end, mock-free, over BOTH live transports:** an external provider is admitted
   via the production admission path — its descriptor materialized **in-process in the existing runtime** (no
   new worker or bus) — its skill fetched over **HTTPS from a real provider** (e.g. a public GitHub raw URL),
   **federated** with the bundled provider, and **read back** — proven through the installed **MCP stdio**
   server **and** the **existing stdio Bus worker** (both wrap the same runtime), driven through the
   **installed** package (`npm pack` → install → boot the installed MCP server) (Req 11). (In-process call
   alone does not satisfy this; both live transports must serve it.)
2. **A bundled skill still reads byte-for-byte** through the installed server, and the **M-001 federation
   mechanics** (aggregate, FQID dedupe, conflict surfacing, partial-failure diagnostics) are exercised with the
   two real providers — no new equality/dedupe semantics introduced (Req 4, 11, 12).
3. **`verify-package` is corrected** to the true surface (17 skills; real manifest version) and is green before
   it gates the live E2E (Req 11).
4. **Safety is demonstrated:** quarantine on a namespace-spoof attempt, on oversize content
   (`content_too_large`), on invalid factory config, on malformed provider output, and a per-op
   timeout/abort returns a typed error — each returned, covered by focused tests (Req 4, 5, 7, 8, 10, 13).
5. **`yarn ci` is green** and new `agent-skills/runtime/**` code meets the 80% coverage gate (Req 12).

## 9. Path to Done (honest, mock-free increments)

No standalone "phase 0" gate and no toy smoke test. Real contract slices, each tested against a real boundary,
cutting by narrowing semantics, never by faking reality.

1. **Correctness (done in the working tree).** The shared `buildSkillsMcpServer` extraction + stale-test fix.
2. **Placement model** — `ProviderDescriptor`, `ProviderBlueprint<TConfig>` + factory registry, namespace
   ownership; a real second provider materialized **in-process first**.
3. **The HTTPS-fetching provider** — real fetch from a real HTTPS provider, size/time bounds, auth reused from
   `@stdiobus/workers-registry`.
4. **Admission spine** — `AdmissionController` + stages + `skills.add.v1` + ParamCodec + config validation +
   per-op timeout/abort + the per-operation snapshot, with focused real tests.
5. **Federation with two real providers** — aggregate/dedupe/conflict/partial-failure exercised for real.
6. **In-process admission visible over both transports** — the admitted provider lives in the existing
   runtime, which the existing MCP stdio adapter AND the existing stdio Bus worker both wrap; first vertical
   E2E over MCP stdio, then over the existing stdio Bus worker. **No new worker or bus is spawned.**
7. **Installed-package live E2E** + the `verify-package` correction.

By the time the live E2E runs, every sub-contract already has a narrow real test, so a red E2E points at one
layer, not many.

Implementation style for all new code is governed by `docs/architecture/m002-architecture-style.md` — an
implementation convention referenced by the design's `§Conventions`, not a substitute for this narrative.

## 10. Risks & Open Questions

- **Real-provider availability in the e2e.** The proof fetches from a real provider (e.g. GitHub raw); it
  depends on that provider being reachable. Accepted by design — the test pins a stable public URL and fails
  honestly. **The live e2e MUST NOT silently fall back to localhost or a fixture** — that would reintroduce the
  mock framing this milestone removed.
- **Worker-hosted placement cost.** Hosting the admitted provider as a bus worker reuses the proven worker
  topology; the risk is wiring/lifecycle, mitigated by the timeout/abort lifecycle (T29) and the proven bus path.
- **Config as authority surface.** A provider `config` is validated by its typed `configSchema` before
  construction (Req 13); schemas are reviewed as security surface.
- **Content-as-data.** No code path executes fetched content; a tested invariant, not incidental.

## 11. References & Anti-Drift Rule

**Single source of truth (no duplication):**

- **This document** = the M-002 why/what/how + invariants + definition-of-done + path; references requirements
  by identifier, never restates acceptance language.
- `.kiro/specs/provider-boundary/requirements.md` = the formal EARS acceptance source.
- `.kiro/specs/provider-boundary/design.md` = the mechanical design; links here and to the style standard.
- `.kiro/specs/provider-boundary/tasks.draft.md` = the Tier-F seed backlog (T24–T30) this milestone draws from.
- `docs/architecture/m002-architecture-style.md` = implementation convention (code shape), not the solution.
- `.ai/architecture/*` = immutable companion dialogue records (non-normative).

**Spec-sync note.** `requirements.md` was drafted before this full-scope narrative and still carries a
narrower / localhost-tinged framing in places. It MUST be aligned to this scope — placement model (T24),
worker-hosted provider over the bus, federation with a real second provider, governance (T25/T26-min/T29/T30/
T27-record-only), auth reused from `@stdiobus/workers-registry`, no localhost, no certificate/trust-policy
feature — before `design.md` is finalized. **Until that sync lands, the requirement IDs cited here are intended
target mappings, not yet confirmed against the formal spec.**

**Precedence on conflict:** Milestone-001 invariants → this M-002 narrative (solution direction & invariants)
→ `requirements.md` (formal acceptance) → `design.md` → dialogue logs.

## 12. Spike Outcome — Provider Placement (executed 2026-06-08)

A throwaway spike (`agent-skills/runtime/__spike__/m002-placement/`, excluded from build/coverage,
never imported by production) empirically answered the open placement question the owner flagged —
*which placement(s) for the second provider actually work, and does the bus-to-bus chain collide?*
Each bus variant ran the anti-false-pass battery: ≥2 concurrent requests, a 32 KB payload, a forced
timeout, a post-timeout success, `routingErrors === 0`, clean stop, and an orphan-PID sweep. Real
HTTPS target: a public GitHub raw `LICENSE` (11 357 bytes).

**Verified facts (executed, not asserted):**

1. **`StdioBus` is a per-process singleton.** Constructing a second `StdioBus` in one process throws
   `"Bus already created"` — even after `stop()`. **Implication:** one bus per process; multi-bus
   topologies are multi-process. (This is a real constraint the design must honor, not a bug.)
2. **A — in-process real HTTPS: PASS.** A real HTTPS GET returns 11 357 bytes in-process.
3. **B — worker-hosted provider over the bus: 8/8 PASS.** Concurrency (no cross-wire), 32 KB payload
   intact, forced timeout fires predictably, a normal request succeeds *after* a timeout (no
   poisoning), **real HTTPS fetched through the worker** (11 357 bytes), `routingErrors=0`
   (`in=6 out=5 bytesOut=46089`), clean stop, **no orphan PIDs**. This is the recommended placement.
4. **C — nested bus-to-bus chain (the collision test): 8/8 PASS, no orphans.** The full chain
   `driver → busA → chain-worker → inner busB → provider-worker → GitHub` round-trips real HTTPS with
   concurrency, 32 KB payload, timeout, post-timeout recovery, `routingErrors=0`, clean stop. **The
   collision hypothesis is disproven:** a worker keeps its own stdin/stdout pure for the parent
   protocol while running a nested bus, because the inner bus spawns its children over their own
   child-process pipes and its diagnostics stay on stderr. The per-process-singleton rule is not
   violated because each process owns exactly one bus (driver = busA, chain-worker = busB).
5. **D — sibling worker pools on one bus, addressed by method: routing did NOT work.** Two pools
   started (`workers=2`, `routingErrors=0`) but neither worker received the request — `alpha.read` /
   `beta.read` resolved without dispatch. **Implication:** method→pool routing across sibling pools is
   **not automatic**; it needs explicit per-method registration/advertisement. Federating multiple
   providers therefore happens either **in-process** (the runtime holds the providers and may talk to
   worker-hosted ones over the bus) or with explicit method routing — *not* by naively dropping
   providers into sibling pools.

**Conclusion (feeds the design, not the code).** Worker-hosted (B) and the bus-to-bus chain (C) are **proven
viable** by the spike. But the owner's **locked M-002 decision is the in-process placement**: the admitted
provider is added to the **existing runtime** (which is already hosted both as the MCP stdio server and as the
existing stdio Bus worker), so it is reachable over **both** transports **without spawning any additional
worker or bus** — an additional bus is a different framework, out of scope. The design MUST honor: one
`StdioBus` per process; the admitted provider is in-process; cross-provider federation lives in the in-process
runtime; `worker-hosted` / `remote` remain descriptor-shape options for a future milestone, not exercised
here; sibling-pool-by-method federation is not free and is out of the default path. The spike code stays as
evidence under `__spike__/`; only these findings are promoted.
