import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/data/normalize/order.js';
import {
  DAY_MS, STORAGE_TIER_CAPACITIES, logicalWatermark, metricWeekCutoff, planStorageTiers, storageTierCapacities
} from '../../src/data/storage/tiering.js';
import {
  beginMetricScope, completeMetricScope, createMetricLedger, stageMetricShard
} from '../../src/data/storage/daily-metrics.js';

const WATERMARK = Date.parse('2026-10-21T12:00:00Z');
const NAMESPACE = 'test';

/** @param {string} id @param {Record<string, unknown>} [fields] */
function run(id, fields = {}) {
  return {
    id, repositoryId: 'repo', workflowId: 'workflow',
    startedAt: '2026-10-20T12:00:00Z', observedAt: '2026-10-21T12:00:00Z',
    conclusion: 'success', provenance: { source: 'fixture', sourceId: id },
    ...fields
  };
}

/** @param {Record<string, unknown>[]} runs @param {number} [watermark] */
function scope(runs, watermark = WATERMARK) {
  return stageMetricShard(beginMetricScope({
    id: 'scope', namespace: NAMESPACE, watermark, expectedShards: ['sha256:first']
  }), 'sha256:first', runs);
}

/** @param {Record<string, unknown>[]} runs */
function plan(runs) {
  return planStorageTiers(runs, { backend: 'sqlite', namespace: NAMESPACE, watermark: WATERMARK, seed: 'v1' });
}

