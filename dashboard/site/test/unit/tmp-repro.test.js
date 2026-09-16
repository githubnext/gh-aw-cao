// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DATABASE_NAME } from '../../src/data/storage/indexeddb.js';

beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

describe('repro', () => {
  it('ingests many shards without stalling', async () => {
    /** @type {Map<string, (event: { data: Record<string, unknown> }) => void>} */
    const listeners = new Map();
    /** @type {Record<string, unknown>[]} */
    const posted = [];
    globalThis.self = /** @type {any} */ ({
      addEventListener: (type, listener) => { listeners.set(type, listener); },
      postMessage: (message) => { posted.push(structuredClone(message)); }
    });
    await import('../../src/data-worker.js');

    const shardCount = 5;
    const hashes = Object.fromEntries(Array.from({ length: shardCount }, (_, i) => [
      `gh-aw-logs-shards/logs-${i + 1}.jsonl`, String(i + 1).padStart(64, 'a')
    ]));
    const runLine = (id) => JSON.stringify({
      schema_version: 2, kind: 'run',
      run: {
        run_id: id, run_attempt: 1, organization: 'githubnext', repository: 'gh-aw-cao',
        workflow_name: 'Dashboard', workflow_path: '.github/workflows/dashboard.md',
        status: 'completed', classification: 'success', created_at: '2026-09-09T05:00:00Z'
      }
    });
    globalThis.fetch = /** @type {any} */ (async (input) => {
      const url = String(input);
      if (url.endsWith('/payload-hashes.json')) return Response.json(hashes);
      if (url.endsWith('/inventory-sources.json')) return new Response('', { status: 404 });
      const match = /logs-(\d+)\.jsonl$/.exec(url);
      return new Response(`${runLine(300 + Number(match[1]))}\n`);
    });

    // Simulate a lock lease left behind by a terminated tab.
    const { openCanonicalDatabase } = await import('../../src/data/storage/indexeddb.js');
    const database = await openCanonicalDatabase(indexedDB);
    await new Promise((resolve, reject) => {
      const tx = database.transaction('transactions', 'readwrite');
      tx.objectStore('transactions').put({
        id: 'lock:canonical-ingestion',
        kind: 'canonical-ingestion-lock',
        createdAt: new Date().toISOString(),
        owner: 'terminated-tab',
        expiresAt: Date.now() + 240_000
      });
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
    database.close();

    const started = Date.now();
    listeners.get('message')?.({
      data: {
        id: 1,
        operation: 'load-canonical-dashboard',
        sourceUrl: 'https://dashboard.example/payload-hashes.json',
        sourceNames: [],
        context: { pages: [], queries: [] }
      }
    });
    for (let attempt = 0; attempt < 1200 && !posted.some((m) => m.id === 1); attempt += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 5); });
    }
    console.log('elapsed', Date.now() - started, 'result', JSON.stringify(posted.find((m) => m.id === 1)).slice(0, 200));
    expect(posted.find((m) => m.id === 1)?.error).toBeUndefined();
  }, 60_000);
});
