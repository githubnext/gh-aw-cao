import { afterEach, describe, expect, it, vi } from 'vitest';
import { startIngestionProgress } from '../../src/data-worker.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('data-worker ingestion progress', () => {
  it('reports zero source records before the first JSONL record is read', () => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    const progress = startIngestionProgress({ postMessage });

    vi.advanceTimersByTime(3_000);

    expect(postMessage).toHaveBeenCalledWith({
      type: 'notification',
      notification: expect.objectContaining({
        message: 'Reading source data... 0 records read.',
        duration: 0
      })
    });
    progress.complete();
  });

  it('reports the storage phase so long writes never freeze the notification', () => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    const progress = startIngestionProgress({ postMessage });

    progress.update(1_000);
    progress.store({ storedRecords: 250, totalRecords: 1_000 });
    vi.advanceTimersByTime(3_000);

    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'notification',
      notification: expect.objectContaining({
        message: 'Storing data... 250 of 1000 records stored.',
        duration: 0
      })
    });

    progress.store({ storedRecords: 1_000, totalRecords: 1_000 });
    vi.advanceTimersByTime(1_000);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'notification',
      notification: expect.objectContaining({
        message: 'Storing data... 1000 of 1000 records stored.'
      })
    });

    progress.complete();
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'notification',
      notification: expect.objectContaining({ dismiss: true })
    });
  });

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
        message: 'Reading source data... 42 records read.',
        duration: 0
      })
    });

    progress.update(84);
    vi.advanceTimersByTime(1_000);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'notification',
      notification: expect.objectContaining({
        message: 'Reading source data... 84 records read.'
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
