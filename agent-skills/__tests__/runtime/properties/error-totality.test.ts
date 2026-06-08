/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Property test — Core returned-error totality (never throws) — Task 2.2
//
// Property 1 (design.md §"Correctness Properties"):
//   For every capability call and every provider behavior (success, returned
//   error, or thrown exception inside a provider), `SkillsRuntime` resolves to a
//   `SkillResponse` value and never propagates a throw across the contract
//   boundary.
//
// Scope (Task 2.2): CORE/RUNTIME provider behaviors only — success, a returned
// error path (zero candidates -> not_found, capability omitted -> unsupported,
// ambiguity -> ambiguous), and a thrown exception INSIDE a provider method
// (resolve/read/list/search/listReferences/readReference). Boundary (Task 7,
// ParamCodec) and security (Task 9, trust) totality cases are added in those
// tasks, not here.
//
// This test exercises the real InProcessSkillsRuntime against real in-memory
// SkillProvider implementations (no mocking of the runtime under test). Each
// generated provider behaviour drives a genuine code path; the assertion is the
// totality invariant: every awaited capability call returns a well-formed
// `SkillResponse` discriminated value and no call throws across the boundary.
//
// Validates: Requirements 2.6
// =============================================================================

import * as fc from 'fast-check';

import { InProcessSkillsRuntime } from '../../../runtime/in-process-runtime.js';
import { SkillsCapabilities } from '../../../runtime/capabilities.js';
import type {
  ListSkillsInput,
  ReadReferenceInput,
  ReadSkillInput,
  ResolvedSkill,
  SearchResult,
  SearchSkillsInput,
  SkillProvider,
  SkillProviderCapabilities,
  SkillRef,
  SkillResponse,
} from '../../../runtime/contract.js';

// -----------------------------------------------------------------------------
// Behaviour model
// -----------------------------------------------------------------------------

/** Outcome of a single provider method when invoked by the runtime. */
type MethodOutcome = 'success' | 'throw';

/** Outcome of `resolve` — the gateway every single-skill operation passes through. */
type ResolveOutcome = 'one' | 'zero' | 'throw';

interface ProviderBehavior {
  /** What `resolve` does: yield exactly one candidate, none, or throw. */
  resolve: ResolveOutcome;
  /** Whether each optional capability is declared supported by the provider. */
  supportsRead: boolean;
  supportsList: boolean;
  supportsSearch: boolean;
  supportsReferences: boolean;
  /** What each (declared) optional method does when invoked. */
  read: MethodOutcome;
  list: MethodOutcome;
  search: MethodOutcome;
  references: MethodOutcome;
}

/** The runtime capability calls under test. */
type Operation =
  | 'read'
  | 'list'
  | 'search'
  | 'getReferences'
  | 'readReference'
  | 'capabilities'
  | 'request-known'
  | 'request-unknown';

const SKILL_NAME = 'alpha';

function boom(method: string): never {
  throw new Error(`provider.${method} intentionally threw`);
}

/**
 * Build a real {@link SkillProvider} that realises a generated behaviour. Methods
 * are attached only when the corresponding capability is declared supported, so
 * the runtime's capability-optional orchestration is genuinely exercised. The
 * `id` parameterises identity so two providers can resolve the same `name` to
 * distinct FQIDs (driving the `ambiguous` returned-error path).
 */
function makeProvider(beh: ProviderBehavior, id = 'p'): SkillProvider {
  const capabilities: SkillProviderCapabilities = {
    read: beh.supportsRead,
    list: beh.supportsList,
    search: beh.supportsSearch,
    references: beh.supportsReferences,
  };

  const source = `fake://${id}/${SKILL_NAME}`;
  const resolved: ResolvedSkill = {
    descriptor: { fqid: `${id}:${SKILL_NAME}`, name: SKILL_NAME, provider: id, source },
    providerId: id,
    providerLocalRef: '__private__',
    provenanceSeed: { source },
  };

  const provider: SkillProvider = {
    id,
    capabilities,
    async resolve(_ref: SkillRef): Promise<ResolvedSkill[]> {
      switch (beh.resolve) {
        case 'throw':
          return boom('resolve');
        case 'zero':
          return [];
        case 'one':
          return [resolved];
      }
    },
  };

  if (beh.supportsRead) {
    provider.read = async () =>
      beh.read === 'throw' ? boom('read') : { descriptor: resolved.descriptor, body: '# body' };
  }

  if (beh.supportsList) {
    provider.list = async (_input?: ListSkillsInput): Promise<ResolvedSkill[]> =>
      beh.list === 'throw' ? boom('list') : [resolved];
  }

  if (beh.supportsSearch) {
    provider.search = async (input: SearchSkillsInput): Promise<SearchResult[]> =>
      beh.search === 'throw'
        ? boom('search')
        : [{ descriptor: resolved.descriptor, score: 1 }].filter((r) =>
          r.descriptor.name.includes(input.query),
        );
  }

  if (beh.supportsReferences) {
    provider.listReferences = async () =>
      beh.references === 'throw' ? boom('listReferences') : [{ path: 'notes.md' }];
    provider.readReference = async (_r, reference) =>
      beh.references === 'throw' ? boom('readReference') : { path: reference, body: 'ref body' };
  }

  return provider;
}

