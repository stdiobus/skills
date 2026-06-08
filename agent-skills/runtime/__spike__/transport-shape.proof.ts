/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SPIKE — transport-shape proof (TYPE-LEVEL ONLY, never executed).
 *
 * Fact under test (Milestone 001 §10, "transport shape compatibility"):
 * a typed core capability maps 1:1 onto `StdioBus.request<T>(method, params)` without
 * collapsing into the prompt(string)->{text} agent shape.
 *
 * This file is checked by `tsc --noEmit`. It is intentionally NOT imported by the
 * runtime spike, so running the spike never loads the native bus binding.
 *
 * If this file compiles, the SkillsRuntime envelope rides the bus typed.
 */

import StdioBus from '@stdiobus/node';
import { SkillsCapabilities } from '../capabilities.js';
import type { ReadSkillInput, SkillContent, SkillResponse } from '../contract.js';

/**
 * A Bus-backed transport for the `read` capability. The generic on `request<T>` is the
 * full response envelope — proving the discriminated `SkillResponse<SkillContent>` (data
 * + provenance + error model) survives the bus boundary as a typed result.
 *
 * `params` is the structured input. The bus param type is `Record<string, unknown>`, so a
 * concrete serializer is still required to map a typed input object onto it — that is the
 * only adaptation point, and it is data-shaping, not a contract change.
 */
export async function readOverBus(
  bus: StdioBus,
  input: ReadSkillInput,
): Promise<SkillResponse<SkillContent>> {
  return bus.request<SkillResponse<SkillContent>>(
    SkillsCapabilities.read.method, // 'skills.read.v1' — generated from the typed descriptor
    input as unknown as Record<string, unknown>,
  );
}
