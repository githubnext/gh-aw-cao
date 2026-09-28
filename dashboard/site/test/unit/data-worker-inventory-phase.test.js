// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'vitest';
import { adaptCachedGhAwJsonl } from '../../src/data/adapters/gh-aw-logs.js';
import { CANONICAL_SCHEMA_VERSION } from '../../src/data/model/schema.js';
import { normalize } from '../../src/data/normalize/index.js';
import { DATABASE_NAME } from '../../src/data/storage/indexeddb.js';

/** @param {() => boolean} ready */
async function waitFor(ready) {
  for (let attempt = 0; attempt < 400 && !ready(); attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  return ready();
}

beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

it('publishes inventory-only sources before historical shards finish ingesting', async () => {
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
      run_id: 404,
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
  const emptyBatch = /** @type {typeof batch} */ (/** @type {unknown} */ (
    Object.fromEntries(Object.keys(batch).map((collection) => [collection, []]))
  ));
  const shardStem = `gh-aw-logs-2000-a-${'c'.repeat(64)}-${'d'.repeat(16)}.jsonl`;
  const runsName = `gh-aw-logs-runs/${shardStem}`;
  const recordsName = `gh-aw-logs-records/${shardStem}`;
  const inventory = {
    'marketplace-packages': {
      rows: [{
        id: 'marketplace:package:githubnext/gh-aw-cao:self-care',
        'registry-id': 'githubnext/gh-aw-cao',
        'registry-name': 'Central Agentic Ops',
        'registry-precedence': 1,
        name: 'Self Care',
        repository: 'githubnext/gh-aw-cao',
        ref: 'main',
        'resolved-commit': 'e'.repeat(40),
        source: 'githubnext/gh-aw-cao/self-care@main',
        'add-command': 'gh aw add githubnext/gh-aw-cao/self-care',
        'observed-at': '2026-09-09T05:00:00Z'
      }],
      metadata: { 'as-of': '2026-09-09T05:00:00Z' }
    }
  };
  /** @type {() => void} */
  let releaseShards = () => {};
  const shardsReady = new Promise((resolve) => {
    releaseShards = () => resolve(undefined);
  });
  globalThis.fetch = /** @type {typeof fetch} */ (async (input, init) => {
    const url = String(input);
    if (url.endsWith('/inventory-sources.json')) return Response.json(inventory);
    if (url.endsWith('/payload-hashes.json')) {
      return Response.json({ [runsName]: 'a'.repeat(64), [recordsName]: 'b'.repeat(64) });
    }
    if (init?.method === 'HEAD') return new Response(null, { headers: { 'content-length': '1' } });
    // Every activity shard stays pending so the assertions below can only pass
    // when inventory publication does not wait for historical ingestion.
    await shardsReady;
    return new Response(url.endsWith(`/${runsName}`)
      ? normalized('runs', ({
        ...emptyBatch,
        campaigns: batch.campaigns,
        repositories: batch.repositories,
        workflows: batch.workflows,
        runs: batch.runs
      }))
      : normalized('records', emptyBatch));
  });

  const context = {
    pages: [],
    queries: [
      {
        name: 'marketplace-package-summary',
        from: 'marketplace-packages',
        select: [{ field: 'id' }, { field: 'package-name' }]
      },
      { name: 'run-summary', from: 'runs', select: [{ field: 'run' }] }
    ]
  };
  listeners.get('message')?.({
    data: {
      operation: 'subscribe-canonical-dashboard',
      subscriptionId: 'marketplace',
      sourceNames: ['marketplace-package-summary'],
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
      sourceNames: ['marketplace-package-summary'],
      context
    }
  });

  const marketplacePublished = () => posted.some(({ subscriptionId, data }) =>
    subscriptionId === 'marketplace'
    && /** @type {{ 'marketplace-package-summary'?: { rows?: unknown[] } }} */ (data)?.['marketplace-package-summary']?.rows?.length === 1);
  expect(await waitFor(marketplacePublished)).toBe(true);
  expect(posted.find(({ subscriptionId }) => subscriptionId === 'marketplace')).toMatchObject({
    data: {
      'marketplace-package-summary': {
        rows: [{ id: 'marketplace:package:githubnext/gh-aw-cao:self-care', 'package-name': 'Self Care' }]
      }
    }
  });
  // Run-dependent subscriptions must not be published from an inventory-only
  // commit, because their shards have not been ingested yet.
  expect(posted.some(({ subscriptionId }) => subscriptionId === 'runs')).toBe(false);
  expect(posted.some(({ id }) => id === 1)).toBe(false);

  releaseShards();
  await waitFor(() => posted.some(({ id }) => id === 1));
  expect(posted.find(({ id }) => id === 1)?.error).toBeUndefined();
  await waitFor(() => posted.some(({ subscriptionId }) => subscriptionId === 'runs'));
  expect(posted.find(({ subscriptionId }) => subscriptionId === 'runs')).toMatchObject({
    data: { 'run-summary': { rows: [{ run: '404' }] } }
  });
}, 30_000);
