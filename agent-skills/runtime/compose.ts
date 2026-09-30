/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Production-runtime composition factory (M-002 amendment, Task U1; R&D §5 "Extract one
 * shared production-composition factory", Inv 5/6).
 *
 * ─── ONE COMPOSITION, CALLED BY SEPARATE COMPOSITION ROOTS ──────────────────────────
 *
 * Before this factory the two production entrypoints — `mcp-server.ts` (the published `bin`)
 * and `runtime/transport/bus-worker.ts` (the bundled worker) — each hand-wired the authority
 * composition, and they DRIFTED: the worker ran the bundled provider with native search OFF
 * (served by the list+substring fallback) while the MCP server ran it with `{ search: true }`
 * (the native keyword index); the worker wired the HTTPS blueprint with no allowlist while the
 * MCP server wired an operator origin allowlist; the worker omitted the in-process admission
 * seam the MCP server wired. Same operation, different behaviour per entrypoint — the
 * split-brain M-001 §5.5 forbids.
 *
 * {@link composeSkillsRuntime} is the SINGLE definition of "the production runtime": one
 * provider set (bundled filesystem provider with native search enabled), one trust lookup,
 * one namespace-ownership table, one admission authority over the SAME provider view the
 * runtime reads from, and the in-process admission seam wired so `request(skills.add.v1, …)`
 * is the production path. Every process that hosts authority calls it.
 *
 * ─── FACTORY, NOT SINGLETON (Inv 6) ─────────────────────────────────────────────────
 *
 * This is a function that returns FRESH instances on every call — there is no module-global
 * instance, no exported mutable runtime, and no runtime object shared across processes. Each
 * entrypoint remains its OWN composition root: it calls this factory exactly once at startup
 * and owns the returned graph for that process's lifetime. The bus worker calls it always; the
 * MCP server calls it only when hosting authority in-process (the bus-default path obtains a
 * `BusSkillsRuntime` instead and does NOT build a second authority composition).
 *
 * ─── BASELINE PRESERVATION (Req 15.1, 15.2) ─────────────────────────────────────────
 *
 * The bundled provider seeds a {@link MutableProviderView}; the runtime reads from THAT view
 * and the admission `register` stage admits (copy-on-write) into the SAME view. A single
 * bundled provider yields the identical `providers()` snapshot a constant view would, so the
 * proven read/list/search/reference baseline is byte-for-byte unchanged. The bundled provider
 * keeps its EFFECTIVE first-party `bundledTrustPolicy(packageRoot)`; any unknown id (an
 * admitted external provider, keyed by its claimed namespace) resolves to the least-privileged
 * `UNTRUSTED_DEFAULT`.
 */

import { createFileResolver } from '../lib/file-resolver.js';
import { FilesystemSkillProvider } from './providers/filesystem-provider.js';
import { HttpSkillProviderBlueprint } from './providers/http-skill-provider.js';
import { MutableProviderView } from './registry.js';
import { InProcessSkillsRuntime, type TrustLookup } from './in-process-runtime.js';
import { AdmissionController } from './admission/admission-controller.js';
import { AdmissionCapabilityHandler } from './admission/admission-capabilities.js';
import { ProviderBlueprintRegistry } from './admission/blueprint-registry.js';
import { NamespaceOwnershipTable } from './admission/namespace-ownership.js';
import { OperationBudget } from './admission/operation-budget.js';
import { Sha256ContentHasher } from './admission/content-hasher.js';
import { bundledTrustPolicy, UNTRUSTED_DEFAULT, type TrustPolicy } from './trust.js';

/**
 * Default per-operation admission budget, in milliseconds.
 *
 * Bounds the WHOLE `skills.add.v1` admission pipeline (`discover → … → register`) under one
 * linked signal, so a slow/unavailable external origin cannot hang the host. The same value
 * both production entrypoints previously armed independently — now armed once, here.
 * Interim/policy value, not frozen; the HTTPS provider also arms its own per-fetch timeout.
 */
const ADMISSION_BUDGET_MS = 30_000;

/**
 * The authority graph a single composition root owns for its process lifetime.
 *
 * - `runtime` — the in-process authority every transport wraps. Reads from the same provider
 *   view the admission `register` stage mutates, and is wired with the in-process admission
 *   seam so `request(skills.add.v1, …)` reaches admission through the SAME `request` path.
 * - `admissionHandler` — the single admission capability handler over the SAME controller the
 *   runtime's seam delegates to. Exposed so a transport entry (the bus worker) can reach
 *   admission without re-composing the stack.
 * - `packageRoot` — the resolved bundled package root, for diagnostics.
 */
export interface SkillsComposition {
  readonly runtime: InProcessSkillsRuntime;
  readonly admissionHandler: AdmissionCapabilityHandler;
  readonly packageRoot: string;
}

/**
 * Build the single production authority composition (Task U1).
 *
 * Returns FRESH instances on every call — no module singleton, no shared mutable runtime. The
 * caller is the composition root and owns the returned graph.
 */
export function composeSkillsRuntime(): SkillsComposition {
  // Bundled-layout package root — the EXACT resolution both entrypoints used
  // (`createFileResolver().packageRoot`, i.e. `path.resolve(__dirname, '..', '..')`),
  // correct from every execution location (bundled `out/dist/*.mjs` and dev/tsx source).
  const packageRoot = createFileResolver().packageRoot;

  // The one canonical provider set: the bundled filesystem provider with NATIVE search ENABLED
  // so `runtime.search()` serves the keyword index (preserving published ranking) instead of
  // the list+substring fallback — the single behaviour both transports now share (Req 9.4,
  // 15.2). Pinning `packageRoot` keeps the provider's resolver on the same root the trust
  // policy is computed against.
  const bundled = new FilesystemSkillProvider({ packageRoot, search: true });

  // The runtime reads from THIS view; the admission `register` stage admits (copy-on-write)
  // into the SAME view, so an admitted provider becomes visible to the next runtime operation
  // with nothing new spawned.
  const view = new MutableProviderView([bundled]);
  const namespaces = new NamespaceOwnershipTable();

  // Per-provider trust lookup: the bundled (first-party) provider keeps its EFFECTIVE
  // `bundledTrustPolicy(packageRoot)` (so its read/list/search/reference baseline — incl. the
  // path-traversal and content-size boundaries — is byte-for-byte unchanged); any unknown id
  // (an admitted external provider, whose id is its claimed namespace) resolves to the
  // least-privileged `UNTRUSTED_DEFAULT`. Keyed on `bundled.id`, never a literal, so the
  // bundled entry can never silently fall through to the untrusted default.
  const policyById = new Map<string, TrustPolicy>([[bundled.id, bundledTrustPolicy(packageRoot)]]);
  const trustOf: TrustLookup = (providerId) => policyById.get(providerId) ?? UNTRUSTED_DEFAULT;

  // The single admission authority over the SAME view + namespace table. The HTTPS blueprint is
  // the one external factory M-002 ships; the no-credential adapter is the default (public
  // origins). No origin allowlist (M-002 amendment Inv 11): external content stays safe by
  // being untrusted-as-data, size/time-bounded, never executed, and namespace-governed.
  const blueprints = new ProviderBlueprintRegistry();
  blueprints.register(new HttpSkillProviderBlueprint());
  const admissionController = new AdmissionController(
    blueprints,
    view,
    namespaces,
    new OperationBudget(ADMISSION_BUDGET_MS),
    new Sha256ContentHasher(),
  );
  const admissionHandler = new AdmissionCapabilityHandler(admissionController);

  // The runtime shares the SAME view the `register` stage mutates and the SAME namespace table
  // the controller holds (so the per-operation anti-spoofing boundary consults the same source
  // of truth as admission-time `claim`), and is wired with the in-process admission seam so
  // `request(skills.add.v1, …)` is the real production path.
  const runtime = new InProcessSkillsRuntime(view, trustOf, namespaces, admissionHandler);

  return { runtime, admissionHandler, packageRoot };
}
