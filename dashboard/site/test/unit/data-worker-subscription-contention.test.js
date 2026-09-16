// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { DATABASE_NAME } from '../../src/data/storage/indexeddb.js';

afterEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

it('defers and coalesces subscription queries while ingestion owns the database', async () => {
  /** @type {Map<string, (event: { data: Record<string, unknown> }) => void>} */
  const listeners = new Map();
  /** @type {Record<string, unknown>[]} */
  const posted = [];
  globalThis.self = /** @type {typeof globalThis.self} */ (/** @type {unknown} */ ({
    addEventListener: (/** @type {string} */ type, /** @type {(event: { data: Record<string, unknown> }) => void} */ listener) => {
      listeners.set(type, listener);
    },
    postMessage: (/** @type {Record<string, unknown>} */ message) => posted.push(structuredClone(message))
  }));
  await import(`../../src/data-worker.js?subscription-contention=${Date.now()}`);
  const dispatch = (data) => listeners.get('message')?.({ data });
  const waitForMessage = (predicate) => new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const message = posted.find(predicate);
      if (message) resolve(message);
      else if (Date.now() - started > 5_000) reject(new Error('Timed out waiting for worker response.'));
      else setTimeout(poll, 5);
    };
    poll();
  });

  dispatch({
    id: 1,
    operation: 'query-canonical-dashboard',
    sourceNames: [],
    context: { pages: [], queries: [] }
  });
  await waitForMessage((message) => message.id === 1);

  /** @type {() => void} */
  let releaseShard = () => {};
  const shardAllowed = new Promise((resolve) => {
    releaseShard = resolve;
  });
  /** @type {() => void} */
  let markShardRequested = () => {};
  const shardRequested = new Promise((resolve) => {
    markShardRequested = resolve;
  });
  globalThis.fetch = /** @type {typeof fetch} */ (async (input, init) => {
    const url = String(input);
    if (url.endsWith('/payload-hashes.json')) {
      return Response.json({ 'gh-aw-logs-shards/logs-1.jsonl': 'a'.repeat(64) });
    }
    if (url.endsWith('/inventory-sources.json')) {
      return Response.json({
        repositories: {
          rows: [{ organization: 'githubnext', repository: 'gh-aw-cao' }],
          metadata: { 'as-of': '2026-09-16T22:00:00Z' }
        }
      });
    }
    if (init?.method === 'HEAD') return new Response(null, { headers: { 'content-length': '512' } });
    markShardRequested();
    await shardAllowed;
    return new Response(`${JSON.stringify({
      schema_version: 2,
      kind: 'run',
      run: {
        run_id: 202,
        run_attempt: 1,
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        workflow_name: 'Dashboard',
        workflow_path: '.github/workflows/dashboard.md',
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-09-16T22:00:00Z'
      }
    })}\n`);
  });

  dispatch({
    id: 2,
    operation: 'load-canonical-dashboard',
    sourceUrl: 'https://dashboard.example/payload-hashes.json',
    sourceNames: [],
    context: { pages: [], queries: [] }
  });
  await shardRequested;
  dispatch({
    operation: 'subscribe-canonical-dashboard',
    subscriptionId: 'active-page',
    sourceNames: ['runs'],
    context: { pages: [], queries: [] }
  });
  dispatch({
    operation: 'unsubscribe-canonical-dashboard',
    subscriptionId: 'active-page'
  });
  dispatch({
    operation: 'subscribe-canonical-dashboard',
    subscriptionId: 'active-page',
    sourceNames: ['runs'],
    context: { pages: [], queries: [] }
  });

  await new Promise((resolve) => setTimeout(resolve, 75));
  expect(posted.some((message) => message.subscriptionId === 'active-page')).toBe(false);

  releaseShard();
  await waitForMessage((message) => message.id === 2);
  const subscription = await waitForMessage((message) => message.subscriptionId === 'active-page');
  expect(subscription.data).toMatchObject({
    runs: { rows: [expect.objectContaining({ run: '202' })] }
  });
  expect(posted.filter((message) => message.subscriptionId === 'active-page')).toHaveLength(1);
}, 10_000);