describe('non-destructive canonical storage tier planning', () => {
  it('configures hot and statistical capacities independently and rejects invalid overrides', () => {
    expect(storageTierCapacities('postgres', { hot: 17 })).toEqual({ hot: 17, statistical: 64000 });
    expect(storageTierCapacities('indexeddb', { statistical: 19 })).toEqual({ hot: 1000, statistical: 19 });
    expect(storageTierCapacities('sqlite', { hot: 0, statistical: 0 })).toEqual({ hot: 0, statistical: 0 });
    for (const value of [NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => storageTierCapacities('sqlite', { hot: value })).toThrow(/safe integers/);
      expect(() => storageTierCapacities('sqlite', { statistical: value })).toThrow(/safe integers/);
    }
    const result = planStorageTiers([run('one'), run('two'), run('three')], {
      backend: 'sqlite', namespace: NAMESPACE, watermark: WATERMARK, seed: 'v1',
      capacities: { hot: 2, statistical: 1 }
    });
    expect(result.hot).toHaveLength(2);
    expect(result.statistical).toHaveLength(1);
    expect(result.evictionEnabled).toBe(false);
  });

  it('keeps independent backend capacities and never authorizes deletion', () => {
    expect(STORAGE_TIER_CAPACITIES).toEqual({
      postgres: { hot: 16000, statistical: 64000 },
      sqlite: { hot: 2000, statistical: 8000 },
      indexeddb: { hot: 1000, statistical: 16000 }
    });
    expect(Object.values(STORAGE_TIER_CAPACITIES).every((capacity) =>
      Object.values(capacity).every((value) => Number.isSafeInteger(value) && value > 0))).toBe(true);
    expect(Object.isFrozen(STORAGE_TIER_CAPACITIES)).toBe(true);
    expect(Object.values(STORAGE_TIER_CAPACITIES).every(Object.isFrozen)).toBe(true);
    const records = Array.from({ length: 8001 }, (_, index) => run(`run:${index}`));
    const result = plan(records);
    expect(result.hot).toHaveLength(2000);
    expect(result.statistical).toHaveLength(8000);
    expect(result.evictionEnabled).toBe(false);
    expect(result.weightsValid).toBe(false);
    expect(result.weightValidity).toBe('deterministic-priority-only');
    expect(result.statistical.every((row) => row.inverseProbabilityWeight === null
      && row.inclusionProbability === null)).toBe(true);
    expect(plan([...records].reverse())).toEqual(result);
  });

  it('anchors the inclusive seven-day window and hot order to explicit logical time', () => {
    const boundary = new Date(WATERMARK - 7 * DAY_MS).toISOString();
    const result = plan([
      run('boundary', { startedAt: boundary }),
      run('old', { startedAt: new Date(WATERMARK - 7 * DAY_MS - 1).toISOString() }),
      run('future', { startedAt: new Date(WATERMARK + 1).toISOString() }),
      run('now', { startedAt: new Date(WATERMARK).toISOString() })
    ]);
    expect(result.hot).toEqual(['now', 'boundary', 'old']);
    expect(result.statistical.map(({ id }) => id).sort()).toEqual(['boundary', 'now']);
    expect(result.deferredFutureRuns).toBe(1);
    expect(result.weightsValid).toBe(true);
    expect(result.statistical.every(({ inverseProbabilityWeight }) => inverseProbabilityWeight === 1)).toBe(true);
    expect(() => logicalWatermark(undefined)).toThrow(/explicit logical watermark/);
    expect(() => logicalWatermark(NaN)).toThrow();
    expect(() => logicalWatermark(Infinity)).toThrow();
    expect(() => logicalWatermark(-Infinity)).toThrow();
    expect(() => logicalWatermark(1.1)).toThrow();
    expect(() => logicalWatermark(Number.MAX_SAFE_INTEGER)).toThrow();
  });

  it('preserves epoch-zero timestamps rather than treating them as missing or falling back to now', () => {
    const epochRun = run('epoch', {
      startedAt: '1970-01-01T00:00:00Z', observedAt: '1970-01-01T00:00:00Z'
    });
    const result = planStorageTiers([epochRun], {
      backend: 'indexeddb', namespace: NAMESPACE, watermark: 0, seed: 'v1'
    });
    expect(logicalWatermark(0)).toBe(0);
    expect(result.hot).toEqual(['epoch']);
    expect(result.statistical.map(({ id }) => id)).toEqual(['epoch']);
    const ledger = completeMetricScope(createMetricLedger(NAMESPACE, 0), scope([epochRun], 0));
    expect(ledger.watermark).toBe(0);
    expect(Object.values(ledger.dailyMetrics)[0].day).toBe('1970-01-01');
  });

  it('changes priority with outcome without calling selection weights probabilities', () => {
    const success = plan([run('same')]).statistical[0];
    const failure = plan([run('same', { conclusion: 'failure' })]).statistical[0];
    const cancelled = plan([run('same', { conclusion: 'cancelled' })]).statistical[0];
    expect(failure.priority).toBe(success.priority * 4);
    expect(cancelled.priority).toBe(success.priority * 2);
    for (const conclusion of [
      'timed-out', 'startup-failure', 'action-required', 'timed_out', 'startup_failure', 'action_required'
    ]) {
      expect(plan([run('same', { conclusion })]).statistical[0].priority).toBe(success.priority * 4);
    }
  });

  it('resolves duplicate revisions before population counting or tier selection', () => {
    const old = run('same', { conclusion: 'failure', observedAt: '2026-10-20T12:00:00Z' });
    const latest = run('same');
    expect(plan([old, latest])).toEqual(plan([latest, old]));
    expect(plan([old, latest]).statisticalPopulation).toBe(1);
    expect(plan([old, latest]).statistical[0].priorityWeight).toBe(1);
    expect(() => plan([run('bad', { startedAt: null })])).toThrow(/startedAt or completedAt/);
  });

  it('uses UTC Monday boundaries for current and previous two weeks', () => {
    expect(new Date(metricWeekCutoff(WATERMARK)).toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(new Date(metricWeekCutoff(Date.parse('2027-01-03T23:59:59Z'))).toISOString())
      .toBe('2026-12-14T00:00:00.000Z');
    expect(new Date(metricWeekCutoff(Date.parse('2027-01-04T00:00:00Z'))).toISOString())
      .toBe('2026-12-21T00:00:00.000Z');
  });
});

describe('correction-safe daily metric commit candidates', () => {
  it('does not publish incomplete scopes, tolerates exact retries and rejects changed shard content', () => {
    const state = createMetricLedger(NAMESPACE, WATERMARK);
    let staged = beginMetricScope({
      id: 'scope', namespace: NAMESPACE, watermark: WATERMARK, expectedShards: ['first', 'second']
    });
    staged = stageMetricShard(staged, 'first', [run('one')]);
    expect(() => completeMetricScope(state, staged)).toThrow(/incomplete/);
    expect(state.dailyMetrics).toEqual({});
    expect(state.checkpoint).toBeNull();
    expect(stageMetricShard(staged, 'first', [run('one')])).toBe(staged);
    expect(() => stageMetricShard(staged, 'first', [run('different')])).toThrow(/changed content/);
    expect(() => stageMetricShard(staged, 'undeclared', [])).toThrow(/Undeclared/);
    staged = stageMetricShard(staged, 'second', []);
    const committed = completeMetricScope(state, staged);
    expect(Object.values(committed.dailyMetrics)[0].measures.runs).toBe(1);
    expect(completeMetricScope(committed, staged)).toEqual(committed);
  });

  it('subtracts an old contribution before applying corrected day, parents, outcome and measurements', () => {
    const initial = completeMetricScope(createMetricLedger(NAMESPACE, WATERMARK), scope([
      run('one', { inputTokens: 10, outputTokens: 0, aicTotal: null }),
      run('two', { conclusion: 'failure', aicTotal: 2 })
    ]));
    const original = canonicalJson(initial);
    const corrected = completeMetricScope(initial, scope([run('one', {
      repositoryId: 'other-repo', workflowId: 'other-workflow', conclusion: 'failure',
      startedAt: '2026-10-19T01:00:00Z', observedAt: '2026-10-21T13:00:00Z',
      inputTokens: 20, aicTotal: 0
    })]));
    expect(canonicalJson(initial)).toBe(original);
    const metrics = Object.values(corrected.dailyMetrics);
    expect(metrics).toHaveLength(2);
    expect(metrics.find(({ repositoryId }) => repositoryId === 'repo')?.measures).toMatchObject({
      runs: 1, conclusions: { failure: 1 }, inputTokens: { count: 0, sum: 0 },
      aicTotal: { count: 1, sum: 2 }
    });
    expect(metrics.find(({ repositoryId }) => repositoryId === 'other-repo')?.measures).toMatchObject({
      runs: 1, conclusions: { failure: 1 }, inputTokens: { count: 1, sum: 20 },
      aicTotal: { count: 1, sum: 0 }, outputTokens: { count: 0, sum: 0 }
    });
    expect(completeMetricScope(corrected, scope([run('one')]))).toEqual(corrected);
  });

  it('requires complete reconciled snapshots rather than merging partial measurement patches', () => {
    const initial = completeMetricScope(createMetricLedger(NAMESPACE, WATERMARK), scope([
      run('one', { inputTokens: 10 })
    ]));
    const replacement = completeMetricScope(initial, scope([
      run('one', { observedAt: '2026-10-21T13:00:00Z' })
    ]));
    expect(Object.values(replacement.dailyMetrics)[0].measures.inputTokens)
      .toEqual({ count: 0, sum: 0, exactSum: '0' });
  });

  it('is order-independent across shards and uses stable content ordering for equal revision ties', () => {
    const a = run('one', { conclusion: 'failure' });
    const b = run('one', { conclusion: 'success' });
    const base = beginMetricScope({
      id: 'scope', namespace: NAMESPACE, watermark: WATERMARK, expectedShards: ['a', 'b']
    });
    const forward = stageMetricShard(stageMetricShard(base, 'a', [a]), 'b', [b]);
    const reverse = stageMetricShard(stageMetricShard(base, 'b', [b]), 'a', [a]);
    const state = createMetricLedger(NAMESPACE, WATERMARK);
    expect(completeMetricScope(state, forward)).toEqual(completeMetricScope(state, reverse));
    const incremental = completeMetricScope(completeMetricScope(state, scope([b])), scope([a]));
    expect(incremental.dailyMetrics).toEqual(completeMetricScope(state, forward).dailyMetrics);
  });

  it('retains three UTC calendar weeks, not a rolling 21-day interval, and rejects stale resurrection', () => {
    const initial = completeMetricScope(createMetricLedger(NAMESPACE, WATERMARK), scope([
      run('boundary', { startedAt: '2026-10-05T00:00:00Z' }),
      run('expired', { startedAt: '2026-10-04T23:59:59Z' }),
      run('recent')
    ]));
    expect(Object.values(initial.dailyMetrics).map(({ day }) => day).sort()).toEqual(['2026-10-05', '2026-10-20']);
    const outside = run('recent', {
      startedAt: '2026-10-01T00:00:00Z', observedAt: '2026-10-21T13:00:00Z'
    });
    const corrected = completeMetricScope(initial, scope([outside]));
    const replayed = completeMetricScope(corrected, scope([run('recent')]));
    expect(replayed.dailyMetrics).toEqual(corrected.dailyMetrics);
    const nextWeek = Date.parse('2026-10-26T00:00:00Z');
    const rolled = completeMetricScope(replayed, scope([], nextWeek));
    expect(Object.values(rolled.dailyMetrics)).toHaveLength(0);
    expect(rolled.checkpoint?.watermark).toBe(nextWeek);
  });

  it('retains first-seen out-of-window winner precedence against older in-window revisions', () => {
    const state = createMetricLedger(NAMESPACE, WATERMARK);
    const newer = run('same', {
      startedAt: '2026-10-01T00:00:00Z', observedAt: '2026-10-21T13:00:00Z'
    });
    const older = run('same', {
      startedAt: '2026-10-20T00:00:00Z', observedAt: '2026-10-21T12:00:00Z'
    });
    const newerFirst = completeMetricScope(completeMetricScope(state, scope([newer])), scope([older]));
    const olderFirst = completeMetricScope(completeMetricScope(state, scope([older])), scope([newer]));
    const combined = completeMetricScope(state, scope([older, newer]));
    expect(newerFirst.dailyMetrics).toEqual({});
    expect(olderFirst.dailyMetrics).toEqual(newerFirst.dailyMetrics);
    expect(combined.dailyMetrics).toEqual(newerFirst.dailyMetrics);
    expect(olderFirst.contributions).toEqual(newerFirst.contributions);
    expect(combined.contributions).toEqual(newerFirst.contributions);
    expect(Object.values(newerFirst.contributions)[0].retiredAt).toBe(WATERMARK);
    const expired = completeMetricScope(newerFirst, scope([], Date.parse('2026-11-16T00:00:00Z')));
    expect(expired.contributions).toEqual({});
  });

  it('fails closed on backwards time, namespace mismatch, future runs and invalid measures without mutation', () => {
    const state = createMetricLedger(NAMESPACE, WATERMARK);
    expect(() => completeMetricScope(state, scope([], WATERMARK - 1))).toThrow(/backwards/);
    expect(() => completeMetricScope(state, { ...scope([]), namespace: 'other' })).toThrow(/namespace/);
    expect(() => completeMetricScope(state, scope([run('future', {
      startedAt: new Date(WATERMARK + 1).toISOString()
    })]))).toThrow(/future/);
    expect(() => completeMetricScope(state, scope([run('invalid', { inputTokens: NaN })]))).toThrow(/finite/);
    expect(state.dailyMetrics).toEqual({});
    expect(state.checkpoint).toBeNull();
  });

  it('isolates tuple identities and treats missing measurements differently from measured zero', () => {
    const state = completeMetricScope(createMetricLedger(NAMESPACE, WATERMARK), scope([
      run('one', { repositoryId: 'a/b', workflowId: 'c', inputTokens: 0, conclusion: '__proto__' }),
      run('two', { repositoryId: 'a', workflowId: 'b/c', inputTokens: null })
    ]));
    expect(Object.values(state.dailyMetrics)).toHaveLength(2);
    expect(Object.values(state.dailyMetrics).find(({ repositoryId }) => repositoryId === 'a/b')?.measures)
      .toMatchObject({ inputTokens: { count: 1, sum: 0 }, conclusions: { ['__proto__']: 1 } });
    expect(Object.values(state.dailyMetrics).find(({ repositoryId }) => repositoryId === 'a')?.measures)
      .toMatchObject({ inputTokens: { count: 0, sum: 0 } });
  });

  it('keeps decimal sums independent of batch order and subtraction history', () => {
    const state = createMetricLedger(NAMESPACE, WATERMARK);
    const a = run('a', { aicTotal: 0.1 });
    const b = run('b', { aicTotal: 0.2 });
    const combined = completeMetricScope(state, scope([a, b]));
    const incremental = completeMetricScope(completeMetricScope(state, scope([b])), scope([a]));
    expect(combined.dailyMetrics).toEqual(incremental.dailyMetrics);
    expect(Object.values(combined.dailyMetrics)[0].measures.aicTotal)
      .toEqual({ count: 2, sum: 0.3, exactSum: '0.3' });
    const corrected = completeMetricScope(combined, scope([run('a', {
      aicTotal: null, observedAt: '2026-10-21T13:00:00Z'
    })]));
    expect(Object.values(corrected.dailyMetrics)[0].measures.aicTotal)
      .toEqual({ count: 1, sum: 0.2, exactSum: '0.2' });
    const exponents = completeMetricScope(state, scope([
      run('a', { aicTotal: 1e-10 }), run('b', { aicTotal: 1e21 })
    ]));
    expect(Object.values(exponents.dailyMetrics)[0].measures.aicTotal.exactSum)
      .toBe('1000000000000000000000.0000000001');
    const replacement = run('a', { aicTotal: 0.3, observedAt: '2026-10-21T13:00:00Z' });
    const correctedLater = completeMetricScope(combined, scope([replacement]));
    const correctedFirst = completeMetricScope(
      completeMetricScope(completeMetricScope(state, scope([replacement])), scope([b])), scope([a])
    );
    expect(correctedLater.dailyMetrics).toEqual(correctedFirst.dailyMetrics);
    expect(Object.values(correctedLater.dailyMetrics)[0].measures.aicTotal.exactSum).toBe('0.5');
  });

  it('freezes source authority for a ledger instead of inferring it from arrival order', () => {
    const precedence = { official: 2, fallback: 1 };
    const state = createMetricLedger(NAMESPACE, WATERMARK, precedence);
    precedence.fallback = 100;
    const official = run('a', {
      observedAt: '2026-10-20T00:00:00Z',
      provenance: { source: 'official', sourceId: 'one' }, conclusion: 'failure'
    });
    const fallback = run('a', { provenance: { source: 'fallback', sourceId: 'two' } });
    const first = completeMetricScope(completeMetricScope(state, scope([official])), scope([fallback]));
    const second = completeMetricScope(completeMetricScope(state, scope([fallback])), scope([official]));
    expect(first.dailyMetrics).toEqual(second.dailyMetrics);
    expect(Object.values(first.dailyMetrics)[0].measures.conclusions).toEqual({ failure: 1 });
  });
});
