// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { CANONICAL_SCHEMA_VERSION } from '../../src/data/model/schema.js';
import { DATABASE_NAME, readTransactions } from '../../src/data/storage/indexeddb.js';

const metadata = { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': 'generation-a' };

/**
 * @param {string} generation
 * @param {Record<string, unknown>[]} toolRows
 */
function collection(generation, toolRows) {
  const collected = { ...metadata, 'artifact-generation': generation };
  return {
    repositories: { rows: [{ organization: 'githubnext', repository: 'gh-aw-cao' }], metadata: collected },
    workflows: {
      rows: [{ organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md' }],
      metadata: collected
    },
    runs: {
      rows: [{
        organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md',
        run: '42', 'run-attempt': 1, 'run-status': 'completed', 'run-conclusion': 'success',
        'started-at': '2026-09-09T04:00:00Z'
      }],
      metadata: collected
    },
    domains: { rows: [], metadata: collected },
    tools: { rows: toolRows, metadata: collected },
    audits: { rows: [], metadata: collected },
    issues: { rows: [], metadata: collected }
  };
}

const toolRows = [
  {
    run: '42', 'run-attempt': 1, event: 'event:tool-call',
    'event-timestamp': '2026-09-09T04:00:10Z', 'event-source': 'mcp', 'event-type': 'tool.call',
    'event-summary': 'github.list_issues', 'source-sequence': 0, 'observed-at': '2026-09-09T04:00:10Z'
  }
];

const context = {
  pages: [],
  queries: [{
    name: 'tool-inspection',
    from: 'tools',
    select: [{ field: 'event' }, { field: 'event-type' }],
    'order-by': [{ field: 'event', direction: 'asc' }]
  }]
};

/** @param {Record<string, unknown>} sources */
function stubFetch(sources) {
  globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {URL} */ url) => {
    if (String(url).endsWith('/sources/manifest.json')) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => sources };
  }));
}

beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

