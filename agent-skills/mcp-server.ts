/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MCP Skills Server — standalone executable (thin adapter).
 *
 * Exposes the 12 agent skills, their reference materials, and the skills
 * manifest as five MCP tools over stdio transport (JSON-RPC 2.0 / NDJSON).
 *
 * Start: `node out/dist/mcp-server.mjs`
 * Or:    `npx @stdiobus/skills`
 *
 * ─── Delegate-only adapter (Migration Step 3 — design §1, Req 9.4) ─────────────────
 *
 * Authority lives in the {@link SkillsRuntime}, not here. This adapter only:
 *   1. translates a tool call into a {@link SkillRef} / capability input,
 *   2. delegates to a transport-selected {@link SkillsRuntime}
 *      (default in-process, obtained from the provider registry), and
 *   3. renders the returned {@link SkillResponse} back to MCP tool output.
 *
 * The closed-world `z.enum(VALID_SKILLS)` gate is replaced with open-world
 * `z.string().min(1)` (Req 1.6, 9.1, 9.6): a non-published skill name is accepted as
 * input and, if no provider resolves it, surfaces as a typed `not_found` rendered as a
 * tool error (`isError: true`) — never a schema rejection or process termination.
 *
 * Open-world warning (Req 9.6): when a skill-addressing tool (`read_skill`,
 * `list_references`, `read_reference`) receives a `skill` name that is not in the
 * published set (the manifest's skill names), the adapter emits a non-fatal warning to
 * STDERR (the diagnostics channel). STDOUT stays strictly protocol-only (JSON-RPC /
 * NDJSON). Published-set membership decides ONLY whether to warn — it is never a
 * resolution gate: the call still delegates to the runtime and an unresolved name still
 * returns typed `not_found`. Published names emit no warning.
 *
 * Backward compatibility during the compatibility phase (Req 9.1, 9.2, 9.7, 9.8):
 *   - `read_skill` of a published name renders `SkillContent.body` raw — byte-for-byte
 *     identical, because the bundled provider reuses the same `FileResolver`.
 *   - `list_references` renders `JSON.stringify(paths)` (the same JSON array of paths).
 *   - `read_reference` renders the raw file body and preserves the `..` traversal guard.
 *   - `list_skills` delegates to `runtime.list()` and renders the result through the
 *     `ManifestPresenter`, which reconstructs the published manifest registry document
 *     (`JSON.stringify(manifest, null, 2)`) from the runtime's AUTHORITATIVE skill set —
 *     byte-for-byte identical because the bundled provider lists exactly the manifest
 *     skills in manifest order (Req 9.4, 9.8).
 *   - `search_skills` delegates to `runtime.search()` and renders the result through the
 *     `SearchPresenter`, preserving the published `{skill,score,description,layer,
 *     layerName}` shape and ranking. The legacy keyword index is now the bundled provider's
 *     native `search` implementation (enabled via `{ search: true }`), NOT an adapter
 *     side-channel (Req 9.4, 9.1).
 *   - Provenance is NOT surfaced at the MCP response level (Req 9.7); the renderers emit
 *     only the typed `data`, never the provenance envelope.
 *
 * ─── Staged provenance exposure (Migration Step 9 — design §1, §"Migration / Rollout
 *     Sequence" step 9, Req 9.7, 9.9) ───────────────────────────────────────────────
 *
 * Provenance exposure at the MCP response level is an OPT-IN, DECLARED, VERSIONED staged
 * change — never an implicit mutation of the existing shape (Req 9.9). It is governed by a
 * single declared flag {@link AdapterRenderOptions.exposeProvenance}, sourced for the
 * standalone executable from the {@link EXPOSE_PROVENANCE_ENV} environment variable and
 * DEFAULTING OFF (Req 9.7):
 *
 *   - OFF (default): the body/reference renderers emit output BYTE-IDENTICAL to the
 *     compatibility phase (raw body for `read_skill`/`read_reference`; a JSON string array
 *     for `list_references`). No provenance leaks into MCP output.
 *   - ON (explicit opt-in): the runtime-backed body/reference tools emit the declared
 *     `provenance.v1` envelope ({@link PROVENANCE_SHAPE_VERSION}) that ADDS provenance
 *     alongside the existing content:
 *       · `read_skill` / `read_reference` → `{ version, body, provenance }`
 *       · `list_references`              → `{ version, references, provenance }`
 *     where `provenance` is the declared minimum identity set `{ fqid, provider, source }`
 *     plus the optional `resolvedFrom`.
 *
 * `list_skills` (serves the manifest registry document) and `search_skills` (serves the
 * keyword index) are UNAFFECTED by the flag: both delegate to the runtime, but neither is
 * backed by a single runtime `SkillResponse` provenance envelope (one renders an aggregate
 * registry document, the other a ranked list), so there is nothing to stage for them. The
 * staged shape applies only to the runtime-backed body/reference tools `read_skill`,
 * `list_references`, and `read_reference`.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createFileResolver } from './lib/file-resolver.js';
import {
  EXPOSE_PROVENANCE_ENV,
  PROVENANCE_SHAPE_VERSION,
  resolveExposeProvenance,
  type AdapterRenderOptions,
} from './lib/tool-render.js';
import { buildSkillsMcpServer } from './lib/build-server.js';
import { FilesystemSkillProvider } from './runtime/providers/filesystem-provider.js';
import { HttpSkillProviderBlueprint } from './runtime/providers/http-skill-provider.js';
import { MutableProviderView } from './runtime/registry.js';
import { InProcessSkillsRuntime, type TrustLookup } from './runtime/in-process-runtime.js';
import { AdmissionController } from './runtime/admission/admission-controller.js';
import { AdmissionCapabilityHandler } from './runtime/admission/admission-capabilities.js';
import { ProviderBlueprintRegistry } from './runtime/admission/blueprint-registry.js';
import { NamespaceOwnershipTable } from './runtime/admission/namespace-ownership.js';
import { OperationBudget } from './runtime/admission/operation-budget.js';
import { Sha256ContentHasher } from './runtime/admission/content-hasher.js';
import { OriginAllowlist, ORIGIN_ALLOWLIST_ENV } from './runtime/admission/origin-allowlist.js';
import { bundledTrustPolicy, UNTRUSTED_DEFAULT, type TrustPolicy } from './runtime/trust.js';

/**
 * Default per-operation admission budget, in milliseconds (Task 13.1).
 *
 * Bounds the WHOLE `skills.add.v1` admission pipeline under one linked signal — the SAME value
 * the production bus worker (`runtime/transport/bus-worker.ts`) and the proven e2e admit harness
 * (`__tests__/e2e/harness/installed/mcp-admit-server.mjs`) arm, so the MCP and bus transports
 * drive byte-identical admission. Interim/policy value, not frozen.
 */
const ADMISSION_BUDGET_MS = 30_000;

async function main(): Promise<void> {
  // ─── Admission-capable composition — in-process, NO new bus/worker (Req 16.6) ───────────
  //
  // Mirrors the proven bus-worker / e2e-harness wiring EXACTLY (no new admission logic): the
  // bundled FilesystemSkillProvider seeds a MutableProviderView; the InProcessSkillsRuntime
  // reads from THAT view, and the AdmissionController's `register` stage admits (copy-on-write)
  // into the SAME view — so an admitted provider becomes visible to the next read-tool operation
  // on this very instance (Req 16.3), with nothing new spawned. The provider reuses the existing
  // FileResolver, so published-name reads stay byte-for-byte identical (Req 15.1, 15.2).
  const resolver = createFileResolver();
  const packageRoot = resolver.packageRoot;
  // Enable the bundled provider's NATIVE search so `runtime.search()` serves the keyword index
  // (preserving published ranking) instead of the list+substring fallback (Req 9.4, 15.2).
  const bundled = new FilesystemSkillProvider({ search: true });
  const view = new MutableProviderView([bundled]);
  const namespaces = new NamespaceOwnershipTable();

  // Per-provider trust lookup — the SAME pattern `createRuntimeFromRegistry` (the prior
  // composition) built: the bundled (first-party) provider keeps its EFFECTIVE
  // `bundledTrustPolicy(packageRoot)` (so its read/list/search/reference baseline — incl. the
  // path-traversal and content-size boundaries — is byte-for-byte unchanged), and any unknown id
  // (an admitted external provider, whose id is its claimed namespace) resolves to the
  // least-privileged `UNTRUSTED_DEFAULT`. Keyed on `bundled.id`, never a literal.
  const policyById = new Map<string, TrustPolicy>([[bundled.id, bundledTrustPolicy(packageRoot)]]);
  const trustOf: TrustLookup = (providerId) => policyById.get(providerId) ?? UNTRUSTED_DEFAULT;

  // The single admission authority over the SAME view + namespace table (Req 16.6, B1/B3 wiring).
  // The HTTPS blueprint is the one external factory M-002 ships; the no-credential adapter is the
  // default (public origins). Bundled `OperationBudget` + `Sha256ContentHasher`, exactly as the
  // bus worker composes them.
  //
  // ─── Operator origin allowlist (Req 16.5) ────────────────────────────────────────────
  // OPTIONAL deployment restriction sourced from the environment (`ORIGIN_ALLOWLIST_ENV`). WHERE
  // set, only the HTTPS origins it lists are admissible — a non-allowlisted `url` is quarantined
  // at the admission `validate` stage (typed `bad_request`) BEFORE any fetch, because the
  // allowlist is composed into the HTTP blueprint's `configSchema` (the `validate` stage runs
  // `configSchema.parse`). WHERE unset, the documented default applies (public HTTPS permitted,
  // governed by the existing untrusted/bounded/content-as-data/namespace controls). This is a
  // RESTRICTION on which origins succeed, never a hidden on/off — `admit_skill` is always
  // registered (below), the allowlist only narrows its admissible origins.
  const originAllowlist = OriginAllowlist.fromEnv();
  const blueprints = new ProviderBlueprintRegistry();
  blueprints.register(new HttpSkillProviderBlueprint(originAllowlist));
  if (originAllowlist.isConfigured) {
    process.stderr.write(
      `operator origin allowlist ENABLED via ${ORIGIN_ALLOWLIST_ENV} ` +
      `(${originAllowlist.permittedOrigins().length} HTTPS origin(s) admissible)\n`,
    );
  }
  const admissionController = new AdmissionController(
    blueprints,
    view,
    namespaces,
    new OperationBudget(ADMISSION_BUDGET_MS),
    new Sha256ContentHasher(),
  );
  const admissionHandler = new AdmissionCapabilityHandler(admissionController);

  // The runtime reads from the SAME view the `register` stage mutates, shares the SAME
  // namespace-ownership table the controller holds (so the per-operation anti-spoofing boundary
  // consults the same source of truth as admission-time `claim`), and is wired with the
  // in-process admission seam so `request(skills.add.v1, …)` is the real production path.
  const runtime = new InProcessSkillsRuntime(view, trustOf, namespaces, admissionHandler);

  // The published manifest registry document (rendered by `list_skills`) is read from the
  // manifest source: it is the published document template whose per-entry metadata
  // (`versionRange`/`status`/…) is not carried on runtime descriptors. The runtime remains
  // AUTHORITATIVE for membership/order via `runtime.list()`; the manifest only supplies the
  // document fields the `ManifestPresenter` joins back (Req 9.8). The adapter holds no
  // name-resolution logic of its own.
  const manifest = await resolver.readManifest();

  // Published set (Req 9.6): the manifest's skill names. Used ONLY to decide whether to
  // emit the non-fatal open-world warning — never as a resolution/allow-list gate.
  const publishedSkills: ReadonlySet<string> = new Set(manifest.skills.map((s) => s.name));

  // Staged provenance exposure (Task 11.1, Req 9.7/9.9): DEFAULT OFF. Sourced from the
  // declared EXPOSE_PROVENANCE_ENV for the standalone executable. When off, the renderers
  // produce output byte-identical to the compatibility phase; when on, they produce the
  // declared `provenance.v1` staged shape. This is the single, declared opt-in point.
  const renderOpts: AdapterRenderOptions = { exposeProvenance: resolveExposeProvenance() };
  if (renderOpts.exposeProvenance) {
    process.stderr.write(
      `staged provenance exposure ENABLED (${PROVENANCE_SHAPE_VERSION}) via ${EXPOSE_PROVENANCE_ENV}\n`,
    );
  }

  // Build the server through the SHARED builder so production and the e2e harnesses exercise
  // the SAME real wiring. `admitSkill: true` registers the additive sixth tool (Req 16.1) over
  // the admission-capable runtime composed above — the five read tools are unchanged (Req 15.1).
  const server = buildSkillsMcpServer({
    name: '@stdiobus/skills',
    version: manifest.version,
    runtime,
    manifest,
    publishedSkills,
    renderOpts,
    admitSkill: true,
  });

  // --- Connect transport ---

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP server fatal error: ${err}\n`);
  process.exit(1);
});
