import { describe, expect, it, vi } from 'vitest';
import {
  logTableCapacityDecision,
  tableRowLimitForEnvironment
} from '../../src/data/table-capacity.js';

describe('adaptive table capacity', () => {
  it.each([
    [{ mobile: true, deviceMemory: 16 }, 10000],
    [{ deviceMemory: 2 }, 10000],
    [{ deviceMemory: 4 }, 25000],
    [{ deviceMemory: 8 }, 50000],
    [{ deviceMemory: 16 }, 100000],
    [{ heapSizeLimit: 1024 ** 3 }, 10000],
    [{ hardwareConcurrency: 4 }, 25000],
    [{ hardwareConcurrency: 8 }, 50000]
  ])('selects a bounded row limit for %j', (environment, expected) => {
    expect(tableRowLimitForEnvironment(environment)).toBe(expected);
  });

  it('uses the most conservative available memory signal', () => {
    expect(tableRowLimitForEnvironment({
      deviceMemory: 16,
      heapSizeLimit: 2 * (1024 ** 3)
    })).toBe(25000);
  });

  it('does not write the table capacity decision directly to the console', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      logTableCapacityDecision({
        rowLimit: 25000,
        mobile: false,
        deviceMemoryGiB: 4,
        heapSizeLimitGiB: 2,
        hardwareConcurrency: 8
      });

      expect(info).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
      log.mockRestore();
    }
  });

});
