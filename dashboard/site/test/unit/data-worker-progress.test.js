import { afterEach, describe, expect, it, vi } from 'vitest';
import { startIngestionProgress } from '../../src/data-worker.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('data-worker ingestion progress', () => {
  it('reports preparation before the first JSONL record is read', () => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    const progress = startIngestionProgress({ postMessage });

    vi.advanceTimersByTime(3_000);

    expect(postMessage).toHaveBeenCalledWith({
      type: 'notification',
      notification: expect.objectContaining({
        message: 'Preparing source data...',
        details: ['Preparing source data...'],
        duration: 0
      })
    });
    progress.complete();
  });

  it('does not publish when the delayed report was already queued at completion', () => {
    let delayedReport = () => {};
    vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce((callback) => {
      delayedReport = /** @type {() => void} */ (callback);
      return /** @type {ReturnType<typeof setTimeout>} */ (/** @type {unknown} */ (1));
    });
    const postMessage = vi.fn();
    const progress = startIngestionProgress({ postMessage });

    progress.complete();
    delayedReport();

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'notification',
      notification: expect.objectContaining({ dismiss: true })
    });
  });

  it('reports the storage phase so long writes never freeze the notification', () => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    const progress = startIngestionProgress({ postMessage });

    progress.update(1_000);
    progress.log('Normalizing parsed records.');
    progress.store({ storedRecords: 250, totalRecords: 1_000 });
    vi.advanceTimersByTime(3_000);

    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'notification',
      notification: expect.objectContaining({
        message: 'Storing data... 250 of 1000 records stored.',
        details: [
          'Preparing source data...',
          'Reading source data... 1000 records read.',
          'Normalizing parsed records.',
          'Storing data... 250 of 1000 records stored.'
        ],
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

  it('retains only the latest one hundred distinct progress messages', () => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    const progress = startIngestionProgress({ postMessage });

    for (let index = 1; index <= 105; index += 1) progress.log(`Step ${index}`);
    progress.log('Step 105');
    vi.advanceTimersByTime(3_000);

    const notification = postMessage.mock.lastCall?.[0]?.notification;
    expect(notification.details).toHaveLength(100);
    expect(notification.details[0]).toBe('Step 6');
    expect(notification.details.at(-1)).toBe('Step 105');
    progress.complete();
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
