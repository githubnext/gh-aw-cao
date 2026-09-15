// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DATABASE_NAME } from '../../src/data/storage/indexeddb.js';

beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

describe('canonical dashboard worker ingestion order', () => {
  it('stores JSONL run records once when bootstrapping with inventory sources', async () => {
    /** @type {Map<string, (event: { data: Record<string, unknown> }) => void>} */
    const listeners = new Map();
    /** @type {Record<string, unknown>[]} */
    const posted = [];
    globalThis.self = /** @type {typeof globalThis.self} */ (/** @type {unknown} */ ({
      addEventListener: (/** @type {string} */ type, /** @type {(event: { data: Record<string, unknown> }) => void} */ listener) => {
        listeners.set(type, listener);
      },
      postMessage: (/** @type {Record<string, unknown>} */ message) => {
        posted.push(structuredClone(message));
      }
    }));
    await import('../../src/data-worker.js');

    const run = {
      schema_version: 2,
      kind: 'run',
      run: {
        run_id: 303,
        run_attempt: 1,
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        workflow_name: 'Dashboard',
        workflow_path: '.github/workflows/dashboard.md',
        status: 'completed',
        classification: 'success',
        created_at: '2026-09-09T05:00:00Z'
      }
    };
    const inventory = {
      repositories: {
        rows: [{ organization: 'githubnext', repository: 'gh-aw-cao' }],
        metadata: { 'as-of': '2026-09-09T05:00:00Z' }
      }
    };
    globalThis.fetch = /** @type {typeof fetch} */ (async (input) => {
      const url = String(input);
      if (url.endsWith('/payload-hashes.json')) {
        return Response.json({ 'gh-aw-logs-shards/logs-1.jsonl': 'a'.repeat(64) });
      }
      if (url.endsWith('/inventory-sources.json')) return Response.json(inventory);
      return new Response(`${JSON.stringify(run)}\n`);
    });

    /** @type {string[]} */
    const storedRunIds = [];
    const originalPut = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(/** @this {IDBObjectStore} */ function (value, key) {
      if (this.name === 'runs') storedRunIds.push(String(value.id));
      return key === undefined
        ? originalPut.call(this, value)
        : originalPut.call(this, value, key);
    });
    try {
      listeners.get('message')?.({
        data: {
          id: 1,
          operation: 'load-canonical-dashboard',
          sourceUrl: 'https://dashboard.example/payload-hashes.json',
          sourceNames: [],
          context: { pages: [], queries: [] }
        }
      });
      for (let attempt = 0; attempt < 200 && !posted.some((message) => message.id === 1); attempt += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 5); });
      }
    } finally {
      put.mockRestore();
    }

    expect(posted.find((message) => message.id === 1)?.error).toBeUndefined();
    expect(storedRunIds).toEqual(['github:run:303:attempt:1']);
  });
});
