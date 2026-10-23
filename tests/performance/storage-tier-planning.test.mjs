import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createStorageTierPlanner, DAY_MS, STORAGE_TIER_CAPACITIES
} from '../../dashboard/site/src/data/storage/tiering.js';

test('one million ordered Runs fit bounded tier-candidate and retained-heap budgets', (context) => {
  assert.equal(typeof global.gc, 'function', 'Run this qualification with node --expose-gc --test');
  global.gc();
  const baselineHeap = process.memoryUsage().heapUsed;
  const watermark = Date.parse('2026-10-21T12:00:00Z');
  const capacities = STORAGE_TIER_CAPACITIES.postgres;
  const candidateLimit = capacities.hot + capacities.statistical + 1;
  const planner = createStorageTierPlanner({
    backend: 'postgres', namespace: 'million-run-qualification', seed: 'v1', watermark
  });
  let peakRetainedHeap = 0;
  let peakCandidates = 0;
  const startedAt = performance.now();
  for (let index = 0; index < 1_000_000; index += 1) {
    planner.add({
      id: `run:${String(index).padStart(7, '0')}`,
      startedAt: new Date(watermark - (index % 8) * DAY_MS).toISOString(),
      observedAt: '2026-10-21T12:00:00Z',
      conclusion: index % 5 ? 'success' : 'failure',
      detail: `unretained-detail:${index}:${'x'.repeat(1024)}`
    });
    peakCandidates = Math.max(peakCandidates, planner.retainedCandidateCount);
    if ((index + 1) % 100_000 === 0) {
      global.gc();
      peakRetainedHeap = Math.max(peakRetainedHeap, process.memoryUsage().heapUsed - baselineHeap);
    }
  }
  const result = planner.finish();
  global.gc();
  peakRetainedHeap = Math.max(peakRetainedHeap, process.memoryUsage().heapUsed - baselineHeap);
  assert.equal(result.statisticalPopulation, 1_000_000);
  assert.equal(result.hot.length, capacities.hot);
  assert.equal(result.statistical.length, capacities.statistical);
  assert.equal(result.evictionEnabled, false);
  assert.equal(result.weightsValid, false);
  assert.ok(peakCandidates <= candidateLimit, `${peakCandidates} candidates exceeded ${candidateLimit}`);
  assert.ok(peakRetainedHeap <= 32 * 1024 * 1024,
    `Retained heap grew by ${peakRetainedHeap} bytes, exceeding the 32 MiB budget`);
  context.diagnostic(JSON.stringify({
    runs: result.statisticalPopulation,
    durationMs: Math.round(performance.now() - startedAt),
    peakCandidates,
    peakRetainedHeapBytes: peakRetainedHeap
  }));
});
