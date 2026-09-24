// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'vitest';
import { adaptCachedGhAwJsonl } from '../../src/data/adapters/gh-aw-logs.js';
import { CANONICAL_SCHEMA_VERSION } from '../../src/data/model/schema.js';
import { normalize } from '../../src/data/normalize/index.js';
import { DATABASE_NAME, readTransactions } from '../../src/data/storage/indexeddb.js';

beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

it('refreshes subscriptions during ingestion only when explicitly requested', async () => {
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
  const normalized = (/** @type {'runs' | 'records'} */ phase, /** @type {typeof batch} */ phaseBatch) => {
    const records = Object.entries(phaseBatch).flatMap(([collection, values]) =>
      values.map((record) => ({ kind: 'record', collection, record }))
    );
    return [
      {
        kind: 'metadata',
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        ingestionVersion: 3,
        sourceRecords: 1,
        phase,
        records: records.length
      },
      ...records
    ].map((line) => JSON.stringify(line)).join('\n') + '\n';
  };
  const shardStem = `gh-aw-logs-1000-a-${'c'.repeat(64)}-${'d'.repeat(16)}.jsonl`;
  const runsName = `gh-aw-logs-runs/${shardStem}`;
  const recordsName = `gh-aw-logs-records/${shardStem}`;
  /** @type {string[]} */
  const downloadedShards = [];
  let recordsDownloaded = false;
  /** @type {() => void} */
  let releaseEvent = () => {};
  const eventReady = new Promise((resolve) => {
    releaseEvent = () => resolve(undefined);
  });
  globalThis.fetch = /** @type {typeof fetch} */ (async (input, init) => {
    const url = String(input);
    if (url.endsWith('/inventory-sources.json')) return new Response(null, { status: 404 });
    if (url.endsWith('/payload-hashes.json')) {
      return Response.json({ [runsName]: 'a'.repeat(64), [recordsName]: 'b'.repeat(64) });
    }
    if (url.endsWith(`/${runsName}`)) {
      if (init?.method !== 'HEAD') downloadedShards.push(url);
      return init?.method === 'HEAD'
        ? new Response(null, { headers: { 'content-length': '1' } })
        : new Response(normalized('runs', {
            ...batch, domains: [], tools: [], audits: [], issues: [], operationalValues: []
          }));
    }
    if (init?.method !== 'HEAD') downloadedShards.push(url);
    recordsDownloaded ||= init?.method !== 'HEAD';
    if (init?.method !== 'HEAD') await eventReady;
    return init?.method === 'HEAD'
      ? new Response(null, { headers: { 'content-length': '1' } })
      : new Response(normalized('records', {
          campaigns: [], repositories: [], workflows: [], runs: [],
          domains: batch.domains, tools: batch.tools, audits: batch.audits, issues: batch.issues,
          operationalValues: batch.operationalValues
        }));
  });

  const context = {
    pages: [],
    queries: [
      { name: 'run-summary', from: 'runs', select: [{ field: 'run' }] },
      { name: 'audit-summary', from: 'audits', select: [{ field: 'audit' }] }
    ]
  };
  listeners.get('message')?.({
    data: {
      operation: 'subscribe-canonical-dashboard',
      subscriptionId: 'audits',
      sourceNames: ['audit-summary'],
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

  for (let attempt = 0; attempt < 200 && !recordsDownloaded; attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  await new Promise((resolve) => { setTimeout(resolve, 75); });
  expect(posted.some(({ subscriptionId }) => subscriptionId)).toBe(false);
  listeners.get('message')?.({
    data: {
      operation: 'sync-dashboard-queries',
      requestId: 1
    }
  });
  for (let attempt = 0; attempt < 200 && !posted.some(({ subscriptionId }) => subscriptionId === 'runs'); attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  const published = posted.find(({ subscriptionId }) => subscriptionId === 'runs');
  expect(published).toMatchObject({
    data: { 'run-summary': { rows: [{ run: '303' }] } }
  });
  expect(recordsDownloaded).toBe(true);
  expect(posted.some(({ id }) => id === 1)).toBe(false);
  expect(posted.some(({ subscriptionId }) => subscriptionId === 'audits')).toBe(true);
  listeners.get('message')?.({
    data: {
      operation: 'subscribe-canonical-dashboard',
      subscriptionId: 'audits-during-run-phase',
      sourceNames: ['audit-summary'],
      context
    }
  });
  await new Promise((resolve) => { setTimeout(resolve, 75); });
  expect(posted.some(({ subscriptionId }) => subscriptionId === 'audits-during-run-phase')).toBe(true);
  releaseEvent();
  for (let attempt = 0; attempt < 200 && !posted.some(({ id }) => id === 1); attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  expect(posted.find(({ id }) => id === 1)?.error).toBeUndefined();
  for (let attempt = 0; attempt < 200 && !['audits', 'audits-during-run-phase'].every((subscriptionId) =>
    posted.some((message) => message.subscriptionId === subscriptionId)); attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  expect(posted.find(({ subscriptionId }) => subscriptionId === 'audits')).toBeDefined();
  expect(posted.find(({ subscriptionId }) => subscriptionId === 'audits-during-run-phase')).toBeDefined();
  expect((await readTransactions(indexedDB))
    .filter(({ kind }) => kind === 'ingest-normalized-jsonl')
    .map(({ payloadScope, payloadHash }) => ({ payloadScope, payloadHash })))
    .toEqual(expect.arrayContaining([
      {
        payloadScope: `https://dashboard.example/${runsName}`,
        payloadHash: 'a'.repeat(64)
      },
      {
        payloadScope: `https://dashboard.example/${recordsName}`,
        payloadHash: 'b'.repeat(64)
      }
    ]));

  posted.length = 0;
  downloadedShards.length = 0;
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
  expect(downloadedShards).toEqual([]);
}, 15_000);
