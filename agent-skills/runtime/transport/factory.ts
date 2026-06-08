/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

import { InProcessSkillsRuntime, type TrustLookup } from '../in-process-runtime.js';
import { BusSkillsRuntime } from './bus-runtime.js';
import type { SkillProvider, SkillsRuntime } from '../contract.js';

/**
 * Transport selection (Migration Step 1 — design §3a, Req 6.1, 6.5, 6.6).
 *
 * One {@link SkillsRuntime} contract, transport chosen by deployment configuration. Call
 * sites stay transport-blind: they obtain a `SkillsRuntime` from {@link createSkillsRuntime}
 * and never branch on transport themselves.
 *
 * - `in-process`: the PROVEN default — {@link InProcessSkillsRuntime} invokes providers by
 *   direct call with no serialization (Req 6.2).
 * - `stdio-bus`: the selectable bus backend (PROMOTED — Migration Step 5, Task 7.3).
 *   {@link BusSkillsRuntime} implements the SAME `SkillsRuntime` contract over
 *   `StdioBus.request`, so selecting it is a deployment-config change with no call-site
 *   edit (Req 6.5, 6.6). It owns a default bus (lazily started) unless a caller-owned bus
 *   is injected directly into {@link BusSkillsRuntime}.
 */
export type TransportConfig =
  | { kind: 'in-process' }
  | { kind: 'stdio-bus'; pool: string; timeoutMs?: number };

/**
 * Build a {@link SkillsRuntime} for the configured transport over the given providers.
 *
 * Returns the same contract regardless of transport, so switching transport is a config
 * change with no call-site edit (Req 6.1, 6.6).
 *
 * @param cfg - transport selection.
 * @param providers - the ordered providers (in-process backend; ignored by the bus client).
 * @param trustOf - OPTIONAL per-provider trust lookup (Task 9.2; design §9). When supplied,
 *   the in-process backend enforces each provider's `permittedRoot` / `maxContentBytes` at
 *   the read boundary (Req 11.4, 11.5). Omitted → no enforcement (proven baseline). The
 *   stdio-bus client does not enforce here: trust enforcement lives in the worker that hosts
 *   the in-process runtime over the same providers (worker-side, out of scope for this seam).
 */
export function createSkillsRuntime(
  cfg: TransportConfig,
  providers: ReadonlyArray<SkillProvider>,
  trustOf?: TrustLookup,
): SkillsRuntime {
  switch (cfg.kind) {
    case 'in-process':
      // PROVEN, unchanged (Milestone §11; design §3 in-process backend). The optional
      // `trustOf` adds the Task 9.2 security boundary without altering baseline behavior.
      return new InProcessSkillsRuntime(providers, trustOf);
    case 'stdio-bus':
      // Selectable bus transport (design §3a/§3b, Req 6.1, 6.5, 6.6, 6.7). The worker side
      // hosts an in-process runtime over the same providers (proven topology); the client
      // routes each capability over the bus. `providers` is not used on the client side —
      // resolution happens in the worker — so only the bus config is threaded through.
      return new BusSkillsRuntime(cfg);
    default: {
      // Exhaustiveness guard: a new TransportConfig variant must extend this switch.
      const _exhaustive: never = cfg;
      throw new Error(`unknown transport config: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
