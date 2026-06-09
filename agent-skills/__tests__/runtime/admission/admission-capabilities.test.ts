/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Unit tests — skills.add.v1 capability descriptor + handler delegation
// (Milestone-002, Task 9.1; design §"Components" 7; Req 1.1, 1.5, 15.1, 15.3).
//
// Subjects under test:
//   - runtime/capabilities.ts
//       AdmissionCapabilities.add — the versioned EXTENSION descriptor, deliberately
//       absent from CORE_CAPABILITIES so it never surfaces as a default MCP tool.
//   - runtime/admission/admission-capabilities.ts
//       admissionOutcomeToResponse() — pure outcome → SkillResponse mapping.
//       AdmissionCapabilityHandler.handle() — normalize + delegate + map, NO admission
//       logic of its own (delegation verified with a recording stub controller).
//
// Behavior verified:
//   - the descriptor carries method 'skills.add.v1' / version '1' and is NOT a core cap;
//   - the handler NORMALIZES the raw wire descriptor (defaults applied) before delegating;
//   - the handler DELEGATES the normalized descriptor verbatim to AdmissionController.admit;
//   - the handler holds no admission logic — it forwards whatever the controller returns;
//   - SUCCESS maps to a SkillResponse success (data = admitted, provenance from descriptor
//     + record-only contentHash);
//   - QUARANTINE maps to a SkillResponse failure carrying the `quarantined` envelope
//     ({ code:'quarantined'; stage; cause }) — the rejecting stage + the authoritative typed
//     cause both preserved (Task 9.2).
//
// Validates: Requirements 1.1, 1.5, 15.1, 15.3
// =============================================================================

import type { AdmissionController } from '../../../runtime/admission/admission-controller.js';
import {
  AdmissionCapabilityHandler,
  admissionOutcomeToResponse,
} from '../../../runtime/admission/admission-capabilities.js';
import type { AdmissionOutcome, AdmittedProvider } from '../../../runtime/admission/outcome.js';
import type {
  ProviderDescriptor,
  RawProviderDescriptor,
} from '../../../runtime/admission/provider-descriptor.js';
import { AdmissionCapabilities, CORE_CAPABILITIES } from '../../../runtime/capabilities.js';
import { UNTRUSTED_DEFAULT } from '../../../runtime/trust.js';
import type { SkillDescriptor, SkillRuntimeError } from '../../../runtime/contract.js';

// --- Fixtures -----------------------------------------------------------------

const ADMITTED_DESCRIPTOR: SkillDescriptor = {
  fqid: 'acme:doc',
  name: 'doc',
  provider: 'acme',
  source: 'https://example.com/doc',
};

const ADMITTED: AdmittedProvider = {
  descriptor: ADMITTED_DESCRIPTOR,
  contentHash: 'sha256-deadbeef',
};

/**
 * A recording stub standing in for the {@link AdmissionController}. The handler only calls
 * `admit`, so a minimal object captures the delegated descriptor and returns a scripted
 * outcome — proving the handler delegates and holds no admission logic of its own.
 */
class RecordingController {
  readonly calls: ProviderDescriptor[] = [];
  constructor(private readonly outcome: AdmissionOutcome) { }
  // eslint-disable-next-line @typescript-eslint/require-await
  async admit(descriptor: ProviderDescriptor): Promise<AdmissionOutcome> {
    this.calls.push(descriptor);
    return this.outcome;
  }
}

function makeHandler(outcome: AdmissionOutcome): {
  handler: AdmissionCapabilityHandler;
  controller: RecordingController;
} {
  const controller = new RecordingController(outcome);
  // The handler depends only on the `admit` contract; the stub satisfies it structurally.
  const handler = new AdmissionCapabilityHandler(controller as unknown as AdmissionController);
  return { handler, controller };
}

// =============================================================================
// Capability descriptor + default-surface placement (Req 1.1, 15.1, 15.3)
// =============================================================================

describe('AdmissionCapabilities.add descriptor (Req 1.1, 15.3)', () => {
  it('is the versioned skills.add.v1 / v1 descriptor', () => {
    expect(AdmissionCapabilities.add.method).toBe('skills.add.v1');
    expect(AdmissionCapabilities.add.version).toBe('1');
  });

  it('is NOT a core capability — never surfaces as a default MCP tool (Req 15.1, 15.3)', () => {
    const coreMethods = CORE_CAPABILITIES.map((c) => c.method);
    expect(coreMethods).not.toContain('skills.add.v1');
    // The five bundled core methods remain the entire core surface.
    expect(CORE_CAPABILITIES).toHaveLength(5);
  });
});

// =============================================================================
// Pure mapping — admissionOutcomeToResponse (Task 9.1 scope)
// =============================================================================

