// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DATABASE_NAME, readTransactions } from '../../src/data/storage/indexeddb.js';

const metadata = { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': 'generation-a' };

/**
 * @param {string} generation
 * @param {Record<string, unknown>[]} eventRows
 */
function collection(generation, eventRows) {
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
    sessions: {
      rows: [{
        organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md',
        run: '42', 'run-attempt': 1, session: 'session:run-42',
        'session-status': 'completed', 'started-at': '2026-09-09T04:00:00Z',
        'observed-at': '2026-09-09T04:00:00Z'
      }],
      metadata: collected
    },
    events: { rows: eventRows, metadata: collected }
  };
}

const eventRows = [
  {
    session: 'session:run-42', event: 'event:tool-call',
    'event-timestamp': '2026-09-09T04:00:10Z', 'event-source': 'mcp', 'event-type': 'tool.call',
    'event-summary': 'github.list_issues', 'source-sequence': 0, 'observed-at': '2026-09-09T04:00:10Z'
  },
  {
    session: 'session:run-42', event: 'event:agent-turn',
    'event-timestamp': '2026-09-09T04:00:20Z', 'event-source': 'agent', 'event-type': 'agent_turn',
    'event-summary': 'Planned the change', 'source-sequence': 1, 'observed-at': '2026-09-09T04:00:20Z'
  }
];

const context = {
  pages: [],
  queries: [{
    name: 'event-inspection',
    from: 'events',
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
  it('publishes retained events to subscribers after a partial collection', async () => {
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
      subscriptionId: 'events',
      sourceNames: ['event-inspection'],
      context
    });
    stubFetch(collection('generation-a', eventRows));
    dispatch({
      id: 1,
      operation: 'load-canonical-dashboard',
      sourceUrl: 'https://dashboard.example/sources.json',
      sourceNames: ['event-inspection'],
      context
    });

    const loaded = await settled((message) => message.id === 1);
    expect(loaded?.error).toBeUndefined();
    const published = await settled((message) => message.subscriptionId === 'events');
    expect(published).toMatchObject({ subscriptionId: 'events' });

    posted.length = 0;
    stubFetch(collection('generation-b', [eventRows[1]]));
    dispatch({
      id: 2,
      operation: 'load-canonical-dashboard',
      sourceUrl: 'https://dashboard.example/sources.json',
      sourceNames: ['event-inspection'],
      context
    });

    const refreshed = await settled((message) => message.id === 2);
    expect(refreshed?.error).toBeUndefined();
    const republished = await settled((message) => message.subscriptionId === 'events');
    const rows = /** @type {{ data: Record<string, { rows: Record<string, unknown>[] }> }} */ (republished)
      .data['event-inspection'].rows;

    expect(rows.map((row) => row.event)).toEqual(['event:agent-turn', 'event:tool-call']);

    /** @type {(RequestInit | undefined)[]} */
    const jsonlRequests = [];
    /** @type {string[]} */
    const requestUrls = [];
    const normalizedName = `gh-aw-logs-normalized/${'a'.repeat(64)}-${'b'.repeat(16)}.json`;
    const normalizedPayload = {
      schemaVersion: 8,
      ingestionVersion: 2,
      sourceRecords: 0,
      batch: {
        packages: [],
        repositories: [],
        workflows: [],
        runs: [],
        jobs: [],
        sessions: [],
        events: []
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
      sourceNames: ['event-inspection'],
      context,
      reportActivation: true
    });
    const firstJsonl = await settled((message) => message.id === 3);
    dispatch({
      id: 4,
      operation: 'load-canonical-dashboard',
      sourceUrl: 'https://dashboard.example/payload-hashes.json',
      sourceNames: ['event-inspection'],
      context,
      reportActivation: true
    });
    const repeatedJsonl = await settled((message) => message.id === 4);

    expect(firstJsonl?.data).toMatchObject({ changed: true });
    expect(repeatedJsonl?.data).toMatchObject({ changed: false });
    expect(jsonlRequests).toHaveLength(1);
    expect(requestUrls).toEqual([
      'https://dashboard.example/payload-hashes.json',
      'https://dashboard.example/inventory-sources.json',
      `https://dashboard.example/${normalizedName}`,
      'https://dashboard.example/payload-hashes.json',
      'https://dashboard.example/inventory-sources.json'
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
      sourceNames: ['event-inspection'],
      context,
      reportActivation: true
    });
    expect((await settled((message) => message.id === 5))?.data).toMatchObject({ changed: true });
    expect(jsonlRequests[1]).toBeUndefined();
    dispatch({
      id: 6,
      operation: 'load-canonical-dashboard',
      sourceUrl: 'https://dashboard.example/payload-hashes.json',
      sourceNames: ['event-inspection'],
      context,
      reportActivation: true
    });
    expect((await settled((message) => message.id === 6))?.data).toMatchObject({ changed: false });
    expect(jsonlRequests).toHaveLength(2);

    globalThis.fetch = /** @type {typeof fetch} */ (async (input) => {
      if (String(input).endsWith('/payload-hashes.json')) return new Response(null, { status: 404 });
      if (String(input).endsWith('/inventory-sources.json')) return new Response(null, { status: 404 });
      return new Response('');
    });
    dispatch({
      id: 7,
      operation: 'load-canonical-dashboard',
      sourceUrl: 'https://dashboard.example/payload-hashes.json',
      sourceNames: ['event-inspection'],
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
        events: {
          source: 'events',
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
