import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';

/** @typedef {Parameters<typeof processDataRequest>[0] & { id: number }} Request */
/** @type {Request[]} */
let requests = [];
/** @type {DeferredWorker} */
let worker;
let lifetime = new AbortController();

class DeferredWorker extends EventTarget {
  constructor() {
    super();
    worker = this;
  }

  /** @param {Request} request */
  postMessage(request) {
    if (request.operation === 'query-dashboard-callouts') requests.push(request);
  }

  /** @param {Request} request */
  respond(request) {
    const data = processDataRequest(request);
    this.dispatchEvent(new MessageEvent('message', { data: { id: request.id, data } }));
  }

  terminate() {}
}

const now = Date.parse('2026-10-15T12:00:00Z');
const callout = {
  id: 'stale', title: 'Data is stale.', description: 'Check ingestion.',
  'visible-when': { source: 'freshness', field: 'at', 'older-than-hours': 24 }
};
/** @param {number} at */
function sources(at) {
  return {
    freshness: {
      source: 'freshness', rows: [{ at }],
      metadata: {
        'source-id': 'freshness', 'source-kind': 'database-query', 'as-of': '', 'retrieved-at': '',
        availability: /** @type {const} */ ('available'), completeness: /** @type {const} */ ('complete'),
        freshness: /** @type {const} */ ('fresh')
      }
    }
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('Worker', DeferredWorker);
  vi.spyOn(Date, 'now').mockReturnValue(now);
  requests = [];
  lifetime = new AbortController();
});

afterEach(() => {
  lifetime.abort();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('worker-only callout subscriptions', () => {
  it('evaluates only declared sources and ignores superseded and aborted replies', async () => {
    const { subscribeCalloutVisibility } = await import('../../src/data/callouts.js');
    const update = vi.fn();
    const error = vi.fn();
    const subscribe = vi.fn(/** @param {string[]} _names @param {import('../../src/presenter.js').PageSourceLoadOptions} _options */ (_names, _options) => new Promise(() => {}));
    const loader = Object.assign(vi.fn(), { subscribeBackgroundSources: subscribe });
    subscribeCalloutVisibility([callout], { ...sources(now - 86400000), unrelated: sources(now).freshness },
      loader, lifetime.signal, update, error);
    expect(Object.keys(/** @type {object} */ (requests[0].sources))).toEqual(['freshness']);
    const options = subscribe.mock.calls[0][1];
    options.onUpdate(sources(now));
    expect(requests).toHaveLength(2);
    worker.respond(requests[0]);
    await Promise.resolve();
    expect(update).not.toHaveBeenCalled();
    worker.respond(requests[1]);
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith([{ id: 'stale', visibility: 'hidden' }]));
    options.onUpdate(sources(now - 86400000));
    lifetime.abort();
    worker.respond(requests[2]);
    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it('reevaluates age in the worker without a database revision and stops its clock on abort', async () => {
    vi.useFakeTimers();
    const { subscribeCalloutVisibility } = await import('../../src/data/callouts.js');
    const update = vi.fn();
    subscribeCalloutVisibility([callout], sources(now - 86400000 + 60_000), undefined,
      lifetime.signal, update, vi.fn());
    worker.respond(requests[0]);
    await vi.waitFor(() => expect(update).toHaveBeenLastCalledWith([{ id: 'stale', visibility: 'hidden' }]));
    vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    worker.respond(requests[1]);
    await vi.waitFor(() => expect(update).toHaveBeenLastCalledWith([{ id: 'stale', visibility: 'visible' }]));
    lifetime.abort();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails closed when no data worker is available', async () => {
    vi.stubGlobal('Worker', undefined);
    const { processDashboardCallouts } = await import('../../src/data-processor.js');
    await expect(processDashboardCallouts([callout], sources(now), lifetime.signal))
      .rejects.toThrow('require a data worker');
  });

  it('preserves typed equality, missing evidence, and cancellation in the production worker', () => {
    const declaration = { ...callout, 'visible-when': { source: 'freshness', field: 'at', equals: 1 } };
    expect(processDataRequest({ operation: 'query-dashboard-callouts', callouts: [declaration], sources: sources(1) }))
      .toEqual([{ id: 'stale', visibility: 'visible' }]);
    expect(processDataRequest({ operation: 'query-dashboard-callouts', callouts: [declaration], sources: {
      freshness: { ...sources(1).freshness, rows: [{ at: '1' }] }
    } })).toEqual([{ id: 'stale', visibility: 'hidden' }]);
    expect(processDataRequest({ operation: 'query-dashboard-callouts', callouts: [declaration], sources: {} }))
      .toEqual([{ id: 'stale', visibility: 'unavailable' }]);
    lifetime.abort();
    expect(() => processDataRequest({
      operation: 'query-dashboard-callouts', callouts: [declaration], sources: sources(1)
    }, lifetime.signal)).toThrow();
  });
});
