import { afterEach, expect, it, vi } from 'vitest';
import { subscribeCanonicalDashboardView } from '../../src/data-processor.js';
import { queryRemoteDashboard, subscribeRemoteRevision } from '../../src/remote-data-backend.js';

vi.mock('../../src/remote-data-backend.js', () => ({
  usesRemoteDataBackend: () => true,
  queryRemoteDashboard: vi.fn(),
  subscribeRemoteRevision: vi.fn(() => () => {})
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it('refreshes webhook counters without a revision and aborts polling when the view closes', async () => {
  vi.useFakeTimers();
  const counters = (/** @type {number} */ received) => ({
    revision: 1, healthRevision: 1,
    sources: { 'ingestion-webhook-status': { source: 'ingestion-webhook-status', rows: [{ received }] } }
  });
  vi.mocked(queryRemoteDashboard).mockResolvedValueOnce(counters(1)).mockResolvedValue(counters(2));
  const listener = vi.fn();
  const controller = new AbortController();
  const stop = subscribeCanonicalDashboardView('webhook-live', ['ingestion-webhook-status'], {
    pages: [], queries: [{ name: 'ingestion-webhook-status', from: 'webhook-status' }]
  }, listener, undefined, { signal: controller.signal });
  await vi.advanceTimersByTimeAsync(20);
  expect(listener.mock.calls.at(-1)?.[0]['ingestion-webhook-status'].rows).toEqual([{ received: 1 }]);
  const requestSignal = vi.mocked(queryRemoteDashboard).mock.calls[0][3]?.signal;
  expect(requestSignal).toBeInstanceOf(AbortSignal);
  await vi.advanceTimersByTimeAsync(30_000);
  await vi.advanceTimersByTimeAsync(20);
  expect(listener.mock.calls.at(-1)?.[0]['ingestion-webhook-status'].rows).toEqual([{ received: 2 }]);
  expect(queryRemoteDashboard).toHaveBeenCalledTimes(2);
  controller.abort();
  stop();
  expect(requestSignal?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(queryRemoteDashboard).toHaveBeenCalledTimes(2);
});

it('refreshes only subscribed collection load when time passes without a revision', async () => {
  vi.useFakeTimers();
  vi.mocked(queryRemoteDashboard).mockResolvedValue({
    revision: 1,
    healthRevision: 1,
    sources: { 'ingestion-health': { source: 'ingestion-health', rows: [{ 'webhook-load': 1 }] } }
  });
  const listener = vi.fn();
  const context = {
    pages: [],
    queries: [{ name: 'ingestion-health', from: 'collection-health' }]
  };
  const stop = subscribeCanonicalDashboardView('load', ['ingestion-health'], context, listener);
  const stopUnrelated = subscribeCanonicalDashboardView('runs', ['runs'], context, vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(queryRemoteDashboard).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(queryRemoteDashboard).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(20);
  expect(listener).toHaveBeenCalledTimes(2);
  stop();
  stopUnrelated();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(queryRemoteDashboard).toHaveBeenCalledTimes(3);
  expect(subscribeRemoteRevision).toHaveBeenCalledTimes(2);
});
