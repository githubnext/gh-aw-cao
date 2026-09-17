// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'vitest';
import { adaptCachedGhAwJsonl } from '../../src/data/adapters/gh-aw-logs.js';
import { normalize } from '../../src/data/normalize/index.js';
import { DATABASE_NAME } from '../../src/data/storage/indexeddb.js';

beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

it('publishes run queries while event ingestion continues', async () => {
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

  const batch = normalize(adaptCachedGhAwJsonl(`${JSON.stringify({
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
  })}\n`).observations);
  const normalized = (/** @type {typeof batch} */ phaseBatch) => ({
    schemaVersion: 9,
    ingestionVersion: 2,
    sourceRecords: 1,
    batch: phaseBatch
  });
  const shardStem = `${'c'.repeat(64)}-${'d'.repeat(16)}.json`;
  const runsName = `gh-aw-logs-runs/${shardStem}`;
  const eventsName = `gh-aw-logs-events/${shardStem}`;
  let eventDownloaded = false;
  /** @type {() => void} */
  let releaseEvent = () => {};
  const eventReady = new Promise((resolve) => {
    releaseEvent = () => resolve(undefined);
  });
  globalThis.fetch = /** @type {typeof fetch} */ (async (input, init) => {
    const url = String(input);
    if (url.endsWith('/inventory-sources.json')) return new Response(null, { status: 404 });
    if (url.endsWith('/payload-hashes.json')) {
      return Response.json({ [runsName]: 'a'.repeat(64), [eventsName]: 'b'.repeat(64) });
    }
    if (url.endsWith(`/${runsName}`)) {
      return init?.method === 'HEAD'
        ? new Response(null, { headers: { 'content-length': '1' } })
        : Response.json(normalized({ ...batch, jobs: [], sessions: [], events: [] }));
    }
    eventDownloaded ||= init?.method !== 'HEAD';
    if (init?.method !== 'HEAD') await eventReady;
    return init?.method === 'HEAD'
      ? new Response(null, { headers: { 'content-length': '1' } })
      : Response.json(normalized({
          packages: [], repositories: [], workflows: [], runs: [],
          jobs: batch.jobs, sessions: batch.sessions, events: batch.events
        }));
  });

  const context = {
    pages: [],
    queries: [{ name: 'run-summary', from: 'runs', select: [{ field: 'run' }] }]
  };
  listeners.get('message')?.({
    data: {
      operation: 'subscribe-canonical-dashboard',
      subscriptionId: 'runs',
      sourceNames: ['run-summary'],
      context
    }
  });
  listeners.get('message')?.({
    data: {
      id: 1,
      operation: 'load-canonical-dashboard',
      sourceUrl: 'https://dashboard.example/payload-hashes.json',
      sourceNames: ['run-summary'],
      context
    }
  });

  for (let attempt = 0; attempt < 200 && !posted.some(({ subscriptionId }) => subscriptionId === 'runs'); attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  const published = posted.find(({ subscriptionId }) => subscriptionId === 'runs');
  expect(published).toMatchObject({
    data: { 'run-summary': { rows: [{ run: '303' }] } }
  });
  expect(eventDownloaded).toBe(true);
  expect(posted.some(({ id }) => id === 1)).toBe(false);
  releaseEvent();
  for (let attempt = 0; attempt < 200 && !posted.some(({ id }) => id === 1); attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  expect(posted.find(({ id }) => id === 1)?.error).toBeUndefined();
});
