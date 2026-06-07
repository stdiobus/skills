<!--
  @license
  Copyright 2026-present Raman Marozau, raman@stdiobus.com
  SPDX-License-Identifier: Apache-2.0
-->

# R&D Milestone 001 — From Filesystem-Bound Package to Federated Skills Runtime

> Status: **Accepted direction** · Date: 2026-06-07 · Scope: `@stdiobus/skills`
> Companion dialogue log: `.ai/architecture/architecture-skills-registry-vs-agentic-orchestration-2026-06-07.md`

## 1. Purpose

This document fixes a research milestone. It is **not** a full specification and **not** an
implementation plan. It records:

- which premises we now consider **settled** (so we do not relitigate them),
- which architectural **decisions** are accepted,
- which **invariants/contracts** any future implementation must preserve,
- the **target shape** that follows from those invariants,
- the **open questions** that remain for the next research step.

Frame: this is a long-lived, world-scale system. MVP / "package reader" reasoning is explicitly
out of scope (see §4).

## 2. Current State (facts, verified from code)

Strictly descriptive. No evaluation here.

- The package ships **one MCP server** (`agent-skills/mcp-server.ts`) exposing **5 read-only tools**:
  `list_skills`, `read_skill`, `list_references`, `read_reference`, `search_skills`.
- Transport today is `StdioServerTransport` from `@modelcontextprotocol/sdk`. **stdio Bus is not on any
  execution path.**
- The single source of truth is the **filesystem package root**. `lib/file-resolver.ts` resolves
  every skill from `packageRoot/agent-skills/{name}/SKILL.md`. It carries a verified marker comment
  (`// @toto: include merging by custom manifest`), but **no provider or manifest merging exists today**.
- Three closed-world coupling points hold skill identity fixed at build time:
  1. **`SkillName` enum** (`agent-skills/types.ts`) — closed set; `mcp-server.ts` builds
     `z.enum(VALID_SKILLS)` from it, so the tool schema rejects any non-enumerated skill.
  2. **`LAYER_ASSIGNMENT`** (`agent-skills/scripts/validate-skills.ts`) — per-name map;
     `validateLayerAssignment` hard-fails with `Unknown skill name` for anything absent.
  3. **`file-resolver`** — single `packageRoot`, no provider merging.
- `@stdiobus/node` is a **dependency** and `@stdiobus/mcp-agentic` is a **devDependency**, but neither is
  imported in server source. They appear only in skill *content* and metadata/branding.
- `mcp-agentic` execution model (verified in installed `.d.ts`): `AgentExecutor` is the single
  abstraction; **both** `InProcessExecutor` and `WorkerExecutor` implement it. Tool handlers depend only
  on the interface, not on concrete executors. `InProcessExecutor.prompt()` invokes the handler by a
  **direct in-process call** — no subprocess, no serialization. `AgentHandler` requires only `id` plus
  one of `prompt` / `stream`; **an LLM is not required**.

## 3. Problem Statement

The three coupling points in §2 are **symptoms**, not the problem. The problem is a model mismatch:

> The current implementation models skills as **bundled filesystem assets**. The target product
> requires **open-world, federated skill identity** with dynamic providers, mandatory provenance, and
> location-transparent execution.

The three closed-world points are the concrete blockers that make the current model unable to express
the target one. Treating this as a refactor of those three spots would miss the point — it is a change
of the identity and execution model.

## 4. Rejected Premises / Resolved Debates

Recorded to prevent re-litigation. These are **closed**.

- **Not an MVP / not a "package reader."** Design targets a long-lived, world-scale federated runtime.
  YAGNI / "premature infrastructure" reasoning does not apply to the runtime contract.
- **Read-path latency is not a deciding objection for the target contract.** Local execution can use
  `InProcessExecutor` direct handler calls without subprocess or serialization; stdio Bus is a native,
  C-level transport. The earlier "×N serialization tax on read" argument was based on a wrong cost model
  and is withdrawn. Actual transport costs remain deployment-specific.
