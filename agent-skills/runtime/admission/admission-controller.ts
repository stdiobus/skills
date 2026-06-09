/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AdmissionController — the single admission authority composing the staged pipeline
 * (Milestone-002, Task 8.2; design §"Components" 2; Req 2.4, 2.5, 3.6, 8.1, 9.1, 9.2, 9.3).
 *
 * The controller wires the six stage classes (Task 8.1) into the fixed, explicitly-typed
 * sequence `discover → validate → acquire → hash-record → admit → register` and runs the
 * whole pipeline under ONE per-operation budget signal (Req 12), threading that signal into
 * every stage's `run(ctx, signal)`. It is the ONE place that mutates the provider registry
 * as part of admission (Req 2.5): the `register` stage — the only stage that touches the
 * {@link MutableProviderView} — runs LAST, only after the namespace claim succeeds, so a
 * quarantine at any earlier stage leaves `registry.providers()` byte-for-byte unchanged
 * (Req 9.3; design Property 2).
 *
 * ─── ADMISSION IS TOTAL (Req 2.4, 9.1; design Property 1) ──────────────────────────
 *
 * {@link AdmissionController.admit} ALWAYS resolves to an {@link AdmissionOutcome} and NEVER
 * throws, for every stage behavior:
 *   - a stage that SUCCEEDS threads its typed output into the next stage;
 *   - a stage that RETURNS `{ ok: false; error }` short-circuits to a quarantine outcome
 *     naming THAT stage and carrying its authoritative typed `error` (Req 2.3, 9.2);
 *   - a stage that THROWS (an unexpected fault a stage did not convert itself) is caught and
 *     mapped to a `provider_error` quarantine naming the stage in flight (Req 2.4) — no
 *     exception ever propagates across the controller boundary.
 *
 * ─── AUTHORITY IS EARNED, NOT GRANTED (Req 3.6; design Property 5) ──────────────────
 *
 * Because the pipeline short-circuits on the FIRST failing stage and `register` is last, no
 * provider is ever registered unless `validate` (per-factory config), `acquire` (bounded
 * HTTPS), `admit` (content-as-data + namespace claim) ALL succeed first. There is no path
 * that registers on a failing stage.
 *
 * ─── ONE LINKED SIGNAL FOR THE WHOLE PIPELINE (Req 12) ─────────────────────────────
 *
 * {@link OperationBudget.run} produces a single linked {@link AbortSignal}; the controller
 * threads it into every stage so the I/O-bound `acquire` stage honors the deadline and any
 * external cancellation. A budget expiry surfaces as a typed `provider_error` the controller
 * renders into a quarantine naming the stage that was in flight when the deadline fired.
 */

import type { SkillRuntimeError } from '../contract.js';
import type { MutableProviderView } from '../registry.js';
import type { ProviderBlueprintRegistry } from './blueprint-registry.js';
import type { ContentHasher } from './content-hasher.js';
import { noCredentialHeaders } from './credential-headers.js';
import type { NamespaceOwnershipTable } from './namespace-ownership.js';
import type { OperationBudget } from './operation-budget.js';
import type { AdmissionOutcome } from './outcome.js';
import type { CredentialHeadersProvider } from './provider-blueprint.js';
import type { ProviderDescriptor } from './provider-descriptor.js';
import type { AdmissionStage, AdmissionStageName } from './stage.js';
import {
  AcquireStage,
  AdmitStage,
  DiscoverStage,
  HashRecordStage,
  RegisterStage,
  ValidateStage,
} from './stages.js';

/**
 * Internal per-stage step outcome: either CONTINUE with the typed `value` threaded into the
 * next stage, or STOP with the {@link AdmissionOutcome} quarantine to return to the caller.
 */
type StageStep<TOut> =
  | { done: false; value: TOut }
  | { done: true; outcome: AdmissionOutcome };

/**
 * The single admission authority (design §"Components" 2; Req 2.5).
 *
 * Constructed once by composition and handed the blueprint registry, the admission-target
 * provider view, the namespace ownership table, the operation budget, and the content hasher.
 * It instantiates the six stages internally and exposes only {@link admit}.
 */
export class AdmissionController {
  private readonly discover: DiscoverStage;
  private readonly validate: ValidateStage;
  private readonly acquire: AcquireStage;
  private readonly hashRecord: HashRecordStage;
  private readonly admitStage: AdmitStage;
  private readonly register: RegisterStage;

