/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Namespace ownership — the single ownership source of truth
 * (Milestone-002, Task 3; design §"Components" 3; Req 5).
 *
 * A namespace is the set of FQID prefixes a provider may mint (Req 5.1): the `provider`
 * segment of every FQID an admitted provider emits MUST be a namespace that provider owns.
 * The {@link NamespaceOwnershipTable} is the one place that records ownership and answers
 * the two questions the admission pipeline and the provider-output boundary ask:
 *
 *   - {@link NamespaceOwnershipTable.claim} — at admission, bind a namespace to a provider,
 *     but ONLY if it is neither reserved nor already owned (Req 5.2, 5.3). Returns a typed
 *     {@link StageResult}; a reserved/owned namespace is the `{ ok: false }` branch, never a
 *     thrown exception, so the `admit` stage maps it straight to a quarantine (Req 5.3).
 *   - {@link NamespaceOwnershipTable.owns} — who, if anyone, owns a namespace.
 *   - {@link NamespaceOwnershipTable.permits} — does this provider own the namespace under
 *     which a given FQID falls? This is the anti-spoofing predicate (Req 5.4), and it
 *     operates on the CHILD provider id and FQID directly, so it can never be masked by an
 *     aggregation layer (Req 5.5; design Property 4).
 *
 * ─── RESERVED FIRST-PARTY NAMESPACE ────────────────────────────────────────────────
 *
 * `bundled` is RESERVED (Req 5.3): it identifies the first-party bundled filesystem
 * provider and can never be claimed by an admitted external provider. An admission request
 * asserting `bundled` (or any already-owned namespace) is rejected at {@link claim}, so an
 * external provider cannot impersonate `bundled:*` or another provider's prefix.
 *
 * ─── ANTI-SPOOFING ON THE CHILD ID (Req 5.4, 5.5) ──────────────────────────────────
 *
 * {@link permits} parses the FQID via the single {@link parseFqid} grammar boundary and
 * checks that the FQID's `provider` prefix maps, in this table, to the SAME provider id
 * being checked. A registered provider that returns an FQID whose prefix it does not own
 * (a malformed FQID, an unowned prefix, or another provider's prefix) is NOT permitted —
 * the provider-output boundary (Task 6) rejects that descriptor with a typed error rather
 * than admitting it into a result. The check is on the child provider id, not an aggregate,
 * so federation can never launder an out-of-namespace FQID.
 */

import { parseFqid } from '../fqid.js';
import type { StageResult } from './stage.js';

/**
 * The single namespace-ownership source of truth (design §"Components" 3).
 *
 * Mutable: ownership accrues as providers are admitted (add-only in M-002 — there is no
 * release/evict, mirroring the add-only registry, Req 10.6). All decisions are returned
 * data, never thrown.
 */
export class NamespaceOwnershipTable {
  /** namespace → owning providerId. The authoritative ownership record. */
  private readonly owners = new Map<string, string>();

  /**
   * Reserved first-party namespaces that no admitted provider may claim (Req 5.3).
   * `bundled` is the bundled filesystem provider's namespace.
   */
  private static readonly RESERVED: ReadonlySet<string> = new Set<string>(['bundled']);

  /**
   * Claim a namespace for a provider at admission (Req 5.2, 5.3).
   *
   * Succeeds only when the namespace is non-empty, NOT reserved, and NOT already owned.
   * On success the namespace is bound to `providerId` and `{ ok: true }` is returned; on
   * any rejection a typed `bad_request` {@link StageResult} naming the reason is returned
   * (never thrown), which the `admit` stage renders into a quarantine.
   *
   * @param namespace - the FQID prefix the provider is requesting to own.
   * @param providerId - the id of the provider claiming the namespace.
   * @returns `{ ok: true; value: undefined }` on a successful claim, else `{ ok: false; error }`.
   */
  claim(namespace: string, providerId: string): StageResult<void> {
    if (typeof namespace !== 'string' || namespace.length === 0) {
      return {
        ok: false,
        error: { code: 'bad_request', issues: ['namespace must be a non-empty string'] },
      };
    }

    if (NamespaceOwnershipTable.RESERVED.has(namespace)) {
      return {
        ok: false,
        error: {
          code: 'bad_request',
          issues: [`namespace '${namespace}' is reserved (first-party) and cannot be claimed`],
        },
      };
    }

    const existing = this.owners.get(namespace);
    if (existing !== undefined) {
      return {
        ok: false,
        error: {
          code: 'bad_request',
          issues: [`namespace '${namespace}' is already owned by provider '${existing}'`],
        },
      };
    }

    this.owners.set(namespace, providerId);
    return { ok: true, value: undefined };
  }

  /**
   * Return the provider id that owns `namespace`, or `undefined` when unowned (Req 5.2).
   *
   * Reserved namespaces (e.g. `bundled`) are never claimed through {@link claim}, so this
   * reports `undefined` for them — ownership is the claimed-external-provider record only.
   *
   * @param namespace - the namespace to look up.
   * @returns the owning provider id, or `undefined` if no provider owns it.
   */
  owns(namespace: string): string | undefined {
    return this.owners.get(namespace);
  }

  /**
   * Does `providerId` own at least one namespace in this table? (Req 5.4 applicability gate.)
   *
   * This is the backward-compatibility seam the provider-output boundary (Task 6) keys on:
   * the namespace-ownership check (`permits`) applies ONLY to providers that have actually
   * claimed a namespace. The reserved first-party `bundled` provider never claims a
   * namespace through {@link claim} (Req 5.3), so it owns nothing here and is EXEMPT from
   * the namespace check — the proven single-bundled-provider baseline stays byte-for-byte
   * unchanged even when an ownership table is wired for a federated deployment. An admitted
   * external provider, having claimed its namespace at admission, returns `true` and is
   * therefore subject to the anti-spoofing {@link permits} check on every operation.
   *
   * @param providerId - the provider id to test for any owned namespace.
   * @returns `true` iff `providerId` owns one or more namespaces in this table.
   */
  hasOwnership(providerId: string): boolean {
    for (const owner of this.owners.values()) {
      if (owner === providerId) return true;
    }
    return false;
  }

  /**
   * Anti-spoofing predicate: may `providerId` mint `fqid`? (Req 5.4, 5.5; Property 4.)
   *
   * Parses the FQID via the single {@link parseFqid} grammar boundary and permits it ONLY
   * when its `provider` prefix is a namespace this exact `providerId` owns in the table. A
   * malformed FQID, an unowned prefix, or another provider's prefix all return `false` —
   * the provider-output boundary then rejects that descriptor. Operates on the child
   * provider id directly, so an aggregation layer cannot mask an out-of-namespace FQID.
   *
   * @param providerId - the id of the provider that returned the FQID.
   * @param fqid - the fully-qualified id to check against the provider's owned namespace.
   * @returns `true` iff `providerId` owns the namespace named by the FQID's prefix.
   */
  permits(providerId: string, fqid: string): boolean {
    const parts = parseFqid(fqid);
    if (parts === null) return false;
    return this.owners.get(parts.provider) === providerId;
  }
}
