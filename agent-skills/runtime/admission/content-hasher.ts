/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ContentHasher — the record-only acquired-content hash seam
 * (Milestone-002, Task 7.2; design §"Components" 4; Req 8.2).
 *
 * The admission `hash-record` stage (Task 8) computes a hash over the bytes a provider
 * acquired and records it on the admission/read provenance (`provenance.contentHash`, carried
 * additively through the existing index signature — no contract edit). The hash is a piece of
 * recorded **provenance**, nothing more.
 *
 * ─── RECORD-ONLY — NEVER CONSULTED BY `dedupeWithConflicts` (design fix 8, Req 8.2) ─
 *
 * The content hash plays **no** part in equality, dedupe, or conflict detection. The
 * Milestone-001 federation mechanics (`dedupeWithConflicts`) key on FQID and the existing
 * content comparison ONLY; they do not read `contentHash`. This is a load-bearing invariant:
 * if the hash ever fed dedupe/conflict logic, two byte-identical skills acquired from
 * different origins (or the same skill re-acquired with trivial encoding differences) could
 * be silently merged or spuriously flagged. The hash is therefore strictly additive
 * provenance, swappable without touching any equality semantics.
 *
 * ─── SWAPPABLE ALGORITHM (architecture standard §6) ────────────────────────────────
 *
 * The default is SHA-256 over the acquired bytes (the interim, explicitly-labeled algorithm
 * for M-002). The {@link ContentHasher} interface is injected into the
 * {@link AdmissionController} as a seam so the algorithm can change in ONE place
 * ({@link Sha256ContentHasher}) without touching the controller or any stage. A hasher is a
 * pure value transform; it is modeled as an injectable object (not a free function) precisely
 * so the algorithm is a constructor-supplied dependency rather than a hard-wired import.
 */

import { createHash } from 'node:crypto';

/**
 * A pure, deterministic hash over acquired skill content (record-only; Req 8.2).
 *
 * Implementations MUST be deterministic: identical input bytes MUST yield an identical
 * digest, and differing input bytes MUST (overwhelmingly) yield a differing digest. The
 * returned string is opaque provenance — its only contract is stability and difference, never
 * a role in equality/dedupe.
 */
export interface ContentHasher {
  /**
   * Hash the acquired content.
   *
   * @param bytes - the acquired content as a {@link Buffer} (raw bytes) or a `string`
   *   (interpreted as UTF-8, so a string and its UTF-8 {@link Buffer} hash identically).
   * @returns a stable, opaque digest string (record-only provenance).
   */
  hash(bytes: Buffer | string): string;
}

/**
 * The default {@link ContentHasher}: lowercase-hex SHA-256 over the acquired bytes.
 *
 * Deterministic and collision-resistant for the record-only provenance use. A `string` input
 * is encoded as UTF-8 before hashing, so `hash('x')` and `hash(Buffer.from('x', 'utf8'))`
 * agree. This class is the single place the M-002 hash algorithm is defined; swapping it for
 * another {@link ContentHasher} changes the recorded algorithm without touching admission.
 */
export class Sha256ContentHasher implements ContentHasher {
  hash(bytes: Buffer | string): string {
    const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
    return createHash('sha256').update(buf).digest('hex');
  }
}

/**
 * The shared default hasher instance (SHA-256). The {@link AdmissionController} composes this
 * by default; a deployment may inject a different {@link ContentHasher} at composition time.
 */
export const defaultContentHasher: ContentHasher = new Sha256ContentHasher();