  /**
   * @param blueprints - resolves `descriptor.factoryId` → blueprint (the `discover` stage).
   * @param registry - the admission-target {@link MutableProviderView}; mutated ONLY by the
   *   `register` stage, copy-on-write and add-only (Req 10.5, 10.6).
   * @param namespaces - the single ownership source of truth claimed by the `admit` stage.
   * @param budget - per-operation timeout + cancellation; supplies the one linked signal.
   * @param hasher - the record-only content hasher (the `hash-record` stage).
   * @param credentials - the auth-reuse header adapter for the creation context; defaults to
   *   the no-credential adapter for public origins (Req 7.3).
   */
  constructor(
    blueprints: ProviderBlueprintRegistry,
    registry: MutableProviderView,
    namespaces: NamespaceOwnershipTable,
    private readonly budget: OperationBudget,
    hasher: ContentHasher,
    credentials: CredentialHeadersProvider = noCredentialHeaders,
  ) {
    this.discover = new DiscoverStage(blueprints, credentials);
    this.validate = new ValidateStage();
    this.acquire = new AcquireStage();
    this.hashRecord = new HashRecordStage(hasher);
    this.admitStage = new AdmitStage(namespaces);
    this.register = new RegisterStage(registry);
  }

  /**
   * Admit a provider from its normalized descriptor (Req 2.4, 2.5, 9.1, 9.2, 9.3).
   *
   * Runs the fixed pipeline under one budget signal. Total: resolves to an
   * {@link AdmissionOutcome} and never throws.
   *
   * @param descriptor - the normalized {@link ProviderDescriptor} (defaults already applied).
   * @returns `{ ok: true; admitted }` on full success, else `{ ok: false; stage; error }`
   *   naming the rejecting stage with its authoritative typed error.
   */
  async admit(descriptor: ProviderDescriptor): Promise<AdmissionOutcome> {
    // Names the stage currently executing, so a budget expiry or an unexpected throw can be
    // attributed to the right stage in the quarantine outcome (Req 9.2).
    let stageInFlight: AdmissionStageName = this.discover.name;

    try {
      const budgeted = await this.budget.run<AdmissionOutcome>(async (signal) => {
        // Run a single stage under the shared signal; CONTINUE with its value or STOP with a
        // quarantine naming the stage. A stage that THROWS propagates out of here (it is not
        // caught at the stage level) and is handled by the budget / outer catch below, which
        // converts it to a `provider_error` quarantine — admission stays total (Req 2.4).
        const runStage = async <TIn, TOut>(
          stage: AdmissionStage<TIn, TOut>,
          ctx: TIn,
        ): Promise<StageStep<TOut>> => {
          stageInFlight = stage.name;
          const result = await stage.run(ctx, signal);
          if (result.ok) return { done: false, value: result.value };
          return { done: true, outcome: { ok: false, stage: stage.name, error: result.error } };
        };

        const discovered = await runStage(this.discover, { descriptor });
        if (discovered.done) return discovered.outcome;

        const validated = await runStage(this.validate, discovered.value);
        if (validated.done) return validated.outcome;

        const acquired = await runStage(this.acquire, validated.value);
        if (acquired.done) return acquired.outcome;

        const hashed = await runStage(this.hashRecord, acquired.value);
        if (hashed.done) return hashed.outcome;

        const admitted = await runStage(this.admitStage, hashed.value);
        if (admitted.done) return admitted.outcome;

        const registered = await runStage(this.register, admitted.value);
        if (registered.done) return registered.outcome;

        return { ok: true, admitted: registered.value };
      });

      if (budgeted.ok) return budgeted.value;

      // The budget's linked signal aborted (timeout / cancellation) while `stageInFlight` ran
      // and the stage did not convert it itself — render the typed error into a quarantine.
      return { ok: false, stage: stageInFlight, error: budgeted.error };
    } catch (err) {
      // Absolute totality backstop (Req 2.4): a stage threw an unexpected fault unrelated to
      // the signal. Never throw across the boundary — quarantine with a typed provider_error.
      return { ok: false, stage: stageInFlight, error: this.toProviderError(descriptor, err) };
    }
  }

  /** Normalize an unexpected thrown value into a typed `provider_error` (Req 2.4). */
  private toProviderError(descriptor: ProviderDescriptor, err: unknown): SkillRuntimeError {
    // A provider throws an error carrying its own typed `runtimeError` (e.g. HttpProviderError);
    // preserve that authoritative code without a reverse dependency on the providers layer.
    if (
      typeof err === 'object' &&
      err !== null &&
      'runtimeError' in err &&
      typeof (err as { runtimeError?: unknown }).runtimeError === 'object' &&
      (err as { runtimeError?: { code?: unknown } }).runtimeError !== null &&
      typeof (err as { runtimeError: { code?: unknown } }).runtimeError.code === 'string'
    ) {
      return (err as { runtimeError: SkillRuntimeError }).runtimeError;
    }
    const message = err instanceof Error ? err.message : String(err);
    return { code: 'provider_error', provider: descriptor.namespace, message };
  }
}
