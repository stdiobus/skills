/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Unit tests — provider descriptor shapes + decode-time normalization
// (Milestone-002, Task 2.1; design §"Components" 1 / companion fix 1).
//
// Subject under test:
//   - runtime/admission/provider-descriptor.ts
//       normalizeDescriptor(raw): apply decode-time defaults ONCE at the boundary
//         - trust omitted             → UNTRUSTED_DEFAULT (Req 1.2, 8.4)
//         - capabilityVersions omitted → {} recorded explicitly (Req 13.1)
//         - present values pass through unchanged
//         - normalized fields are always defined
//
// Validates: Requirements 1.2, 8.4, 13.1
// =============================================================================

import * as fc from 'fast-check';

import {
  normalizeDescriptor,
  type RawProviderDescriptor,
} from '../../../runtime/admission/provider-descriptor.js';
import { UNTRUSTED_DEFAULT, bundledTrustPolicy, type TrustPolicy } from '../../../runtime/trust.js';

describe('normalizeDescriptor — decode-time defaults (Req 1.2, 8.4, 13.1)', () => {
  describe('defaults applied when omitted', () => {
    it('applies UNTRUSTED_DEFAULT when trust is omitted (Req 1.2, 8.4)', () => {
      const raw: RawProviderDescriptor = {
        factoryId: 'http',
        config: { url: 'https://example.com/skill.md' },
        namespace: 'acme',
      };

      const normalized = normalizeDescriptor(raw);

      expect(normalized.trust).toBe(UNTRUSTED_DEFAULT);
      expect(normalized.trust.tier).toBe('untrusted');
    });

    it('applies an explicit empty {} when capabilityVersions is omitted (Req 13.1)', () => {
      const raw: RawProviderDescriptor = {
        factoryId: 'http',
        config: {},
        namespace: 'acme',
      };

      const normalized = normalizeDescriptor(raw);

      expect(normalized.capabilityVersions).toEqual({});
    });

    it('fills both defaults when both are omitted', () => {
      const raw: RawProviderDescriptor = {
        factoryId: 'http',
        config: {},
        namespace: 'acme',
      };

      const normalized = normalizeDescriptor(raw);

      expect(normalized.trust).toBe(UNTRUSTED_DEFAULT);
      expect(normalized.capabilityVersions).toEqual({});
    });
  });

  describe('present values pass through unchanged', () => {
    it('preserves a supplied trust policy verbatim (no untrusted override)', () => {
      const trust: TrustPolicy = bundledTrustPolicy('/pkg/root');
      const raw: RawProviderDescriptor = {
        factoryId: 'http',
        config: { url: 'https://example.com/skill.md' },
        namespace: 'acme',
        trust,
      };

      const normalized = normalizeDescriptor(raw);

      expect(normalized.trust).toBe(trust);
      expect(normalized.trust.tier).toBe('trusted');
    });

    it('preserves a supplied capabilityVersions map verbatim', () => {
      const capabilityVersions = { 'skills.read': '1', 'skills.list': '2' };
      const raw: RawProviderDescriptor = {
        factoryId: 'http',
        config: {},
        namespace: 'acme',
        capabilityVersions,
      };

      const normalized = normalizeDescriptor(raw);

      expect(normalized.capabilityVersions).toBe(capabilityVersions);
      expect(normalized.capabilityVersions).toEqual({ 'skills.read': '1', 'skills.list': '2' });
    });

    it('passes factoryId, config, and namespace through untouched', () => {
      const config = { url: 'https://example.com/x', maxContentBytes: 1024, timeoutMs: 5000 };
      const raw: RawProviderDescriptor = {
        factoryId: 'http',
        config,
        namespace: 'acme/widgets',
      };

      const normalized = normalizeDescriptor(raw);

      expect(normalized.factoryId).toBe('http');
      expect(normalized.config).toBe(config);
      expect(normalized.namespace).toBe('acme/widgets');
    });
  });

  describe('purity — no mutation of the input', () => {
    it('does not mutate the raw descriptor', () => {
      const raw: RawProviderDescriptor = {
        factoryId: 'http',
        config: {},
        namespace: 'acme',
      };

      normalizeDescriptor(raw);

      expect(raw).not.toHaveProperty('trust', UNTRUSTED_DEFAULT);
      expect(raw.trust).toBeUndefined();
      expect(raw.capabilityVersions).toBeUndefined();
    });
  });

  describe('defaults applied exactly once (idempotence)', () => {
    it('a second normalization of the already-defaulted shape is structurally identical', () => {
      const raw: RawProviderDescriptor = {
        factoryId: 'http',
        config: {},
        namespace: 'acme',
      };

      const once = normalizeDescriptor(raw);
      // Feed the normalized result back through as a raw descriptor: the present
      // (defaulted) values must pass through unchanged — proving the defaults were
      // applied once and are stable, not re-applied or compounded.
      const twice = normalizeDescriptor(once);

      expect(twice).toEqual(once);
      expect(twice.trust).toBe(once.trust);
      expect(twice.capabilityVersions).toBe(once.capabilityVersions);
    });
  });

  describe('property: normalized fields are always defined (Req 1.2, 13.1)', () => {
    it('trust and capabilityVersions are defined for any raw input', () => {
      const arbTrust: fc.Arbitrary<TrustPolicy | undefined> = fc.option(
        fc.record({
          tier: fc.constantFrom('trusted', 'untrusted') as fc.Arbitrary<TrustPolicy['tier']>,
          maxContentBytes: fc.nat(),
          isolateFetch: fc.boolean(),
        }),
        { nil: undefined },
      );

      const arbRaw: fc.Arbitrary<RawProviderDescriptor> = fc.record({
        factoryId: fc.string(),
        config: fc.anything(),
        namespace: fc.string(),
        trust: arbTrust,
        capabilityVersions: fc.option(fc.dictionary(fc.string(), fc.string()), {
          nil: undefined,
        }),
      });

      fc.assert(
        fc.property(arbRaw, (raw) => {
          const normalized = normalizeDescriptor(raw);

          // Always defined post-normalization.
          expect(normalized.trust).toBeDefined();
          expect(normalized.capabilityVersions).toBeDefined();

          // Defaults only fill an absent field; present values pass through unchanged.
          expect(normalized.trust).toBe(raw.trust ?? UNTRUSTED_DEFAULT);
          expect(normalized.capabilityVersions).toBe(raw.capabilityVersions ?? normalized.capabilityVersions);
          if (raw.capabilityVersions === undefined) {
            expect(normalized.capabilityVersions).toEqual({});
          } else {
            expect(normalized.capabilityVersions).toBe(raw.capabilityVersions);
          }

          // Pass-through fields are untouched.
          expect(normalized.factoryId).toBe(raw.factoryId);
          expect(normalized.config).toBe(raw.config);
          expect(normalized.namespace).toBe(raw.namespace);
        }),
      );
    });
  });
});
