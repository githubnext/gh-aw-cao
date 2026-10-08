// @vitest-environment node
import { expect, it } from 'vitest';
import { assertCanonicalCounts, median, performanceFailures } from '../performance/lighthouse-contract.js';

it('uses repeated medians without accepting missing or invalid metrics', () => {
  expect(median([0.8, 1, 0.98])).toBe(0.98);
  expect(median([2, 4])).toBe(3);
  expect(() => median([])).toThrow(/finite/);
  expect(() => median([NaN])).toThrow(/finite/);
  expect(() => performanceFailures(1, {}, 0.88, { cls: 0.1 })).toThrow(/omitted cls/);
});

it('fails on budget breaches rather than lowering thresholds or substituting zero', () => {
  expect(performanceFailures(0.84, { cls: 0.116 }, 0.88, { cls: 0.1 })).toEqual([
    'score 0.84 is below 0.88', 'cls 0.116 exceeds 0.1'
  ]);
  expect(performanceFailures(0.98, { cls: 0.1 }, 0.88, { cls: 0.1 })).toEqual([]);
});

it('requires empty entities or populated evidence with every shard committed', () => {
  expect(() => assertCanonicalCounts('empty', { runs: 0, audits: 0, transactions: 2 }, 2)).not.toThrow();
  expect(() => assertCanonicalCounts('empty', { runs: 1, transactions: 2 }, 2)).toThrow(/contains/);
  expect(() => assertCanonicalCounts('full', { runs: 1, repositories: 1, audits: 1, transactions: 500 }, 500)).not.toThrow();
  expect(() => assertCanonicalCounts('full', { runs: 1, repositories: 1, audits: 1, transactions: 499 }, 500)).toThrow(/completely/);
  expect(() => assertCanonicalCounts('full', { runs: 1, repositories: 1, audits: 1 }, 500)).toThrow(/incomplete/);
});
