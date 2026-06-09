/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SPIKE (throwaway) — deterministic provider worker for the M-002 placement spike.
 *
 * A stdio Bus worker that serves `skills.read` with DETERMINISTIC content so the spike can
 * isolate the bus/process-placement question from network flakiness. Supports:
 *   - params.skill      → echoed into the body so responses are attributable;
 *   - params.sizeBytes  → pad the body to this many bytes (backpressure / framing test);
 *   - params.delayMs    → sleep before responding (forced-timeout test).
 *
 * Protocol: NDJSON JSON-RPC over stdin/stdout. STDOUT IS PROTOCOL-ONLY; all diagnostics go to
 * stderr. This mirrors the production bus-worker contract exactly.
 *
 * NOT production. Never imported by production. Findings feed the design, not the code.
 */

import * as readline from 'readline';
import { httpsFetch } from './https-fetch.js';

const WORKER_TAG = process.argv.find((a) => a.startsWith('--tag='))?.slice('--tag='.length) ?? 'provider';
/** The method this worker answers (default skills.read). Lets sibling pools use distinct methods. */
const WORKER_METHOD = process.argv.find((a) => a.startsWith('--method='))?.slice('--method='.length) ?? 'skills.read';

function diag(msg: string): void {
  process.stderr.write(`[provider-worker:${WORKER_TAG} pid=${process.pid}] ${msg}\n`);
}

function writeResult(id: string | number, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function makeBody(skill: string, sizeBytes?: number): string {
  const head = `# sandbox-remote-skill: ${skill}\n\nServed by provider-worker ${WORKER_TAG} (pid ${process.pid}).\n`;
  if (!sizeBytes || sizeBytes <= head.length) return head;
  // Pad deterministically to the requested byte length (ASCII, 1 byte/char).
  return head + 'x'.repeat(sizeBytes - head.length);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: { id?: string | number; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(trimmed);
  } catch {
    diag(`unparseable line: ${trimmed.slice(0, 80)}`);
    return;
  }
  if (msg.id === undefined || msg.method === undefined) return; // notification

  const { id, method, params = {} } = msg as {
    id: string | number;
    method: string;
    params?: Record<string, unknown>;
  };
  diag(`request id=${id} method=${method}`);

  const skill = typeof params.skill === 'string' ? params.skill : 'unknown';
  const sizeBytes = typeof params.sizeBytes === 'number' ? params.sizeBytes : undefined;
  const delayMs = typeof params.delayMs === 'number' ? params.delayMs : 0;
  const url = typeof params.url === 'string' ? params.url : undefined;

  const respond = (): void => {
    if (method !== WORKER_METHOD) {
      writeResult(id, { ok: false, error: { code: 'unsupported', capability: method } });
      return;
    }
    // REAL mode: fetch the skill body over real HTTPS (proves acquisition end-to-end).
    if (url) {
      httpsFetch(url, { timeoutMs: 9_000, maxBytes: 1_000_000 })
        .then((r) => {
          if (!r.ok || r.body === undefined) {
            writeResult(id, { ok: false, error: { code: 'provider_error', provider: WORKER_TAG, message: r.error ?? `status ${r.status}` } });
            return;
          }
          writeResult(id, {
            ok: true,
            data: { descriptor: { fqid: `external:${skill}`, name: skill, provider: 'external', source: url }, body: r.body },
            provenance: { fqid: `external:${skill}`, provider: 'external', source: url, httpStatus: r.status, fetchedBytes: r.bytes },
          });
        })
        .catch((e) => writeResult(id, { ok: false, error: { code: 'provider_error', provider: WORKER_TAG, message: String(e) } }));
      return;
    }
    // DETERMINISTIC mode: fixed/padded body (isolates bus topology from network).
    const body = makeBody(skill, sizeBytes);
    writeResult(id, {
      ok: true,
      data: { descriptor: { fqid: `external:${skill}`, name: skill, provider: 'external', source: `worker:${WORKER_TAG}` }, body },
      provenance: { fqid: `external:${skill}`, provider: 'external', source: `worker:${WORKER_TAG}` },
    });
  };

  if (delayMs > 0) {
    setTimeout(respond, delayMs);
  } else {
    respond();
  }
});

process.on('SIGTERM', () => process.exit(0));
diag('ready');
