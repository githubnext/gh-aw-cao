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

it('forwards query context and reloads a source when that context changes', async () => {
  /** @type {Array<{ pageId?: string, query?: string }>} */
  const requests = [];
  configureSourceLoader((name, options) => {
    requests.push({
      pageId: options?.pageId,
      query: options?.queryContext?.search?.query
    });
    return Promise.resolve({ source: name, rows: [], metadata });
  });

  requestSource('runs', { pageId: 'overview', queryContext: { search: { fields: ['workflow'], query: 'first' } } });
  await Promise.resolve();
  await Promise.resolve();
  requestSource('runs', { pageId: 'overview', queryContext: { search: { fields: ['workflow'], query: 'second' } } });
  await Promise.resolve();
  await Promise.resolve();

  expect(requests).toEqual([
    { pageId: 'overview', query: 'first' },
    { pageId: 'overview', query: 'second' }
  ]);
});

it('keeps separate view bindings for the same database table', async () => {
  configureSourceLoader((name, options) => Promise.resolve({
    source: name,
    rows: [{ view: options?.viewId }],
    metadata
  }));

  requestSource('runs', { pageId: 'overview', viewId: 'header', bindingKey: 'header-runs' });
  requestSource('runs', { pageId: 'overview', viewId: 'floor', bindingKey: 'floor-runs' });
  await Promise.resolve();
  await Promise.resolve();

  expect(sourceState('header-runs').get().source?.rows).toEqual([{ view: 'header' }]);
  expect(sourceState('floor-runs').get().source?.rows).toEqual([{ view: 'floor' }]);
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

it('records a source the dashboard data does not carry as missing rather than failed', async () => {
  configureSourceLoader(() => Promise.resolve(undefined));

  requestSource('dispatches');
  await Promise.resolve();
  await Promise.resolve();

  expect(sourceState('dispatches').get()).toEqual({ status: 'missing', origin: 'query', source: null });
});

it('groups a refresh so bound effects run once for the whole batch', async () => {
  configureSourceLoader(() => Promise.reject(new Error('offline')));
  requestSource('runs');
  requestSource('outcomes');
  await Promise.resolve();
  await Promise.resolve();
  expect(sourceState('runs').get().status).toBe('failed');

  let runCount = 0;
  const handle = effect(() => {
    sourceState('runs').get();
    sourceState('outcomes').get();
    runCount += 1;
  });
  configureSourceLoader(() => new Promise(() => {}));
  // Both sources flip back to loading, but the bound effect runs once.
  refreshSources();

  expect(sourceState('outcomes').get().status).toBe('loading');
  expect(runCount).toBe(2);
  handle.stop();
});
