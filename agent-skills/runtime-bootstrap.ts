/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `@stdiobus/skills/runtime` — the ADVANCED runtime composition API
 * (Milestone-002, Task 11.2; design §"Architecture" / §"Components" 7; Req 14.1, 14.2, 15.3).
 *
 * ─── WHY THIS SUBPATH EXISTS ────────────────────────────────────────────────────────
 *
 * The default product surface of this package is intentionally NARROW: the library entry
 * (`@stdiobus/skills`) re-exports only `SkillName` + the manifest types, and the executable
 * (`@stdiobus/skills/mcp-server`) is the FIVE-tool MCP server that, by design, does NOT
 * expose `skills.add.v1` (Req 15.3). That keeps the admission capability out of the default
 * consumer surface.
 *
 * But Milestone-002's Definition of Done (Req 14) requires proving — through the INSTALLED
 * package, with no source-tree shortcut — that a host can COMPOSE an admission-capable
 * runtime over BOTH transports (the MCP stdio adapter and the existing stdio Bus worker),
 * admit an external provider via the PRODUCTION admission path, fetch over real HTTPS,
 * federate with the bundled provider, and read it back. A clean consumer cannot do that if
 * the installed package never exports the composition pieces.
 *
 * This module is that deliberate, documented escape hatch: a RUNTIME COMPOSITION API (not a
 * second MCP product surface). It re-exports the SAME production classes the in-tree
 * `mcp-server.ts` and `runtime/transport/bus-worker.ts` compose — nothing is re-implemented,
 * nothing is mocked. A host wiring `skills.add.v1` over either transport drives the exact
 * same {@link AdmissionController} pipeline the bus worker drives. The default 5-tool MCP
 * surface is unchanged (Req 15.1, 15.3); enabling admission is an explicit, separate act a
 * host performs with these building blocks.
 *
 * ─── SCOPE (kept narrow on purpose) ─────────────────────────────────────────────────
 *
 * Exported: the runtime, the provider registry / views, the bundled filesystem provider, the
 * HTTPS provider blueprint, the admission authority + its capability handler, the blueprint
 * registry, the namespace table, the operation budget, the content hasher, the capability
 * descriptors, the transport ParamCodec, the descriptor normalizer, the bundled trust policy,
 * the MCP server builder, the file resolver, and the contract/type vocabulary needed to use
 * them. NOT exported: private admission stage internals, security-boundary internals, or
 * pure helpers a host does not need — those stay package-internal.
 */

// ─── Contract vocabulary (types) ─────────────────────────────────────────────────────
export type {
  CapabilityRef,
  GetReferencesInput,
  ListSkillsInput,
  Provenance,
  ReadReferenceInput,
  ReadSkillInput,
  ReferenceContent,
  ReferenceDescriptor,
  ResolvedSkill,
  SearchResult,
  SearchSkillsInput,
  SkillContent,
  SkillDescriptor,
  SkillProvider,
  SkillProviderCapabilities,
  SkillRef,
  SkillResponse,
  SkillRuntimeError,
  SkillsRuntime,
} from './runtime/contract.js';
export { capability } from './runtime/contract.js';

// ─── Provider registry + per-operation snapshot views (Req 10) ────────────────────────
export {
  ConstantProviderView,
  MutableProviderView,
  SkillProviderRegistry,
  createRuntimeFromRegistry,
  effectiveTrustPolicy,
  type ProviderView,
  type ProviderRegistration,
  type SkillRegistry,
} from './runtime/registry.js';

// ─── In-process runtime (both transports wrap this same implementation) ───────────────
export {
  InProcessSkillsRuntime,
  type AdmissionRequestHandler,
  type TrustLookup,
} from './runtime/in-process-runtime.js';

// ─── Providers: bundled filesystem + the real HTTPS provider blueprint (Req 7) ────────
export { FilesystemSkillProvider } from './runtime/providers/filesystem-provider.js';
export {
  HttpSkillProvider,
  HttpSkillProviderBlueprint,
  httpProviderConfigSchema,
  type HttpProviderConfig,
} from './runtime/providers/http-skill-provider.js';

// ─── Admission authority + staged pipeline composition (Req 1, 2, 8, 9) ───────────────
export { AdmissionController } from './runtime/admission/admission-controller.js';
export {
  AdmissionCapabilityHandler,
  admissionOutcomeToResponse,
} from './runtime/admission/admission-capabilities.js';
export { ProviderBlueprintRegistry } from './runtime/admission/blueprint-registry.js';
export { NamespaceOwnershipTable } from './runtime/admission/namespace-ownership.js';
export { OperationBudget } from './runtime/admission/operation-budget.js';
export {
  Sha256ContentHasher,
  defaultContentHasher,
  type ContentHasher,
} from './runtime/admission/content-hasher.js';
export {
  NoCredentialHeadersProvider,
  RegistryCredentialHeadersProvider,
  noCredentialHeaders,
  type AuthorizationSource,
  type AuthorizedAccess,
} from './runtime/admission/credential-headers.js';
export {
  normalizeDescriptor,
  type ProviderDescriptor,
  type RawProviderDescriptor,
} from './runtime/admission/provider-descriptor.js';
export type {
  ProviderBlueprint,
  ProviderCreationContext,
  CredentialHeadersProvider,
} from './runtime/admission/provider-blueprint.js';
export type { Schema, SchemaResult } from './runtime/admission/schema.js';
export type { AdmissionOutcome, AdmittedProvider } from './runtime/admission/outcome.js';

// ─── Capability descriptors + transport boundary codec (Req 1.1, 1.3) ─────────────────
export { AdmissionCapabilities, SkillsCapabilities, CORE_CAPABILITIES } from './runtime/capabilities.js';
export { ParamCodec, type DecodeResult } from './runtime/transport/param-codec.js';

// ─── Trust policy (least-privilege defaults; Req 8.4, 11.1) ───────────────────────────
export {
  UNTRUSTED_DEFAULT,
  bundledTrustPolicy,
  resolveTrustPolicy,
  type TrustPolicy,
  type TrustTier,
} from './runtime/trust.js';

// ─── MCP server builder + render options + file resolver ──────────────────────────────
export {
  buildSkillsMcpServer,
  type BuildSkillsMcpServerOptions,
} from './lib/build-server.js';
export {
  COMPAT_RENDER_OPTIONS,
  describeError,
  type AdapterRenderOptions,
} from './lib/tool-render.js';
export { createFileResolver, type FileResolver } from './lib/file-resolver.js';
export type { Skill, SkillManifest } from './types.js';

// ─── Stdio serving helper (keeps the MCP SDK transport an internal detail) ────────────

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Connect a built {@link McpServer} to a real `StdioServerTransport` (JSON-RPC 2.0 / NDJSON
 * over stdin/stdout). A thin convenience so a composing host does not have to import the MCP
 * SDK transport directly; the server is built with {@link buildSkillsMcpServer}.
 *
 * @param server - the configured MCP server (transport not yet connected).
 * @returns a promise that resolves once the transport is connected.
 */
export async function serveMcpStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
