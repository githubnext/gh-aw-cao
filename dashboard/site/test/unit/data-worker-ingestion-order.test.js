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
  it('stores bounded JSONL shards incrementally when bootstrapping with inventory sources', async () => {
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
    /** @type {string[]} */
    const requestedUrls = [];
    globalThis.fetch = /** @type {typeof fetch} */ (async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.endsWith('/payload-hashes.json')) {
        return Response.json({
          'gh-aw-logs.jsonl': 'a'.repeat(64),
          'gh-aw-logs-shards/part-01.jsonl': 'b'.repeat(64),
          'gh-aw-logs-shards/part-02.jsonl': 'c'.repeat(64)
        });
      }
      if (url.endsWith('/inventory-sources.json')) return Response.json(inventory);
      if (url.includes('/gh-aw-logs-shards/')) {
        const shardRun = url.endsWith('/part-02.jsonl')
          ? { ...run, run: { ...run.run, run_id: 304 } }
          : run;
        return new Response(`${JSON.stringify(shardRun)}\n`);
      }
      throw new Error(`Unexpected monolithic activity request: ${url}`);
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
          sourceUrl: 'https://dashboard.example/gh-aw-logs.jsonl',
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
    expect(storedRunIds).toEqual([
      'github:run:303:attempt:1',
      'github:run:304:attempt:1'
    ]);
    expect(requestedUrls).toEqual([
      'https://dashboard.example/payload-hashes.json',
      'https://dashboard.example/inventory-sources.json',
      'https://dashboard.example/gh-aw-logs-shards/part-01.jsonl',
      'https://dashboard.example/gh-aw-logs-shards/part-02.jsonl'
    ]);

    listeners.get('message')?.({
      data: {
        id: 2,
        operation: 'load-canonical-dashboard',
        sourceUrl: 'https://dashboard.example/gh-aw-logs.jsonl',
        sourceNames: [],
        context: { pages: [], queries: [] },
        reportActivation: true
      }
    });
    for (let attempt = 0; attempt < 200 && !posted.some((message) => message.id === 2); attempt += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 5); });
    }
    expect(posted.find((message) => message.id === 2)?.data).toMatchObject({ changed: false });
    expect(requestedUrls).toEqual([
      'https://dashboard.example/payload-hashes.json',
      'https://dashboard.example/inventory-sources.json',
      'https://dashboard.example/gh-aw-logs-shards/part-01.jsonl',
      'https://dashboard.example/gh-aw-logs-shards/part-02.jsonl',
      'https://dashboard.example/payload-hashes.json',
      'https://dashboard.example/inventory-sources.json'
    ]);
  });
});