// -----------------------------------------------------------------------------
// Invocation + invariant check
// -----------------------------------------------------------------------------

const NAME_REF: SkillRef = { kind: 'name', name: SKILL_NAME };

async function invoke(runtime: InProcessSkillsRuntime, op: Operation): Promise<unknown> {
  switch (op) {
    case 'read':
      return runtime.read({ ref: NAME_REF } satisfies ReadSkillInput);
    case 'list':
      return runtime.list();
    case 'search':
      return runtime.search({ query: SKILL_NAME } satisfies SearchSkillsInput);
    case 'getReferences':
      return runtime.getReferences({ ref: NAME_REF });
    case 'readReference':
      return runtime.readReference({ ref: NAME_REF, reference: 'notes.md' } satisfies ReadReferenceInput);
    case 'capabilities':
      return runtime.capabilities();
    case 'request-known':
      return runtime.request(SkillsCapabilities.read, { ref: NAME_REF });
    case 'request-unknown':
      return runtime.request({ method: 'skills.unknown.v1', version: '1' }, {});
  }
}

const VALID_ERROR_CODES = new Set([
  'not_found',
  'ambiguous',
  'unsupported',
  'provider_error',
  'bad_request',
  'out_of_bounds',
  'content_too_large',
  'isolation_failed',
  'aggregate_error',
]);

/**
 * `capabilities()` returns a descriptor array (not a SkillResponse); every other
 * core call must return a well-formed {@link SkillResponse} discriminated value.
 */
function assertWellFormed(op: Operation, value: unknown): void {
  if (op === 'capabilities') {
    expect(Array.isArray(value)).toBe(true);
    return;
  }
  expect(typeof value).toBe('object');
  expect(value).not.toBeNull();
  const resp = value as SkillResponse<unknown>;
  expect(typeof resp.ok).toBe('boolean');
  if (resp.ok) {
    expect('data' in resp).toBe(true);
    expect(resp.provenance).toBeDefined();
  } else {
    expect(resp.error).toBeDefined();
    expect(VALID_ERROR_CODES.has(resp.error.code)).toBe(true);
  }
}

// -----------------------------------------------------------------------------
// Generators
// -----------------------------------------------------------------------------

const methodOutcomeArb = fc.constantFrom<MethodOutcome>('success', 'throw');

const behaviorArb: fc.Arbitrary<ProviderBehavior> = fc.record({
  resolve: fc.constantFrom<ResolveOutcome>('one', 'zero', 'throw'),
  supportsRead: fc.boolean(),
  supportsList: fc.boolean(),
  supportsSearch: fc.boolean(),
  supportsReferences: fc.boolean(),
  read: methodOutcomeArb,
  list: methodOutcomeArb,
  search: methodOutcomeArb,
  references: methodOutcomeArb,
});

const operationArb = fc.constantFrom<Operation>(
  'read',
  'list',
  'search',
  'getReferences',
  'readReference',
  'capabilities',
  'request-known',
  'request-unknown',
);

// =============================================================================
// Property 1 — totality across a single provider's behaviours
// =============================================================================

describe('Property 1: Core returned-error totality (never throws)', () => {
  it('resolves every capability call to a SkillResponse for any single-provider behaviour', async () => {
    await fc.assert(
      fc.asyncProperty(behaviorArb, operationArb, async (beh, op) => {
        const runtime = new InProcessSkillsRuntime([makeProvider(beh)]);

        let value: unknown;
        try {
          value = await invoke(runtime, op);
        } catch (e) {
          // Property 1 violated: a throw propagated across the contract boundary.
          throw new Error(
            `op=${op} threw across the boundary for behaviour ${JSON.stringify(beh)}: ${String(e)}`,
          );
        }

        assertWellFormed(op, value);
      }),
      { numRuns: 500 },
    );
  });

  // ---------------------------------------------------------------------------
  // Property 1 — totality with TWO providers (adds the ambiguous returned-error
  // path and aggregate list/search behaviours over a heterogeneous registry).
  // ---------------------------------------------------------------------------
  it('resolves every capability call to a SkillResponse for any two-provider behaviour mix', async () => {
    await fc.assert(
      fc.asyncProperty(behaviorArb, behaviorArb, operationArb, async (behA, behB, op) => {
        // Two providers can resolve the same name to two distinct FQIDs, driving
        // the `ambiguous` returned-error path, while still being subject to the
        // never-throw invariant.
        const providerA = makeProvider(behA, 'p');
        const providerB = makeProvider(behB, 'q');
        const runtime = new InProcessSkillsRuntime([providerA, providerB]);

        let value: unknown;
        try {
          value = await invoke(runtime, op);
        } catch (e) {
          throw new Error(
            `op=${op} threw across the boundary for behaviours ` +
            `${JSON.stringify(behA)} / ${JSON.stringify(behB)}: ${String(e)}`,
          );
        }

        assertWellFormed(op, value);
      }),
      { numRuns: 500 },
    );
  });
});