describe('canonical dashboard worker retention updates', () => {
  it('publishes retained tools to subscribers after a partial collection', async () => {
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
    const dispatch = (/** @type {Record<string, unknown>} */ data) => listeners.get('message')?.({ data });
    /** @param {(message: Record<string, unknown>) => boolean} match */
    const settled = async (match) => {
      for (let attempt = 0; attempt < 200 && !posted.some(match); attempt += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 5); });
      }
      return posted.find(match);
    };

    dispatch({
      operation: 'subscribe-canonical-dashboard',
      subscriptionId: 'tools',
      sourceNames: ['tool-inspection'],
      context
    });
    stubFetch(collection('generation-a', toolRows));
    dispatch({
      id: 1,
      operation: 'load-canonical-dashboard',
      sourceUrl: 'https://dashboard.example/sources.json',
      sourceNames: ['tool-inspection'],
      context
    });

    const loaded = await settled((message) => message.id === 1);
    expect(loaded?.error).toBeUndefined();
    const published = await settled((message) => message.subscriptionId === 'tools');
    expect(published).toMatchObject({ subscriptionId: 'tools' });

    posted.length = 0;
    stubFetch(collection('generation-b', []));
    dispatch({
      id: 2,
      operation: 'load-canonical-dashboard',
      sourceUrl: 'https://dashboard.example/sources.json',
      sourceNames: ['tool-inspection'],
      context
    });

    const refreshed = await settled((message) => message.id === 2);
    expect(refreshed?.error).toBeUndefined();
    const republished = await settled((message) => message.subscriptionId === 'tools');
    const rows = /** @type {{ data: Record<string, { rows: Record<string, unknown>[] }> }} */ (republished)
      .data['tool-inspection'].rows;

    expect(rows.map((row) => row.event)).toEqual(['event:tool-call']);

    /** @type {(RequestInit | undefined)[]} */
    const jsonlRequests = [];
    /** @type {string[]} */
    const requestUrls = [];
    const normalizedName = `gh-aw-logs-normalized/${'a'.repeat(64)}-${'b'.repeat(16)}.json`;
    const normalizedPayload = {
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      ingestionVersion: 2,
      sourceRecords: 0,
      batch: {
        campaigns: [],
        repositories: [],
        workflows: [],
        runs: [],
        domains: [],
        tools: [],
        audits: [],
        issues: []
      }
    };
    const payloadHashes = {
      'gh-aw-logs.sqlite': 'b'.repeat(64),
      'gh-aw-logs-shards/logs-1.jsonl': 'c'.repeat(64),
      [normalizedName]: 'd'.repeat(64)
    };
    globalThis.fetch = /** @type {typeof fetch} */ (async (input, init) => {
      requestUrls.push(String(input));
      if (String(input).endsWith('/payload-hashes.json')) return Response.json(payloadHashes);
      if (String(input).endsWith('/inventory-sources.json')) return new Response(null, { status: 404 });
      jsonlRequests.push(init);
      return Response.json(normalizedPayload, { headers: { etag: '"generation-b"' } });
    });
    dispatch({
      id: 3,
      operation: 'load-canonical-dashboard',
      sourceUrl: 'https://dashboard.example/payload-hashes.json',
      sourceNames: ['tool-inspection'],
      context,
      reportActivation: true
    });
    const firstJsonl = await settled((message) => message.id === 3);
    const repeatedStart = posted.length;
    dispatch({
      id: 4,
      operation: 'load-canonical-dashboard',
      sourceUrl: 'https://dashboard.example/payload-hashes.json',
      sourceNames: ['tool-inspection'],
      context,
      reportActivation: true
    });
    const repeatedJsonl = await settled((message) => message.id === 4);

    expect(firstJsonl?.data).toMatchObject({ changed: true });
    expect(repeatedJsonl?.data).toMatchObject({ changed: false });
    expect(posted.slice(repeatedStart).filter(({ type }) => (
      type === 'notification' || type === 'loading-progress'
    ))).toEqual([]);
    expect(jsonlRequests).toEqual([
      expect.objectContaining({ method: 'HEAD', signal: expect.any(AbortSignal) }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    ]);
    expect(requestUrls).toEqual([
      'https://dashboard.example/inventory-sources.json',
      'https://dashboard.example/payload-hashes.json',
      `https://dashboard.example/${normalizedName}`,
      `https://dashboard.example/${normalizedName}`,
      'https://dashboard.example/inventory-sources.json',
      'https://dashboard.example/payload-hashes.json'
    ]);
    expect((await readTransactions(indexedDB))
      .filter((transaction) => transaction.kind === 'ingest-normalized-json'))
      .toEqual([
        expect.objectContaining({
          payloadScope: `https://dashboard.example/${normalizedName}`,
          payloadHash: payloadHashes[normalizedName],
          committedRecords: expect.any(Number)
        })
      ]);

    const updatedPayloadHashes = {
      ...payloadHashes,

      [normalizedName]: 'e'.repeat(64)
    };
    globalThis.fetch = /** @type {typeof fetch} */ (async (input, init) => {
      if (String(input).endsWith('/payload-hashes.json')) return Response.json(updatedPayloadHashes);
      if (String(input).endsWith('/inventory-sources.json')) return new Response(null, { status: 404 });
      jsonlRequests.push(init);
      return Response.json(normalizedPayload, { headers: { etag: '"generation-c"' } });
    });
    dispatch({
      id: 5,
      operation: 'load-canonical-dashboard',
      sourceUrl: 'https://dashboard.example/payload-hashes.json',
      sourceNames: ['tool-inspection'],
      context,
      reportActivation: true
    });
    expect((await settled((message) => message.id === 5))?.data).toMatchObject({ changed: true });
    expect(jsonlRequests.slice(2)).toEqual([
      expect.objectContaining({ method: 'HEAD', signal: expect.any(AbortSignal) }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    ]);
    dispatch({
      id: 6,
      operation: 'load-canonical-dashboard',
      sourceUrl: 'https://dashboard.example/payload-hashes.json',
      sourceNames: ['tool-inspection'],
      context,
      reportActivation: true
    });
    expect((await settled((message) => message.id === 6))?.data).toMatchObject({ changed: false });
    expect(jsonlRequests).toHaveLength(4);

    globalThis.fetch = /** @type {typeof fetch} */ (async (input) => {
      if (String(input).endsWith('/payload-hashes.json')) return new Response(null, { status: 404 });
      if (String(input).endsWith('/inventory-sources.json')) return new Response(null, { status: 404 });
      return new Response('');
    });
    dispatch({
      id: 7,
      operation: 'load-canonical-dashboard',
      sourceUrl: 'https://dashboard.example/payload-hashes.json',
      sourceNames: ['tool-inspection'],
      context,
      reportActivation: true
    });
    expect((await settled((message) => message.id === 7))?.error).toMatch(
      /Activity shard manifest is missing/
    );

    dispatch({
      id: 8,
      operation: 'execute-dashboard-queries',
      queries: context.queries,
      sources: {
        tools: {
          source: 'tools',
          /** @returns {Record<string, unknown>[]} */
          get rows() {
            throw new Error('source read failed');
          },
          metadata
        }
      }
    });

    expect(await settled((message) => message.id === 8)).toMatchObject({
      cancelled: false,
      error: 'source read failed'
    });
  });
});
