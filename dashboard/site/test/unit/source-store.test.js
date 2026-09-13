import { afterEach, expect, it } from 'vitest';
import { effect } from '../../src/reactive.js';
import { configureSourceLoader, publishSource, refreshSources, requestSource, resetSourceStore, sourceState } from '../../src/source-store.js';

/** @type {import('../../src/presenter.js').SourceMetadata} */
const metadata = {
  'source-id': 'fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-11T12:00:00Z',
  'retrieved-at': '2026-09-11T12:00:00Z',
  availability: 'available',
  completeness: 'complete',
  freshness: 'unknown'
};

afterEach(() => {
  resetSourceStore();
});

it('leaves sources idle until a loader is configured', () => {
  requestSource('runs');

  expect(sourceState('runs').get()).toEqual({ status: 'idle', origin: 'query', source: null });
});

it('loads each requested source once and notifies bound effects', async () => {
  /** @type {string[]} */
  const requests = [];
  configureSourceLoader((name) => {
    requests.push(name);
    return Promise.resolve({ source: name, rows: [{ run: '1' }], metadata });
  });
  /** @type {string[]} */
  const observed = [];
  const handle = effect(() => {
    observed.push(sourceState('runs').get().status);
  });

  requestSource('runs');
  requestSource('runs');
  await Promise.resolve();
  await Promise.resolve();

  expect(requests).toEqual(['runs']);
  expect(observed).toEqual(['idle', 'loading', 'ready']);
  expect(sourceState('runs').get().source?.rows).toEqual([{ run: '1' }]);
  handle.stop();
});

it('marks a source failed when its query rejects', async () => {
  configureSourceLoader(() => Promise.reject(new Error('query unavailable')));

  requestSource('outcomes');
  await Promise.resolve();
  await Promise.resolve();

  expect(sourceState('outcomes').get()).toEqual({ status: 'failed', origin: 'query', source: null });
});

it('re-runs requested queries when live data refreshes', async () => {
  let rows = [{ run: '1' }];
  configureSourceLoader((name) => Promise.resolve({ source: name, rows, metadata }));

  requestSource('runs');
  await Promise.resolve();
  await Promise.resolve();
  rows = [{ run: '1' }, { run: '2' }];
  refreshSources();
  await Promise.resolve();
  await Promise.resolve();

  expect(sourceState('runs').get().source?.rows).toHaveLength(2);
});

it('publishes rows a rendered view already holds without a query', () => {
  configureSourceLoader(() => Promise.reject(new Error('should not be queried')));

  publishSource('workflows', { source: 'workflows', rows: [{ workflow: 'review' }], metadata });

  expect(sourceState('workflows').get()).toEqual({
    status: 'ready',
    origin: 'view',
    source: { source: 'workflows', rows: [{ workflow: 'review' }], metadata }
  });
});
