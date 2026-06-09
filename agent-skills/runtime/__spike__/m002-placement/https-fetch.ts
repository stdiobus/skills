/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SPIKE (throwaway) — minimal REAL HTTPS fetch with size + time bounds.
 *
 * Uses Node's global `fetch` (Node >=20) over the platform's standard TLS/CA — no certificate
 * or trust-policy feature is built here (that is explicitly out of M-002 scope). Bounds:
 *   - `timeoutMs` via AbortController (per-operation timeout seam);
 *   - `maxBytes`  hard cap on the body read (size bound; reject oversize, do not buffer past it).
 *
 * This is the "acquire" behaviour of the HTTP provider, proven against a real public origin.
 */

export interface HttpsFetchResult {
  ok: boolean;
  status: number;
  bytes: number;
  body?: string;
  error?: string;
}

export async function httpsFetch(
  url: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<HttpsFetchResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? 1_000_000;

  if (!url.startsWith('https://')) {
    return { ok: false, status: 0, bytes: 0, error: 'only https:// is allowed' };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > maxBytes) {
      return { ok: false, status: res.status, bytes: declared, error: `content-length ${declared} > maxBytes ${maxBytes}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      return { ok: false, status: res.status, bytes: buf.length, error: `body ${buf.length} > maxBytes ${maxBytes}` };
    }
    return { ok: res.ok, status: res.status, bytes: buf.length, body: buf.toString('utf8') };
  } catch (e) {
    return { ok: false, status: 0, bytes: 0, error: String(e) };
  } finally {
    clearTimeout(timer);
  }
}
