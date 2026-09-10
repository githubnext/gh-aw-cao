// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DATABASE_NAME } from '../../src/data/storage/indexeddb.js';

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
        posted.push(message);
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
    expect(published).toMatchObject({ subscriptionId: 'events', generation: 'generation-a' });

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
    const republished = await settled((message) =>
      message.subscriptionId === 'events' && message.generation === 'generation-b');
    const rows = /** @type {{ data: Record<string, { rows: Record<string, unknown>[] }> }} */ (republished)
      .data['event-inspection'].rows;

    expect(rows.map((row) => row.event)).toEqual(['event:agent-turn', 'event:tool-call']);
  });
});
