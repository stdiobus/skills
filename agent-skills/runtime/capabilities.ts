/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  capability,
  type CapabilityRef,
  type GetReferencesInput,
  type ListSkillsInput,
  type ReadReferenceInput,
  type ReadSkillInput,
  type ReferenceContent,
  type ReferenceDescriptor,
  type SearchResult,
  type SearchSkillsInput,
  type SkillContent,
  type SkillDescriptor,
} from './contract.js';

/**
 * Versioned core capability descriptors.
 *
 * The `method` strings (`skills.read.v1`, ...) are the wire names that map 1:1 onto
 * `StdioBus.request(method, params)`. Versioning is baked into the name from day one so
 * the contract can evolve without semantic drift. These descriptors are the single
 * source that ties a typed signature to a transport method — the strings are generated
 * from typed descriptors, never written by hand at call sites.
 */
export const SkillsCapabilities = {
  read: capability<ReadSkillInput, SkillContent>('skills.read.v1', '1'),
  list: capability<ListSkillsInput, SkillDescriptor[]>('skills.list.v1', '1'),
  search: capability<SearchSkillsInput, SearchResult[]>('skills.search.v1', '1'),
  listReferences: capability<GetReferencesInput, ReferenceDescriptor[]>(
    'skills.references.list.v1',
    '1',
  ),
  readReference: capability<ReadReferenceInput, ReferenceContent>(
    'skills.references.read.v1',
    '1',
  ),
} as const;

/** All core capabilities as a flat list, for `SkillsRuntime.capabilities()` introspection. */
export const CORE_CAPABILITIES: ReadonlyArray<CapabilityRef<unknown, unknown>> = [
  SkillsCapabilities.read as CapabilityRef<unknown, unknown>,
  SkillsCapabilities.list as CapabilityRef<unknown, unknown>,
  SkillsCapabilities.search as CapabilityRef<unknown, unknown>,
  SkillsCapabilities.listReferences as CapabilityRef<unknown, unknown>,
  SkillsCapabilities.readReference as CapabilityRef<unknown, unknown>,
];