- **"Agent" does not imply LLM.** An agent is a named, discoverable, location-transparent *method of
  execution*. LLM is one optional kind of executor, not a requirement. A prompt-shaped contract is not
  synonymous with LLM: `classify` may use an LLM, a deterministic fallback, or a manual policy.
- **The filesystem is an implementation detail**, not the registry identity model.
- **Unknown skill names are not invalid by default.** In the target system, an unknown name resolves to a
  custom/uncategorized descriptor; it does not hard-fail.
- **MCP is an adapter, not the authoritative runtime boundary.** Authority lives in the runtime contract.

## 5. Architectural Invariants / Contracts

What must remain true under *any* implementation. This section outranks §6 — decisions may be refined,
invariants hold the architecture from sliding back to the old model.

1. **Open-world skill identity.** The set of skills is computed at runtime, never a closed compile-time enum.
2. **`SkillDescriptor` is the identity unit.** Registry-level metadata, not a filesystem path:
   `{ name, provider, path/source, layer?, category?, pinned?, fqid? }`. An FQID is required at runtime
   for dedupe/provenance; its exact format remains open (§10).
3. **Published skills are a pinned subset, not a closed enum.** Backward compatibility is preserved by
   pinning, not by freezing the identity model.
4. **Every operation returns provenance.** Provenance is part of the **result envelope**, never a
   side-channel. The form is fixed; **the exact field set remains open (§10)**. Illustrative shape only:

   ```ts
   // Illustrative — fields are not final (see §10).
   type SkillResult<T> = {
     data: T;
     provenance: {
       fqid: string;          // fully-qualified skill id
       provider: string;      // resolving provider
       source: string;        // concrete origin (path, git ref, registry url, ...)
       // additional fields (version, contentHash, pinned, trust, resolvedAt, ...) TBD
     };
   };
   ```

5. **One `SkillsRuntime` capability contract for all operations** (`read/search/list/fetch/add`). No
   split-brain: add/import, read, search, and list must all see the same source of truth through the
   same contract.
6. **Two contract shapes, by operation nature:**
   - **Typed capability contract** for `read/search/list/fetch/add` — typed args, typed results,
     provenance envelope. Not the prompt(string) shape.
   - **Prompt agent contract** (`AgentHandler.prompt`) for `classify` and other prompt-shaped / LLM-ish
     operations.
7. **Transport is a deployment detail of the runtime, not a per-call tax.** The same capability runs
   in-process (loopback, no serialization) or over stdio Bus (worker / remote) behind one contract.
8. **The MCP server is a thin adapter** over `SkillsRuntime`. Compatibility of the existing tool surface
   is preserved during migration where possible and staged explicitly (see §9), not assumed absolute.
9. **Providers participate through the runtime/Bus contract.** A provider is a runtime participant, not a
   hardcoded path.
10. **Validation is declarative and profile-based.** Rules are data (base profile + optional overlay),
    not constants in code.
11. **Layer/category assignment is best-effort and fallback-safe.** Low confidence falls back to a custom
    category; it never blocks resolution.

## 6. Decisions Reached

Format per decision: *Decision · Rationale · Implication.*

- **Replace `SkillName` enum with a dynamic registry.**
  Rationale: closed enum is incompatible with open-world identity (§5.1).
  Implication: schema validation no longer rejects names against a closed compile-time enum; published
  names remain valid via pinning.
- **Represent the published collection as a pinned subset.**
  Rationale: backward compatibility without freezing the model (§5.3).
  Implication: a pinned manifest carries layer/category for current skills.
- **Move validation to declarative profiles.**
  Rationale: domain rules must not be hardwired constants (§5.10).
  Implication: base `agentskills.io` profile + optional domain overlay for the published collection.
- **Use a Bus-backed `SkillsRuntime` for `read/search/list/fetch/add`.**
  Rationale: single source of truth, location transparency, provenance everywhere (§5.5, §5.7).
  Implication: MCP tools delegate to the runtime; transport is selectable per deployment.
