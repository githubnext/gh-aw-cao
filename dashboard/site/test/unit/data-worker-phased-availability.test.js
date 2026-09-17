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
  const normalized = (/** @type {'runs' | 'events'} */ phase, /** @type {typeof batch} */ phaseBatch) => ({
    schemaVersion: 9,
    ingestionVersion: 2,
    sourceRecords: 1,
    phase,
    batch: phaseBatch
  });
  const shardStem = `gh-aw-logs-1000-a-${'c'.repeat(64)}-${'d'.repeat(16)}.json`;
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
        : Response.json(normalized('runs', { ...batch, jobs: [], sessions: [], events: [] }));
    }
    eventDownloaded ||= init?.method !== 'HEAD';
    if (init?.method !== 'HEAD') await eventReady;
    return init?.method === 'HEAD'
      ? new Response(null, { headers: { 'content-length': '1' } })
      : Response.json(normalized('events', {
          packages: [], repositories: [], workflows: [], runs: [],
          jobs: batch.jobs, sessions: batch.sessions, events: batch.events
        }));
  });

  const context = {
    pages: [],
    queries: [
      { name: 'run-summary', from: 'runs', select: [{ field: 'run' }] },
      { name: 'event-summary', from: 'events', select: [{ field: 'event' }] }
    ]
  };
  listeners.get('message')?.({
    data: {
      operation: 'subscribe-canonical-dashboard',
      subscriptionId: 'events',
      sourceNames: ['event-summary'],
      context
    }
  });
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
  expect(posted.some(({ subscriptionId }) => subscriptionId === 'events')).toBe(false);
  listeners.get('message')?.({
    data: {
      operation: 'subscribe-canonical-dashboard',
      subscriptionId: 'events-during-run-phase',
      sourceNames: ['event-summary'],
      context
    }
  });
  await new Promise((resolve) => { setTimeout(resolve, 75); });
  expect(posted.some(({ subscriptionId }) => subscriptionId === 'events-during-run-phase')).toBe(false);
  releaseEvent();
  for (let attempt = 0; attempt < 200 && !posted.some(({ id }) => id === 1); attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  expect(posted.find(({ id }) => id === 1)?.error).toBeUndefined();
  for (let attempt = 0; attempt < 200 && !posted.some(({ subscriptionId }) => subscriptionId === 'events'); attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  expect(posted.find(({ subscriptionId }) => subscriptionId === 'events')).toBeDefined();
  expect(posted.find(({ subscriptionId }) => subscriptionId === 'events-during-run-phase')).toBeDefined();

  posted.length = 0;
  listeners.get('message')?.({
    data: {
      id: 2,
      operation: 'load-canonical-dashboard',
      sourceUrl: 'https://dashboard.example/payload-hashes.json',
      sourceNames: ['run-summary'],
      context
    }
  });
  for (let attempt = 0; attempt < 200 && !posted.some(({ id }) => id === 2); attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  await new Promise((resolve) => { setTimeout(resolve, 75); });
  expect(posted.filter(({ subscriptionId }) => subscriptionId === 'runs')).toHaveLength(1);
});
