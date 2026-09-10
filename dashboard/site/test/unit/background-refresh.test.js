import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_REFRESH_INTERVAL_MS,
  scheduleBackgroundRefresh
} from '../../src/background-refresh.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('dashboard background refresh', () => {
  it('polls every 15 minutes without refreshing immediately', () => {
    vi.useFakeTimers();
    const refresh = vi.fn();

    scheduleBackgroundRefresh(refresh);
    vi.advanceTimersByTime(BACKGROUND_REFRESH_INTERVAL_MS - 1);
    expect(refresh).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(BACKGROUND_REFRESH_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('stops polling when the page owner is aborted', () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const owner = new AbortController();

    scheduleBackgroundRefresh(refresh, { signal: owner.signal });
    owner.abort();
    vi.advanceTimersByTime(BACKGROUND_REFRESH_INTERVAL_MS * 2);

    expect(refresh).not.toHaveBeenCalled();
  });
});