- **Keep the MCP server as a thin adapter.**
  Rationale: stable external surface, authority in the runtime (§5.8).
  Implication: tool handlers contain no resolution logic beyond calling the runtime.
- **Distinguish typed capability contracts from prompt-based agent contracts.**
  Rationale: typed reads must not lose types through a prompt(string) shape (§5.6).
  Implication: `classify` is the prompt-shaped exception; reads/searches are typed.
- **Model providers as runtime participants.**
  Rationale: federation requires pluggable, discoverable backends (§5.9).
  Implication: filesystem `packageRoot` becomes one default provider among many.

## 7. Target Architecture

Reads as a consequence of §5–§6.

```text
MCP Tools  (thin adapter, stable external surface)
   └─> SkillsRuntime  (single capability contract; provenance envelope on every result)
         └─> Bus execution substrate  (in-process loopback OR stdio Bus worker/remote)
               └─> Provider agents / handlers
                     └─> filesystem · npm · git ref · remote registry · DB · org-private · virtual
```

Operation flows (the contract shape differs by nature):

- `read_skill` / `read_reference` — **typed capability**; resolve descriptor → provider → content;
  returns `SkillResult<...>` with provenance.
- `search_skills` / `list_skills` — **typed capability, federation-ready**; dedupe by stable skill
  identity (FQID); provenance per entry. Fan-out / backpressure / cancellation model to be specified.
- `fetch` / `add` (import a skill from a provider) — **typed capability**, possibly out-of-process via a
  Bus worker for isolation of untrusted content; mutates the registry.
- `classify` — **prompt agent contract** (`AgentHandler.prompt`); LLM-ish, optional, **fallback-safe**;
  never the source of truth without persisted metadata.

## 8. Validation & Classification Model

Pulled out of Decisions because future disagreement will land here first.

- **Open-world validation** — unknown identity is valid input, routed to custom/uncategorized.
- **Base profile** — `agentskills.io` structural rules (name, frontmatter, body sections) apply to all.
- **Published overlay** — the domain profile covering published-collection constraints such as layers,
  terminology, and compatibility rules; applies **only** to the published collection, not to external skills.
- **Pinned compatibility** — published skills keep their pinned layer/category; pinning overrides
  inference.
- **Unknown handling** — warning/fallback, never fatal.
- **Layer/category** — best-effort; fallback to custom category on low confidence.
- **LLM classification is assistive**, not a critical-path hard dependency. It can become authoritative
  only when persisted as metadata or overridden/pinned manually.

## 9. Migration / Compatibility Strategy

A world-scale system must state how it moves without a big bang.

- Existing published skills become **pinned descriptors** in the registry.
- The current filesystem `packageRoot` becomes **one default provider**.
- Current MCP tools remain **externally stable** throughout.
- Enum-derived assumptions are **deprecated internally first**, before any external change.
- Validation shifts from **fatal-unknown to warning/fallback**.
- Provenance is added to **internal/runtime results first**; MCP-level exposure can be staged.

## 10. Open Questions / Next Research Steps

**Open Questions**

- FQID format (`provider/collection:name@version`?) and collision/dedup rules.
- Exact provenance field set and required-vs-optional split.
- Provider trust model and trust tiers.
- Conflict resolution between providers (override vs clash).
- Cache and invalidation strategy for remote providers.
- How much of the Bus/runtime contract is public API vs internal.
- Staging of MCP response-shape changes (provenance exposure) without breaking clients.

**Next Research Steps**

- Inspect the `McpAgenticServer` execution/registration path end-to-end.
- Prototype `SkillsRuntime.read` over `InProcessExecutor` (typed contract, no serialization).
- Model two providers and dedupe by FQID.
- Draft a declarative validation profile (base + overlay).
- Classify one unknown skill through the fallback path.

## 11. Spike Outcome — Contract Fixed on Facts (2026-06-07)

The first "Next Research Step" is **done**. The `SkillsRuntime` contract is no longer paper;
it is anchored by an executed spike against the real package.