describe('admissionOutcomeToResponse mapping', () => {
  it('maps a success outcome to a SkillResponse success with provenance from the descriptor', () => {
    const response = admissionOutcomeToResponse({ ok: true, admitted: ADMITTED });

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error('expected success');
    expect(response.data).toBe(ADMITTED);
    // Provenance core fields come from the admitted runtime-resolved descriptor.
    expect(response.provenance.fqid).toBe('acme:doc');
    expect(response.provenance.provider).toBe('acme');
    expect(response.provenance.source).toBe('https://example.com/doc');
    // Record-only content hash carried via the Provenance index signature (Req 8.2).
    expect(response.provenance.contentHash).toBe('sha256-deadbeef');
  });

  it('maps a quarantine outcome to a SkillResponse failure carrying the quarantined envelope', () => {
    const error: SkillRuntimeError = { code: 'content_too_large', provider: 'acme', limitBytes: 10 };
    const response = admissionOutcomeToResponse({ ok: false, stage: 'acquire', error });

    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('expected failure');
    // Task 9.2: the authoritative typed error is wrapped in the `quarantined` envelope —
    // the rejecting `stage` is recorded and the typed `cause` is preserved verbatim, so both
    // survive on the wire.
    expect(response.error).toEqual({ code: 'quarantined', stage: 'acquire', cause: error });
  });

  it('preserves each quarantine stage + typed cause verbatim in the envelope', () => {
    const cases: Array<{ stage: 'discover' | 'validate' | 'acquire'; error: SkillRuntimeError }> = [
      { stage: 'discover', error: { code: 'bad_request', issues: ['url must be a string'] } },
      { stage: 'acquire', error: { code: 'provider_error', provider: 'acme', message: 'origin unavailable' } },
      { stage: 'acquire', error: { code: 'content_too_large', provider: 'acme', limitBytes: 1 } },
    ];
    for (const { stage, error } of cases) {
      const response = admissionOutcomeToResponse({ ok: false, stage, error });
      expect(response.ok).toBe(false);
      if (response.ok) throw new Error('expected failure');
      expect(response.error).toEqual({ code: 'quarantined', stage, cause: error });
    }
  });
});

// =============================================================================
// Handler — normalize + delegate + map (Req 1.5)
// =============================================================================

describe('AdmissionCapabilityHandler.handle (Req 1.5)', () => {
  it('normalizes the raw descriptor (defaults applied) before delegating to admit', async () => {
    const { handler, controller } = makeHandler({ ok: true, admitted: ADMITTED });
    // Wire descriptor with trust / capabilityVersions OMITTED.
    const raw: RawProviderDescriptor = {
      factoryId: 'http',
      config: { url: 'https://example.com/doc' },
      namespace: 'acme',
    };

    await handler.handle(raw);

    expect(controller.calls).toHaveLength(1);
    const delegated = controller.calls[0];
    // Normalization applied the least-privilege defaults ONCE at the boundary.
    expect(delegated.trust).toBe(UNTRUSTED_DEFAULT);
    expect(delegated.capabilityVersions).toEqual({});
    // The non-defaulted fields pass through unchanged.
    expect(delegated.factoryId).toBe('http');
    expect(delegated.namespace).toBe('acme');
    expect(delegated.config).toEqual({ url: 'https://example.com/doc' });
  });

  it('passes present trust / capabilityVersions through unchanged', async () => {
    const { handler, controller } = makeHandler({ ok: true, admitted: ADMITTED });
    const raw: RawProviderDescriptor = {
      factoryId: 'http',
      config: {},
      namespace: 'acme',
      trust: UNTRUSTED_DEFAULT,
      capabilityVersions: { 'skills.read.v1': '1' },
    };

    await handler.handle(raw);

    const delegated = controller.calls[0];
    expect(delegated.capabilityVersions).toEqual({ 'skills.read.v1': '1' });
  });

  it('delegates and forwards a controller success as a SkillResponse success', async () => {
    const { handler } = makeHandler({ ok: true, admitted: ADMITTED });

    const response = await handler.handle({ factoryId: 'http', config: {}, namespace: 'acme' });

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error('expected success');
    expect(response.data).toBe(ADMITTED);
    expect(response.provenance.fqid).toBe('acme:doc');
  });

  it('delegates and forwards a controller quarantine as a quarantined SkillResponse failure', async () => {
    const error: SkillRuntimeError = { code: 'bad_request', issues: ['unknown factoryId'] };
    const { handler } = makeHandler({ ok: false, stage: 'discover', error });

    const response = await handler.handle({ factoryId: 'nope', config: {}, namespace: 'acme' });

    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('expected failure');
    expect(response.error).toEqual({ code: 'quarantined', stage: 'discover', cause: error });
  });
});
