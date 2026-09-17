import { describe, expect, it, vi } from 'vitest';
import {
  createDashboardQueryMemoization,
  dashboardQueryMemoizationKey
} from '../../src/data/queries/memoization.js';

describe('dashboard query memoization', () => {
  it('reuses a materialized result within its short lifetime', async () => {
    let now = 100;
    const memoization = createDashboardQueryMemoization({ ttlMs: 50, now: () => now });
    const compute = vi.fn(async () => ({ rows: [{ run: '1' }] }));

    const first = await memoization.get(1, 'overview', compute);
    now = 149;
    const second = await memoization.get(1, 'overview', compute);

    expect(second).toBe(first);
    expect(compute).toHaveBeenCalledOnce();
  });

  it('recomputes expired results', async () => {
    let now = 100;
    const memoization = createDashboardQueryMemoization({ ttlMs: 50, now: () => now });
    const compute = vi.fn(async () => ({ computedAt: now }));

    await memoization.get(1, 'overview', compute);
    now = 150;

    await expect(memoization.get(1, 'overview', compute)).resolves.toEqual({ computedAt: 150 });
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('invalidates every cached query when the database revision changes', async () => {
    const memoization = createDashboardQueryMemoization();
    const compute = vi.fn(async () => ({ sequence: compute.mock.calls.length }));

    await memoization.get(1, 'overview', compute);
    await memoization.get(1, 'repositories', compute);
    await memoization.get(2, 'overview', compute);
    await memoization.get(2, 'repositories', compute);

    expect(compute).toHaveBeenCalledTimes(4);
  });

  it('does not insert an older result after a newer database revision starts', async () => {
    const memoization = createDashboardQueryMemoization();
    /** @type {(value: { revision: number }) => void} */
    let resolveOlder = () => {};
    const older = memoization.get(1, 'overview', () => new Promise((resolve) => {
      resolveOlder = resolve;
    }));

    await memoization.get(2, 'overview', async () => ({ revision: 2 }));
    resolveOlder({ revision: 1 });
    await older;
    const recompute = vi.fn(async () => ({ revision: 2 }));

    await expect(memoization.get(2, 'overview', recompute)).resolves.toEqual({ revision: 2 });
    expect(recompute).not.toHaveBeenCalled();
  });

  it('evicts the least recently used result when bounded capacity is reached', async () => {
    const memoization = createDashboardQueryMemoization({ maxEntries: 2 });
    const compute = vi.fn(async () => compute.mock.calls.length);

    await memoization.get(1, 'overview', compute);
    await memoization.get(1, 'repositories', compute);
    await memoization.get(1, 'overview', compute);
    await memoization.get(1, 'workflows', compute);
    await memoization.get(1, 'repositories', compute);

    expect(compute).toHaveBeenCalledTimes(4);
  });

  it('creates the same key for equivalent requested-source sets', () => {
    const suffix = [{ pages: [] }, {}, undefined];

    expect(dashboardQueryMemoizationKey([['runs', 'workflows'].sort(), ...suffix]))
      .toBe(dashboardQueryMemoizationKey([['workflows', 'runs'].sort(), ...suffix]));
  });
});