**Contract location (the generative foundation):**

- `agent-skills/runtime/contract.ts` — `SkillsRuntime`, `SkillProvider`, `SkillRef`,
  `SkillDescriptor`, `ResolvedSkill`, `Provenance`/`ProvenanceSeed`, `SkillResponse<T>`
  (discriminated, with a returned `SkillRuntimeError` model — never thrown across the boundary),
  and `CapabilityRef` (typed extension seam).
- `agent-skills/runtime/capabilities.ts` — versioned core capability descriptors
  (`skills.read.v1`, `skills.list.v1`, `skills.search.v1`, `skills.references.list.v1`,
  `skills.references.read.v1`). Wire method strings are generated from typed descriptors.
- `agent-skills/runtime/providers/filesystem-provider.ts` — bundled provider reusing the
  existing `FileResolver` (no disk-I/O rewrite); intentionally `search: false`.
- `agent-skills/runtime/in-process-runtime.ts` — in-process `SkillsRuntime` (direct calls,
  no serialization); finalizes provenance, enforces ambiguity policy, orchestrates fallback.
- `agent-skills/runtime/__spike__/` — `read-spike.ts` (in-process facts, executed),
  `transport-shape.proof.ts` (compile-time), `bus-worker.ts` + `bus-read-spike.ts`
  (REAL stdio Bus end-to-end: native kernel + spawned worker process).

**Facts verified** (`yarn typecheck` ✓, `yarn tsx … read-spike.ts` → ALL FACTS HELD, `yarn validate` ✓):

1. Legacy compatibility — `read({ kind: 'name', name })` returns real SKILL.md content
   (12 837 bytes for `runtime-concepts`) via the existing resolver.
2. Open-world identity — an unknown name returns typed `not_found`, no throw, no enum gate.
3. Provider boundary — the filesystem provider is one entry in a providers array; the runtime
   holds no package root.
4. Provenance envelope — runtime-built `{ fqid, provider, source, resolvedFrom }` on success.
5. Ambiguity policy — two providers resolving one name under different FQIDs yield typed
   `ambiguous` with candidates; no silent first-match.
6. Transport — **REAL bus round-trip** (`yarn tsx … bus-read-spike.ts` → REAL BUS ROUND-TRIP HELD).
   A native `StdioBus` kernel spawned a real worker process (`bus-worker.ts`) serving the
   SkillsRuntime; `bus.request('skills.read.v1', …)` returned the typed
   `SkillResponse<SkillContent>` (12 837 bytes + provenance) over NDJSON JSON-RPC, and an
   unknown name returned a typed `not_found` over the wire. Measured traffic:
   `messagesIn=3 messagesOut=3 bytesOut=16727 routingErrors=0`. The typed envelope rides the
   bus without collapsing to the prompt shape. (`transport-shape.proof.ts` remains as the
   compile-time companion proof.)
7. Capability fallback — provider lacking `search` does not break; runtime degrades to
   list+substring and records it in provenance (`search:fallback(list+substring)`).

**Honest scope of the spike:** facts 1, 4, 7 and the bus round-trip (6) are executed against
real files / a real bus. Fact 5 (ambiguity) exercises real runtime logic but with a synthetic
second provider (`MirrorProvider`) — over the bus the worker *is* the runtime, so multi-provider
ambiguity is runtime-internal and transport-independent. A real second on-disk provider is a
follow-up if we want ambiguity proven end-to-end too.

**Confirmed design properties:** core is a closed set of *operations*, not identities;
`request(capability, input)` is the open extension seam mapping onto bus method strings;
providers are capability-optional with runtime-orchestrated fallback.

**Note — coverage gate:** the new `agent-skills/runtime/**` files are spike code and have no
tests yet, so a full `yarn test` would fail the 80% coverage threshold. This is expected for
a spike. Tests arrive when the spike is promoted through spec → implementation; until then the
runtime files should be coverage-excluded or the suite run is deferred.
