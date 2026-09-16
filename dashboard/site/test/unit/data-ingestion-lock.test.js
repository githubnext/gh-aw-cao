// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  canonicalDatabaseName,
  DATABASE_NAME,
  openCanonicalDatabase
} from '../../src/data/storage/indexeddb.js';
import { ingestCachedGhAwJsonl } from '../../src/data/ingest/coordinator.js';

/** @param {number} runId */
function runLine(runId) {
  return `${JSON.stringify({
    schema_version: 2,
    kind: 'run',
    run: {
      run_id: runId,
      run_attempt: 1,
      organization: 'githubnext',
      repository: 'gh-aw-cao',
      workflow_name: 'Dashboard',
      workflow_path: '.github/workflows/dashboard.md',
      status: 'completed',
      classification: 'success',
      created_at: '2026-09-09T05:00:00Z'
    }
  })}\n`;
}

/** Records the lease a tab terminated mid-ingestion would leave behind. */
async function writeAbandonedLease() {
  const database = await openCanonicalDatabase(indexedDB);
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('transactions', 'readwrite');
      transaction.objectStore('transactions').put({
        id: 'lock:canonical-ingestion',
        kind: 'canonical-ingestion-lock',
        createdAt: new Date().toISOString(),
        owner: 'terminated-tab',
        expiresAt: Date.now() + (4 * 60 * 1000)
      });
      transaction.oncomplete = () => resolve(undefined);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

describe('canonical ingestion locking', () => {
  it('imports activity shards after a tab is terminated mid-ingestion', async () => {
    /** @type {Map<string, (event: { data: Record<string, unknown> }) => void>} */
    const listeners = new Map();
    /** @type {Record<string, unknown>[]} */
    const posted = [];
    globalThis.self = /** @type {typeof globalThis.self} */ (/** @type {unknown} */ ({
      addEventListener: (
        /** @type {string} */ type,
        /** @type {(event: { data: Record<string, unknown> }) => void} */ listener
      ) => {
        listeners.set(type, listener);
      },
      postMessage: (/** @type {Record<string, unknown>} */ message) => {
        posted.push(structuredClone(message));
      }
    }));
    await import('../../src/data-worker.js');

    const payloadHashes = {
      'gh-aw-logs-shards/logs-1.jsonl': 'a'.repeat(64),
      'gh-aw-logs-shards/logs-2.jsonl': 'b'.repeat(64)
    };
    globalThis.fetch = /** @type {typeof fetch} */ (async (input) => {
      const url = String(input);
      if (url.endsWith('/payload-hashes.json')) return Response.json(payloadHashes);
      if (url.endsWith('/inventory-sources.json')) return new Response('', { status: 404 });
      return new Response(runLine(url.endsWith('logs-1.jsonl') ? 301 : 302));
    });

    await writeAbandonedLease();

    listeners.get('message')?.({
      data: {
        id: 1,
        operation: 'load-canonical-dashboard',
        sourceUrl: 'https://dashboard.example/payload-hashes.json',
        sourceNames: [],
        context: { pages: [], queries: [] }
      }
    });
    for (let attempt = 0; attempt < 400 && !posted.some((message) => message.id === 1); attempt += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 5); });
    }

    const result = posted.find((message) => message.id === 1);
    expect(result).toBeDefined();
    expect(result?.error).toBeUndefined();
  });

  it('reports that ingestion is waiting for another holder', async () => {
    let release = () => {};
    const held = new Promise((resolve) => { release = () => resolve(undefined); });
    const holder = navigator.locks.request(`canonical-ingestion:${canonicalDatabaseName()}`, () => held);
    /** @type {Promise<void>} */
    const waiting = new Promise((resolve) => {
      void ingestCachedGhAwJsonl(indexedDB, runLine(303), {
        payloadIdentity: 'c'.repeat(64),
        payloadScope: 'https://dashboard.example/gh-aw-logs-shards/logs-3.jsonl',
        onLockWait: () => resolve(undefined)
      }).then(() => undefined, () => undefined);
    });

    await expect(waiting).resolves.toBeUndefined();
    release();
    await holder;
  });
});
