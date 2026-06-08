/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BusSkillsRuntime — the selectable stdio Bus transport backend (Migration Step 5,
 * Task 7.3; design §3a/§3b, Req 6.1, 6.5, 6.6, 6.7).
 *
 * This is the client side of the proven two-backend topology: it implements the SAME
 * {@link SkillsRuntime} contract as {@link InProcessSkillsRuntime}, but routes every
 * capability call over `StdioBus.request(method, params)` to a worker process that hosts
 * an in-process runtime (the promoted {@link import('./bus-worker.js')} worker). Because
 * both backends implement `SkillsRuntime`, call sites never change when transport changes
 * (Req 6.1, 6.6) — transport is selected purely by deployment config in the factory.
 *
 * Per call, the runtime:
 * 1. encodes the typed capability input to a JSON-serializable params object via
 *    {@link ParamCodec.encode} (Req 10.1);
 * 2. dispatches it over the bus as the capability's wire `method` string (`skills.read.v1`,
 *    ...), carrying the typed `SkillResponse` back as STRUCTURED DATA, never collapsed to a
 *    prompt-shaped string (Req 6.3);
 * 3. decodes the wire response with {@link ParamCodec.decodeResponse} (Req 6.3).
 *
 * ─── Returned-error totality at the transport boundary (Req 6.7) ──────────────────────
 *
 * A transport failure (start failure, timeout, send failure, RPC error) is NEVER thrown
 * across the contract boundary and NEVER collapsed to a prompt string. It is mapped to a
 * typed, returned {@link SkillRuntimeError} that PRESERVES the transport origin.
 *
 * INTERIM mapping: the failure is reported as `provider_error` with a synthetic
 * `bus:<pool>` provider marker so the origin (this bus transport, on the named pool) stays
 * identifiable in diagnostics. A dedicated `transport_error` code is a deliberate open
 * policy choice (design §3b "Error Handling"); when it lands, only this mapping changes.
 * TODO(transport_error): replace the `provider_error` + `bus:<pool>` interim with a
 * first-class `transport_error` member of the `SkillRuntimeError` union.
 *
 * ─── Lifecycle (the synchronous-factory constraint) ───────────────────────────────────
 *
 * {@link createSkillsRuntime} returns a `SkillsRuntime` SYNCHRONOUSLY, but a real bus needs
 * an async `start()`. This runtime reconciles the two without changing the factory
 * signature or any call site:
 *
 * - An INJECTED bus (constructor's second argument) is treated as caller-owned: the caller
 *   is responsible for `start()`/`stop()`. This runtime never starts or stops it. This is
 *   the path used by tests and by deployments that own the bus topology.
 * - A DEFAULT bus (no injection) is owned by this runtime. It is constructed eagerly
 *   (cheap — construction does not spawn workers) and `start()`ed LAZILY on the first
 *   dispatch, guarded so it starts at most once. A start failure maps to the same typed
 *   `provider_error`/`bus:<pool>` result as any other transport failure — never a throw.
 *   Callers that use the default bus should call {@link BusSkillsRuntime.stop} to tear it
 *   down.
 *
 * {@link BusSkillsRuntime.capabilities} returns the static {@link CORE_CAPABILITIES} list
 * rather than a bus round-trip, so introspection is total and lifecycle-free (no start
 * required just to enumerate capabilities).
 */

import * as path from 'path';
import StdioBus from '@stdiobus/node';
import { CORE_CAPABILITIES, SkillsCapabilities } from '../capabilities.js';
import { ParamCodec } from './param-codec.js';
import type {
  CapabilityDescriptor,
  CapabilityRef,
  GetReferencesInput,
  ListSkillsInput,
  ReadReferenceInput,
  ReadSkillInput,
  ReferenceContent,
  ReferenceDescriptor,
  SearchResult,
  SearchSkillsInput,
  SkillContent,
  SkillDescriptor,
  SkillResponse,
  SkillsRuntime,
} from '../contract.js';

/** Default per-request timeout — matches the proven spike (`bus-read-spike.ts`). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Configuration for the bus transport (the `stdio-bus` arm of `TransportConfig`). */
export interface BusRuntimeConfig {
  /** The bus pool id that spawns/serves the skills worker. */
  pool: string;
  /** Per-request timeout in milliseconds (default {@link DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number;
}

/**
 * Construct the INTERIM default bus that spawns the promoted skills worker.
 *
 * The worker is a `tsx`-run TypeScript process, so this default targets a dev/tsx context
 * and resolves the worker + the `tsx` binary relative to `process.cwd()` (the package
 * root, where `yarn`/`tsx`/Jest run). This intentionally avoids `import.meta`/`__dirname`
 * so the module compiles identically under the ESM build and the CommonJS test transform.
 *
 * INTERIM: this is a convenience default only. Any non-dev deployment should inject a
 * pre-configured, caller-owned {@link StdioBus} (the second constructor argument), which
 * bypasses this path entirely and lets the caller own the bus topology and lifecycle.
 */
function createDefaultBus(pool: string): StdioBus {
  const root = process.cwd();
  const tsxBin = path.join(root, 'node_modules', '.bin', 'tsx');
  const workerPath = path.join(root, 'agent-skills', 'runtime', 'transport', 'bus-worker.ts');
  return new StdioBus({
    config: { pools: [{ id: pool, command: tsxBin, args: [workerPath], instances: 1 }] },
    backend: 'native',
    logLevel: 2, // WARN — keep kernel chatter low
  });
}

/**
 * stdio Bus-backed {@link SkillsRuntime}. See the module header for the lifecycle and
 * returned-error contract.
 */
export class BusSkillsRuntime implements SkillsRuntime {
  /** The bus this runtime dispatches over (injected = caller-owned, or the default). */
  private readonly bus: StdioBus;
  /** True only for the default bus this runtime constructed and is responsible for. */
  private readonly ownsBus: boolean;
  /** Memoized start (owned bus only); cleared on failure so a later dispatch may retry. */
  private startPromise?: Promise<void>;

  /**
   * @param cfg - bus pool + timeout configuration.
   * @param bus - optional, caller-owned bus. When provided this runtime never starts or
   *   stops it; the caller controls its lifecycle. When omitted a default bus is built and
   *   owned by this runtime (lazily started on first dispatch).
   */
  constructor(
    private readonly cfg: BusRuntimeConfig,
    bus?: StdioBus,
  ) {
    if (bus) {
      this.bus = bus;
      this.ownsBus = false;
    } else {
      this.bus = createDefaultBus(cfg.pool);
      this.ownsBus = true;
    }
  }

  // --- core capabilities (each maps 1:1 onto a wire method) -------------

  read(input: ReadSkillInput): Promise<SkillResponse<SkillContent>> {
    return this.dispatch(SkillsCapabilities.read, input);
  }

  list(input: ListSkillsInput = {}): Promise<SkillResponse<SkillDescriptor[]>> {
    return this.dispatch(SkillsCapabilities.list, input);
  }

  search(input: SearchSkillsInput): Promise<SkillResponse<SearchResult[]>> {
    return this.dispatch(SkillsCapabilities.search, input);
  }

  getReferences(input: GetReferencesInput): Promise<SkillResponse<ReferenceDescriptor[]>> {
    return this.dispatch(SkillsCapabilities.listReferences, input);
  }

  readReference(input: ReadReferenceInput): Promise<SkillResponse<ReferenceContent>> {
    return this.dispatch(SkillsCapabilities.readReference, input);
  }

  // --- introspection + extension seam -----------------------------------

  /**
   * Enumerate the core capabilities from the static {@link CORE_CAPABILITIES} list.
   *
   * Deliberately does NOT round-trip the bus: introspection stays total and requires no
   * `start()` (design §3b — "static core list ... avoids lifecycle issues"). Extension
   * capabilities reached via {@link request} are layered on later (Task 8+).
   */
  async capabilities(): Promise<CapabilityDescriptor[]> {
    return CORE_CAPABILITIES.map((c) => ({ method: c.method, version: c.version }));
  }

  /**
   * Typed extension dispatch — the same `method` string routed over the bus. New
   * capabilities plug in here without changing the core interface (mirrors
   * {@link InProcessSkillsRuntime.request} so both backends share the seam).
   */
  request<TInput, TOutput>(
    capability: CapabilityRef<TInput, TOutput>,
    input: TInput,
  ): Promise<SkillResponse<TOutput>> {
    return this.dispatch(capability, input);
  }

  // --- lifecycle (owned bus only) ---------------------------------------

  /**
   * Stop the bus IF this runtime owns it and has started it. A no-op for an injected
   * (caller-owned) bus — that lifecycle belongs to the caller. After a successful stop the
   * start guard is cleared so the runtime could be started again by a later dispatch.
   */
  async stop(): Promise<void> {
    if (!this.ownsBus || !this.startPromise) return;
    try {
      await this.bus.stop();
    } finally {
      this.startPromise = undefined;
    }
  }

  /**
   * Ensure the owned bus is started, at most once. No-op for an injected bus (caller owns
   * its lifecycle). If `start()` rejects, the memoized promise is cleared so a subsequent
   * dispatch may retry; the rejection propagates to {@link dispatch}, which maps it to a
   * typed returned error (never a throw across the contract boundary).
   */
  private async ensureStarted(): Promise<void> {
    if (!this.ownsBus) return;
    if (!this.startPromise) {
      this.startPromise = this.bus.start().catch((e) => {
        this.startPromise = undefined;
        throw e;
      });
    }
    await this.startPromise;
  }

  /**
   * Encode → request → decode for one capability. The single place where a transport
   * failure is caught and mapped to a typed, returned {@link SkillRuntimeError} that
   * preserves the `bus:<pool>` origin (Req 6.7). Never throws; never returns a string.
   */
  private async dispatch<TInput, TOutput>(
    cap: CapabilityRef<TInput, TOutput>,
    input: TInput,
  ): Promise<SkillResponse<TOutput>> {
    const params = ParamCodec.encode(cap, input); // typed → Record<string,unknown> (Req 10.1)
    try {
      await this.ensureStarted();
      const raw = await this.bus.request<unknown>(cap.method, params, {
        timeout: this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      return ParamCodec.decodeResponse(cap, raw); // wire → typed SkillResponse (Req 6.3)
    } catch (e) {
      // Transport failure (not a provider fault) → typed error, returned not thrown,
      // never a prompt string (Req 6.7). INTERIM: provider_error + bus:<pool> marker;
      // TODO(transport_error): promote to a dedicated transport_error code.
      return {
        ok: false,
        error: { code: 'provider_error', provider: `bus:${this.cfg.pool}`, message: String(e) },
      };
    }
  }
}
