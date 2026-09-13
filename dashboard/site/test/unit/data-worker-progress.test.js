import { afterEach, describe, expect, it, vi } from 'vitest';
import { startIngestionProgress } from '../../src/data-worker.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('data-worker ingestion progress', () => {
  it('reports the latest status every five seconds and dismisses it when complete', () => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    const progress = startIngestionProgress({ postMessage });

    progress.update('Ingesting dashboard activity data: 42 records processed.');
    vi.advanceTimersByTime(5_000);

    expect(postMessage).toHaveBeenCalledWith({
      type: 'notification',
      notification: expect.objectContaining({
        id: expect.stringMatching(/^ingestion-progress-/),
        message: 'Ingesting dashboard activity data: 42 records processed.',
        duration: 0
      })
    });

    progress.complete();
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'notification',
      notification: expect.objectContaining({ dismiss: true })
    });
    vi.advanceTimersByTime(5_000);
    expect(postMessage).toHaveBeenCalledTimes(2);
  });
});
