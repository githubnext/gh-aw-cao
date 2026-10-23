import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '../../src/data/normalize/order.js';
import {
  beginMetricScope, COMPACT_METRIC_PRECEDENCE, completeCompactMetricScope,
  completeMetricScope, createCompactMetricLedger, createMetricLedger,
  MetricLedgerReplayRequiredError, stageMetricShard
} from '../../src/data/storage/daily-metrics.js';

const WATERMARK = Date.parse('2026-10-21T12:00:00Z');
const NAMESPACE = 'compact-test';

/** @param {string} id @param {Record<string, unknown>} [fields] */
function run(id, fields = {}) {
  return {
    id, repositoryId: 'repo', workflowId: 'workflow', conclusion: 'success',
    startedAt: '2026-10-20T12:00:00Z', observedAt: '2026-10-21T12:00:00Z',
    provenance: { source: 'fixture', sourceId: id }, ...fields
  };
}

/** @param {Record<string, unknown>[]} records @param {number} [watermark] */
function scope(records, watermark = WATERMARK) {
  return stageMetricShard(beginMetricScope({
    id: 'scope', namespace: NAMESPACE, watermark, expectedShards: ['first']
  }), 'first', records);
}

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

describe('compact correction-safe metric ledgers', () => {
  it('persists only bounded revision identity and metric facts, never full Run content', async () => {
    const record = run('one', {
      title: 'detail-must-not-survive', rawArtifact: 'large-payload'.repeat(10_000),
      inputTokens: 10, outputTokens: 0, aicTotal: 0.1,
      unicode: { '\ud83d\ude00': '\ud800', '<&>': '\u2028' }
    });
    const staged = scope([record]);
    const committed = await completeCompactMetricScope(createCompactMetricLedger(NAMESPACE, WATERMARK), staged);
    const contribution = Object.values(committed.contributions)[0];
    const digest = createHash('sha256')
      .update(`cao.metric-revision.${COMPACT_METRIC_PRECEDENCE}\n${canonicalJson(record)}`).digest('hex');
    expect(contribution.precedence.content).toBe(`sha256:${digest}`);
    expect(committed.precedenceFormat).toBe(COMPACT_METRIC_PRECEDENCE);
    expect(JSON.stringify(committed)).not.toContain('detail-must-not-survive');
    expect(JSON.stringify(committed)).not.toContain('large-payload');
    expect(JSON.stringify(committed).length).toBeLessThan(2500);
    expect(committed.dailyMetrics).toEqual(
      completeMetricScope(createMetricLedger(NAMESPACE, WATERMARK), staged).dailyMetrics);
    expect(await completeCompactMetricScope(committed, staged)).toEqual(committed);
    expect(await completeCompactMetricScope(JSON.parse(JSON.stringify(committed)), staged)).toEqual(committed);
    expect(() => completeMetricScope(committed, staged)).toThrow(/compact reducer/);
  });

  it('preserves authority, correction subtraction, partition moves and unknown measurement counts', async () => {
    const state = createCompactMetricLedger(NAMESPACE, WATERMARK, { official: 2, fallback: 1 });
    const official = run('one', { inputTokens: 10, aicTotal: 0.1, provenance: { source: 'official', sourceId: 'one' } });
    const initial = await completeCompactMetricScope(state, scope([official, run('two', { aicTotal: 0.2 })]));
    const correction = run('one', {
      inputTokens: null, outputTokens: 0, aicTotal: 0.3, conclusion: 'failure',
      repositoryId: 'other', workflowId: 'other-workflow', startedAt: '2026-10-19T00:00:00Z',
      observedAt: '2026-10-21T13:00:00Z', provenance: { source: 'official', sourceId: 'one' }
    });
    const original = canonicalJson(initial);
    const corrected = await completeCompactMetricScope(initial, scope([correction]));
    const replayed = await completeCompactMetricScope(state, scope([
      run('two', { aicTotal: 0.2 }), official, correction
    ]));
    expect(corrected.dailyMetrics).toEqual(replayed.dailyMetrics);
    expect(corrected.contributions).toEqual(replayed.contributions);
    expect(Object.values(corrected.dailyMetrics).find(({ repositoryId }) => repositoryId === 'other')?.measures)
      .toMatchObject({ inputTokens: { count: 0, sum: 0 }, outputTokens: { count: 1, sum: 0 } });
    const fallback = run('one', {
      inputTokens: 999, observedAt: '2026-10-21T14:00:00Z',
      provenance: { source: 'fallback', sourceId: 'one' }
    });
    expect(await completeCompactMetricScope(corrected, scope([fallback]))).toEqual(corrected);
    expect(canonicalJson(initial)).toBe(original);
  });

  it('requires replay instead of treating hash order as authority when the old tied snapshot is absent', async () => {
    const state = createCompactMetricLedger(NAMESPACE, WATERMARK);
    const before = run('one', { conclusion: 'failure' });
    const after = run('one', { conclusion: 'success' });
    const initial = await completeCompactMetricScope(state, scope([before]));
    const original = canonicalJson(initial);
    await expect(completeCompactMetricScope(initial, scope([after]))).rejects.toBeInstanceOf(MetricLedgerReplayRequiredError);
    expect(canonicalJson(initial)).toBe(original);
    const replayed = await completeCompactMetricScope(initial, scope([before, after]));
    const fresh = await completeCompactMetricScope(state, scope([after, before]));
    const prototype = completeMetricScope(createMetricLedger(NAMESPACE, WATERMARK), scope([before, after]));
    expect(replayed).toEqual(fresh);
    expect(replayed.dailyMetrics).toEqual(prototype.dailyMetrics);
    expect(await completeCompactMetricScope(replayed, scope([after, before]))).toEqual(replayed);
  });

  it('ignores JSON property order and resolves complete-scope content ties across shard order', async () => {
    const a = run('one', { conclusion: 'failure', details: { a: 1, b: 2 } });
    const b = run('one', { conclusion: 'success', details: { b: 2, a: 1 } });
    const base = beginMetricScope({
      id: 'scope', namespace: NAMESPACE, watermark: WATERMARK, expectedShards: ['a', 'b']
    });
    const forward = stageMetricShard(stageMetricShard(base, 'a', [a]), 'b', [b]);
    const reverse = stageMetricShard(stageMetricShard(base, 'b', [b]), 'a', [a]);
    const state = createCompactMetricLedger(NAMESPACE, WATERMARK);
    expect(await completeCompactMetricScope(state, forward)).toEqual(await completeCompactMetricScope(state, reverse));
    const reordered = {
      ...b,
      details: { a: 1, b: 2 }
    };
    const first = await completeCompactMetricScope(state, scope([b]));
    expect(await completeCompactMetricScope(first, scope([reordered]))).toEqual(first);
  });

  it('does not substitute digest order for canonical content order across replay permutations', async () => {
    const revisions = Array.from({ length: 16 }, (_, index) => run('one', {
      aicTotal: index / 10, detail: `revision-${index}`
    }));
    const prototype = completeMetricScope(createMetricLedger(NAMESPACE, WATERMARK), scope(revisions));
    const state = createCompactMetricLedger(NAMESPACE, WATERMARK);
    const initial = await completeCompactMetricScope(state, scope([revisions[3]]));
    const replayed = await completeCompactMetricScope(initial, scope([...revisions].reverse()));
    expect(replayed.dailyMetrics).toEqual(prototype.dailyMetrics);
    expect(await completeCompactMetricScope(state, scope(revisions))).toEqual(replayed);
  });

  it('accepts an explicit epoch-zero watermark and observation timestamp', async () => {
    const staged = scope([run('epoch', { startedAt: '1970-01-01T00:00:00Z', observedAt: '1970-01-01T00:00:00Z' })], 0);
    const result = await completeCompactMetricScope(createCompactMetricLedger(NAMESPACE, 0), staged);
    expect(result.watermark).toBe(0);
    expect(Object.values(result.contributions)[0].precedence.observedAt).toBe(0);
    expect(Object.values(result.dailyMetrics)[0].day).toBe('1970-01-01');
  });

  it('keeps bounded tombstones without Run details and blocks stale resurrection until expiry', async () => {
    const record = run('one', { title: 'never-in-a-tombstone', aicTotal: 5 });
    const initial = await completeCompactMetricScope(createCompactMetricLedger(NAMESPACE, WATERMARK), scope([record]));
    const retired = await completeCompactMetricScope(initial, scope([run('one', {
      startedAt: '2026-10-01T00:00:00Z', observedAt: '2026-10-21T13:00:00Z', title: 'never-in-a-tombstone'
    })]));
    expect(retired.dailyMetrics).toEqual({});
    expect(Object.values(retired.contributions)[0].retiredAt).toBe(WATERMARK);
    expect(JSON.stringify(retired)).not.toContain('never-in-a-tombstone');
    expect(await completeCompactMetricScope(retired, scope([record]))).toEqual(retired);
    const expired = await completeCompactMetricScope(retired, scope([], Date.parse('2026-11-16T00:00:00Z')));
    expect(expired.contributions).toEqual({});
  });

  it('snapshots caller-owned ledger and staged records before awaiting cryptographic digests', async () => {
    const state = createCompactMetricLedger(NAMESPACE, WATERMARK);
    const staged = scope([run('one', { inputTokens: 10 })]);
    const expected = await completeCompactMetricScope(state, staged);
    const pending = completeCompactMetricScope(state, staged);
    state.namespace = 'mutated';
    staged.shards[canonicalJson(['first'])][0].inputTokens = 999;
    expect(await pending).toEqual(expected);
  });

  it('fails closed on unavailable cryptography, digest collisions, invalid formats and oversized authority metadata', async () => {
    const state = createCompactMetricLedger(NAMESPACE, WATERMARK);
    vi.stubGlobal('crypto', undefined);
    await expect(completeCompactMetricScope(state, scope([run('one')]))).rejects.toThrow(/Web Crypto/);
    vi.stubGlobal('crypto', { subtle: { digest: async () => new ArrayBuffer(32) } });
    await expect(completeCompactMetricScope(state, scope([run('one'), run('two')]))).rejects.toThrow(/collision/);
    vi.stubGlobal('crypto', webcrypto);
    const unsupported = JSON.parse(JSON.stringify(state));
    unsupported.precedenceFormat = 'unknown';
    await expect(completeCompactMetricScope(unsupported, scope([])))
      .rejects.toThrow(/Unsupported compact/);
    unsupported.precedenceFormat = COMPACT_METRIC_PRECEDENCE;
    unsupported.version = 2;
    await expect(completeCompactMetricScope(unsupported, scope([]))).rejects.toThrow(/Unsupported compact/);
    await expect(completeCompactMetricScope(JSON.parse(JSON.stringify(createMetricLedger(NAMESPACE, WATERMARK))), scope([])))
      .rejects.toThrow(/Unsupported compact/);
    const restored = await completeCompactMetricScope(state, scope([run('one')]));
    Object.values(restored.contributions)[0].precedence.content = 'full raw Run content';
    await expect(completeCompactMetricScope(restored, scope([]))).rejects.toThrow(/SHA-256/);
    await expect(completeCompactMetricScope(state, scope([run('one', {
      provenance: { source: 'a'.repeat(257), sourceId: 'one' }
    })]))).rejects.toThrow(/bounded source/);
    await expect(completeCompactMetricScope(state, scope([run('one', {
      provenance: { source: 'fixture', sourceId: 'b'.repeat(2049) }
    })]))).rejects.toThrow(/bounded source/);
    expect(state.contributions).toEqual({});
    expect(state.checkpoint).toBeNull();
  });

  it('subtracts all superseded values before additions and rejects true final overflow atomically', async () => {
    const initial = await completeCompactMetricScope(createCompactMetricLedger(NAMESPACE, WATERMARK), scope([
      run('a', { aicTotal: 0, inputTokens: 0, outputTokens: 0 }),
      run('b', { aicTotal: Number.MAX_VALUE, inputTokens: Number.MAX_VALUE, outputTokens: Number.MAX_VALUE })
    ]));
    const original = canonicalJson(initial);
    const corrections = scope([
      run('a', {
        aicTotal: Number.MAX_VALUE, inputTokens: Number.MAX_VALUE, outputTokens: Number.MAX_VALUE,
        observedAt: '2026-10-21T13:00:00Z'
      }),
      run('b', { aicTotal: 0, inputTokens: 0, outputTokens: 0, observedAt: '2026-10-21T13:00:00Z' })
    ]);
    const corrected = await completeCompactMetricScope(initial, corrections);
    expect(corrected.dailyMetrics).toEqual(
      (await completeCompactMetricScope(createCompactMetricLedger(NAMESPACE, WATERMARK), corrections)).dailyMetrics);
    for (const field of /** @type {const} */ (['aicTotal', 'inputTokens', 'outputTokens'])) {
      expect(Object.values(corrected.dailyMetrics)[0].measures[field]).toMatchObject({ count: 2, sum: Number.MAX_VALUE });
    }
    await expect(completeCompactMetricScope(initial, scope([
      run('c', { aicTotal: Number.MAX_VALUE })
    ]))).rejects.toThrow(/overflow/);
    expect(canonicalJson(initial)).toBe(original);
  });

  it('preserves exact decimal accumulation and source metadata ordering', async () => {
    const state = createCompactMetricLedger(NAMESPACE, WATERMARK);
    const a = run('one', { aicTotal: 0.1 });
    const b = run('two', { aicTotal: 0.2 });
    const combined = await completeCompactMetricScope(state, scope([a, b]));
    const incremental = await completeCompactMetricScope(await completeCompactMetricScope(state, scope([b])), scope([a]));
    expect(combined.dailyMetrics).toEqual(incremental.dailyMetrics);
    expect(Object.values(combined.dailyMetrics)[0].measures.aicTotal).toEqual({ count: 2, sum: 0.3, exactSum: '0.3' });
    const sourceWinner = run('one', {
      conclusion: 'failure', provenance: { source: 'z', sourceId: 'a' }
    });
    const sourceIdWinner = run('one', {
      conclusion: 'cancelled', provenance: { source: 'z', sourceId: 'z' }
    });
    const corrected = await completeCompactMetricScope(combined, scope([sourceWinner]));
    const final = await completeCompactMetricScope(corrected, scope([sourceIdWinner]));
    const prototype = completeMetricScope(createMetricLedger(NAMESPACE, WATERMARK), scope([a, b, sourceWinner, sourceIdWinner]));
    expect(final.dailyMetrics).toEqual(prototype.dailyMetrics);
  });

  it('rejects invalid authority, timestamps, namespaces, future events and measurements without advancing state', async () => {
    const state = createCompactMetricLedger(NAMESPACE, WATERMARK);
    const original = canonicalJson(state);
    await expect(completeCompactMetricScope(state, scope([], WATERMARK - 1))).rejects.toThrow(/backwards/);
    await expect(completeCompactMetricScope(state, { ...scope([]), namespace: 'other' })).rejects.toThrow(/namespace/);
    for (const fields of [
      { startedAt: new Date(WATERMARK + 1).toISOString() },
      { observedAt: 'invalid' },
      { inputTokens: -1 },
      { aicTotal: Number.POSITIVE_INFINITY }
    ]) {
      await expect(completeCompactMetricScope(state, scope([run('invalid', fields)]))).rejects.toThrow();
    }
    vi.stubGlobal('crypto', { subtle: { digest: async () => { throw new Error('digest failure'); } } });
    await expect(completeCompactMetricScope(state, scope([run('one')]))).rejects.toThrow('digest failure');
    vi.stubGlobal('crypto', { subtle: { digest: async () => new ArrayBuffer(16) } });
    await expect(completeCompactMetricScope(state, scope([run('one')]))).rejects.toThrow(/256-bit/);
    expect(canonicalJson(state)).toBe(original);
  });

  it('rejects restored incomplete or oversized scopes before invoking Web Crypto', async () => {
    const state = createCompactMetricLedger(NAMESPACE, WATERMARK);
    const digest = vi.fn(async () => new ArrayBuffer(32));
    vi.stubGlobal('crypto', { subtle: { digest } });
    const empty = beginMetricScope({
      id: 'scope', namespace: NAMESPACE, watermark: WATERMARK, expectedShards: ['first']
    });
    await expect(completeCompactMetricScope(state, empty)).rejects.toThrow(/incomplete/);
    await expect(completeCompactMetricScope(state, { ...empty, expectedShards: [] })).rejects.toThrow(/at least one/);
    await expect(completeCompactMetricScope(state, {
      ...empty, shards: { [canonicalJson(['first'])]: Array.from({ length: 1001 }, () => run('one')) }
    })).rejects.toThrow(/bounded run count/);
    await expect(completeCompactMetricScope(state, {
      ...scope([]), shards: { [canonicalJson(['first'])]: [], unexpected: [] }
    })).rejects.toThrow(/Undeclared/);
    const keys = Array.from({ length: 101 }, (_, index) => `shard-${index}`);
    const records = Array.from({ length: 1000 }, () => run('one'));
    await expect(completeCompactMetricScope(state, {
      ...empty, expectedShards: keys,
      shards: Object.fromEntries(keys.map((key) => [canonicalJson([key]), records]))
    })).rejects.toThrow(/scope exceeds bounded/);
    expect(digest).not.toHaveBeenCalled();
  });
});
