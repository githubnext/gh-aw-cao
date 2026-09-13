import { afterEach, describe, expect, it, vi } from 'vitest';
import { startIngestionProgress } from '../../src/data-worker.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('data-worker ingestion progress', () => {
  it('shows progress after three seconds, updates every second, and dismisses it when complete', () => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    const progress = startIngestionProgress({ postMessage });

    progress.update(42);
    vi.advanceTimersByTime(2_999);
    expect(postMessage).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(postMessage).toHaveBeenCalledWith({
      type: 'notification',
      notification: expect.objectContaining({
        id: expect.stringMatching(/^ingestion-progress-/),
        message: 'Ingesting data... 42 records ingested.',
        duration: 0
      })
    });

    progress.update(84);
    vi.advanceTimersByTime(1_000);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'notification',
      notification: expect.objectContaining({
        message: 'Ingesting data... 84 records ingested.'
      })
    });

    progress.complete();
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'notification',
      notification: expect.objectContaining({ dismiss: true })
    });
    vi.advanceTimersByTime(1_000);
    expect(postMessage).toHaveBeenCalledTimes(3);
  });
});
