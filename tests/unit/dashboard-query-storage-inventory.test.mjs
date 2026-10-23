import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loadAgentDashboardDocument } from '../../activity/agent-catalog.mjs';
import { queryStorageInventory } from '../../activity/query-storage-inventory.mjs';

test('storage inventory covers every composed dashboard query and preserves semantic metadata', async () => {
  const document = await loadAgentDashboardDocument();
  const inventory = queryStorageInventory(document);
  assert.equal(inventory.queries.length, document.dashboard.queries.length);
  for (const query of document.dashboard.queries) {
    const entry = inventory.queries.find((candidate) => candidate.id === query.name);
    assert.ok(entry);
    for (const field of ['subject', 'objective', 'acceptance']) {
      assert.equal(entry[field], query[field] ?? '');
    }
    assert.equal(entry.migrated, false);
  }
  const generated = JSON.parse(await readFile(
    new URL('../../dashboard/site/src/agent/storage-inventory.generated.json', import.meta.url), 'utf8'));
  assert.deepEqual(generated, inventory);
});

test('inventory traces canonical stores through database projections and dashboard dependencies', () => {
  const inventory = queryStorageInventory({ dashboard: { queries: [
    { name: 'summary', from: 'overview-runs', aggregate: { values: [{ reducer: 'count', as: 'runs' }] } },
    { name: 'derived', from: 'summary' },
    { name: 'details', from: 'overview-runs' }
  ] } });
  const summary = inventory.queries.find((query) => query.id === 'derived');
  assert.ok(summary.stores.includes('runs'));
  assert.ok(summary.stores.includes('workflows'));
  assert.equal(summary.status, 'mixed-layer-review-required');
  assert.equal(inventory.queries.find((query) => query.id === 'details').status, 'remains-detail-based');
});

test('non-additive reducers and unresolved sources never imply an aggregate migration', () => {
  const { queries } = queryStorageInventory({ dashboard: { queries: [
    { name: 'distinct', from: '$runs', aggregate: { values: [{ reducer: 'distinct-count' }] } },
    { name: 'external', from: 'not-a-canonical-source' }
  ] } });
  assert.ok(queries[0].blockers.some((reason) => reason.includes('Non-additive')));
  assert.deepEqual(queries[1]['external-sources'], ['not-a-canonical-source']);
  assert.ok(queries.every((query) => !query.migrated));
});

test('inventory dependency traversal terminates on cycles and is declaration-order independent', () => {
  const definitions = [
    { name: 'a', from: 'b' },
    { name: 'b', from: 'a', joins: [{ source: '$tools', on: [] }] }
  ];
  const forward = queryStorageInventory({ dashboard: { queries: definitions } });
  const reverse = queryStorageInventory({ dashboard: { queries: [...definitions].reverse() } });
  assert.deepEqual(forward, reverse);
  assert.ok(forward.queries.every((query) => query.stores.includes('tools')));
});
