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
