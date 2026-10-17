import { describe, expect, it } from 'vitest';
import { computeValue, tidy } from '../../src/data-operations.js';

describe('routing query statistics', () => {
  it('interpolates continuous quantiles and ignores unknown values', () => {
    const [result] = tidy([{ x: 0 }, { x: 10 }, { x: null }, { x: 20 }, { x: 30 }], [{
      op: 'summarize', values: /** @type {const} */ (['median', 'p75', 'p90', 'p95']).map((reducer) => ({ field: 'x', as: reducer, reducer }))
    }]);
    expect(result).toMatchObject({ median: 15, p75: 22.5, p90: 27 });
    expect(result.p95).toBeCloseTo(28.5);
    expect(tidy([{ x: null }], [{ op: 'summarize', values: [{ field: 'x', as: 'median', reducer: 'median' }] }]))
      .toEqual([{ median: null }]);
  });

  it('preserves scalar predecessors and one-based positions without reordering rows', () => {
    expect(tidy([{ x: 'b', t: 2, g: 'a' }, { x: 'z', t: 0, g: 'b' }, { x: 'a', t: 1, g: 'a' }], [{
      op: 'window', values: [
        { operation: 'previous', field: 'x', as: 'prior', groupby: ['g'], 'order-by': [{ field: 't' }] },
        { operation: 'row-number', field: 'x', as: 'position', groupby: ['g'], 'order-by': [{ field: 't' }] }
      ]
    }])).toMatchObject([{ prior: 'a', position: 2 }, { prior: null, position: 1 }, { prior: null, position: 1 }]);
  });

  it('bounds ISO conversion consistently with hosted SQL and keeps invalid square roots unknown', () => {
    for (const value of [-62135596800000, -1, 0, 1792166400123, 253402300799999]) {
      expect(computeValue({}, { as: 'date', function: 'iso-timestamp', args: [{ value }] })).toBe(new Date(value).toISOString());
    }
    for (const value of [-62135596800001, 253402300800000, null, 'bad']) {
      expect(computeValue({}, { as: 'date', function: 'iso-timestamp', args: [{ value }] })).toBeNull();
    }
    expect(computeValue({}, { as: 'root', function: 'sqrt', args: [{ value: 4 }] })).toBe(2);
    expect(computeValue({}, { as: 'root', function: 'sqrt', args: [{ value: -1 }] })).toBeNull();
  });
});
