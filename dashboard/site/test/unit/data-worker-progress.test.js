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

    expect(postMessage).toHaveBeenNthCalledWith(2, {
      type: 'notification',
      notification: expect.objectContaining({
        message: 'Preparing data... +3s',
        details: ['Preparing data... +3s'],
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

    expect(postMessage).toHaveBeenCalledTimes(3);
    expect(postMessage).toHaveBeenNthCalledWith(3, {
      type: 'notification',
      notification: expect.objectContaining({ dismiss: true })
    });
  });

  it('reports the storage phase so long writes never freeze the notification', () => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    const progress = startIngestionProgress({ postMessage });

    progress.update({ bytesProcessed: 750_000, recordsIngested: 1_000, totalBytes: 1_500_000 });
    progress.log('Normalizing parsed records.');
    progress.store({ storedRecords: 250, totalRecords: 1_000 });
    vi.advanceTimersByTime(3_000);

    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'notification',
      notification: expect.objectContaining({
        message: 'Storing 250/1,000 rec. +3s',
        details: [
          'Preparing data... +0s',
          'Parsing 1,000 rec, 750 KB/1.5 MB. +0s',
          'Normalizing parsed records. +0s',
          'Storing 250/1,000 rec. +3s'
        ],
        duration: 0
      })
    });

    progress.store({ storedRecords: 1_000, totalRecords: 1_000 });
    vi.advanceTimersByTime(1_000);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'notification',
      notification: expect.objectContaining({
        message: 'Storing 1,000/1,000 rec. +4s'
      })
    });

    progress.complete();
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'notification',
      notification: expect.objectContaining({ dismiss: true })
    });
  });

  it('publishes shard import state as the manifest and imports progress', () => {
    const postMessage = vi.fn();
    const progress = startIngestionProgress({ postMessage });

    progress.reportShardImportProgress(0, 4);
    progress.reportShardImportProgress(2, 4);

    expect(postMessage).toHaveBeenNthCalledWith(2, {
      type: 'loading-progress',
      state: { id: expect.stringMatching(/^ingestion-progress-/), phase: 'update', completed: 0, total: 4 }
    });
    expect(postMessage).toHaveBeenNthCalledWith(3, {
      type: 'loading-progress',
      state: { id: expect.stringMatching(/^ingestion-progress-/), phase: 'update', completed: 2, total: 4 }
    });
    progress.complete();
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
    expect(notification.details[0]).toBe('Step 6 +0s');
    expect(notification.details.at(-1)).toBe('Step 105 +3s');
    progress.complete();
  });

  it('shows progress after three seconds, updates every second, and dismisses it when complete', () => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    const progress = startIngestionProgress({ postMessage });

    progress.update({ bytesProcessed: 1_024, recordsIngested: 42, totalBytes: 2_048 });
    vi.advanceTimersByTime(2_999);
    expect(postMessage).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);

    expect(postMessage).toHaveBeenCalledWith({
      type: 'notification',
      notification: expect.objectContaining({
        id: expect.stringMatching(/^ingestion-progress-/),
        message: 'Parsing 42 rec, 1.0 KB/2.0 KB. +3s',
        duration: 0
      })
    });

    progress.update({ bytesProcessed: 2_048, recordsIngested: 84, totalBytes: 2_048 });
    vi.advanceTimersByTime(1_000);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'notification',
      notification: expect.objectContaining({
        message: 'Parsing 84 rec, 2.0 KB/2.0 KB. +4s'
      })
    });

    progress.complete();
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'notification',
      notification: expect.objectContaining({ dismiss: true })
    });
    vi.advanceTimersByTime(1_000);
    expect(postMessage).toHaveBeenCalledTimes(5);
  });
});
