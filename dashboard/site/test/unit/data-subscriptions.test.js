import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelDataProcessing,
  processDashboardQueries,
  subscribeCanonicalDashboardView
} from '../../src/data-processor.js';
import { effect, state } from '../../src/reactive.js';

class SubscriptionWorker {
  /** @type {SubscriptionWorker | undefined} */
  static current;

  constructor() {
    SubscriptionWorker.current = this;
    /** @type {Record<string, unknown>[]} */
    this.messages = [];
    /** @type {Map<string, (event: { data: Record<string, unknown>, message?: string }) => void>} */
    this.listeners = new Map();
    this.terminated = false;
  }

  /** @param {string} type @param {(event: { data: Record<string, unknown>, message?: string }) => void} listener */
  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  /** @param {Record<string, unknown>} message */
  postMessage(message) {
    this.messages.push(message);
  }

  /** @param {Record<string, unknown>} message */
  emit(message) {
    this.listeners.get('message')?.({ data: message });
  }

  /** @param {string} message */
  emitError(message) {
    this.listeners.get('error')?.({ data: {}, message });
  }

  terminate() {
    this.terminated = true;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('canonical dashboard view subscriptions', () => {
  it('shares one worker subscription and tears it down after the final listener', () => {
    vi.stubGlobal('Worker', SubscriptionWorker);
    const first = vi.fn();
    const second = vi.fn();
    const context = { pages: [] };

    const unsubscribeFirst = subscribeCanonicalDashboardView('overview', ['runs'], context, first);
    const unsubscribeSecond = subscribeCanonicalDashboardView('overview', ['runs'], context, second);
    const worker = SubscriptionWorker.current;
    expect(worker).toBeDefined();
    if (!worker) throw new Error('Subscription worker was not created.');

    expect(worker.messages.filter((message) => message.operation === 'subscribe-canonical-dashboard')).toHaveLength(1);
    unsubscribeFirst();
    expect(worker.messages.some((message) => message.operation === 'unsubscribe-canonical-dashboard')).toBe(false);
    unsubscribeSecond();
    unsubscribeSecond();
    expect(worker.messages.filter((message) => message.operation === 'unsubscribe-canonical-dashboard')).toEqual([{
      operation: 'unsubscribe-canonical-dashboard',
      subscriptionId: 'overview'
    }]);
  });

  it('can wait for the next database update instead of replaying current rows', () => {
    vi.stubGlobal('Worker', SubscriptionWorker);
    const unsubscribe = subscribeCanonicalDashboardView(
      'refresh-table',
      ['runs'],
      { pages: [] },
      () => {},
      undefined,
      { emitCurrent: false }
    );
    const worker = SubscriptionWorker.current;
    expect(worker).toBeDefined();
    if (!worker) throw new Error('Subscription worker was not created.');

    expect(worker.messages.find((message) => message.subscriptionId === 'refresh-table')).toMatchObject({
      operation: 'subscribe-canonical-dashboard',
      subscriptionId: 'refresh-table',
      emitCurrent: false
    });
    unsubscribe();
  });

  it('tracks duplicate listener registrations independently', () => {
    vi.stubGlobal('Worker', SubscriptionWorker);
    const listener = vi.fn();
    const context = { pages: [] };

    const unsubscribeFirst = subscribeCanonicalDashboardView('duplicates', ['runs'], context, listener);
    const unsubscribeSecond = subscribeCanonicalDashboardView('duplicates', ['runs'], context, listener);
    const worker = SubscriptionWorker.current;
    expect(worker).toBeDefined();
    if (!worker) throw new Error('Subscription worker was not created.');

    unsubscribeFirst();
    expect(worker.messages.some((message) =>
      message.operation === 'unsubscribe-canonical-dashboard' && message.subscriptionId === 'duplicates'
    )).toBe(false);
    unsubscribeSecond();
    expect(worker.messages.at(-1)?.operation).toBe('unsubscribe-canonical-dashboard');
  });

  it('collapses rapid table updates per view and batches dependent UI effects', () => {
    vi.stubGlobal('Worker', SubscriptionWorker);
    /** @type {FrameRequestCallback | undefined} */
    let flushFrame;
    vi.stubGlobal('requestAnimationFrame', (/** @type {FrameRequestCallback} */ callback) => {
      flushFrame = callback;
      return 1;
    });
    const rowCount = state(0);
    const tableVersion = state('');
    /** @type {string[]} */
    const renders = [];
    const renderEffect = effect(() => {
      renders.push(`${tableVersion.get()}:${rowCount.get()}`);
    });
    const unsubscribe = subscribeCanonicalDashboardView(
      'runs-table',
      ['runs'],
      { pages: [] },
      (sources) => {
        const rows = Array.isArray(sources.runs?.rows) ? sources.runs.rows : [];
        tableVersion.set(String(sources.runs?.metadata?.version ?? ''));
        rowCount.set(rows.length);
      }
    );
    const worker = SubscriptionWorker.current;
    expect(worker).toBeDefined();
    if (!worker) throw new Error('Subscription worker was not created.');

    worker.emit({
      subscriptionId: 'runs-table',
      data: { runs: { rows: [{ id: 1 }], metadata: { version: 'first' } } }
    });
    worker.emit({
      subscriptionId: 'runs-table',
      data: { runs: { rows: [{ id: 1 }, { id: 2 }], metadata: { version: 'latest' } } }
    });
    expect(renders).toEqual([':0']);
    flushFrame?.(0);

    expect(renders).toEqual([':0', 'latest:2']);
    unsubscribe();
    renderEffect.stop();
  });

  it('replays the current snapshot to listeners joining a live view', () => {
    vi.stubGlobal('Worker', SubscriptionWorker);
    /** @type {FrameRequestCallback[]} */
    const frames = [];
    vi.stubGlobal('requestAnimationFrame', (/** @type {FrameRequestCallback} */ callback) => {
      frames.push(callback);
      return frames.length;
    });
    const context = { pages: [] };
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeCanonicalDashboardView('live-table', ['runs'], context, first);
    const worker = SubscriptionWorker.current;
    expect(worker).toBeDefined();
    if (!worker) throw new Error('Subscription worker was not created.');
    const snapshot = { runs: { rows: [{ id: 1 }] } };

    worker.emit({ subscriptionId: 'live-table', data: snapshot });
    frames.shift()?.(0);
    const unsubscribeSecond = subscribeCanonicalDashboardView('live-table', ['runs'], context, second);
    frames.shift()?.(1);

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledWith(snapshot);
    unsubscribeSecond();
    unsubscribeFirst();
  });

  it('rejects conflicting query parameters for the same view', () => {
    vi.stubGlobal('Worker', SubscriptionWorker);
    const unsubscribe = subscribeCanonicalDashboardView('overview', ['runs'], { pages: [] }, () => {});

    expect(() => subscribeCanonicalDashboardView('overview', ['jobs'], { pages: [] }, () => {}))
      .toThrow('already subscribed with different query parameters');
    unsubscribe();
  });

  it('unsubscribes with its owner signal and drops queued DOM updates', async () => {
    vi.stubGlobal('Worker', SubscriptionWorker);
    const controller = new AbortController();
    const listener = vi.fn();
    subscribeCanonicalDashboardView(
      'owned-table',
      ['runs'],
      { pages: [] },
      listener,
      undefined,
      { signal: controller.signal }
    );
    const worker = SubscriptionWorker.current;
    expect(worker).toBeDefined();
    if (!worker) throw new Error('Subscription worker was not created.');

    worker.emit({ subscriptionId: 'owned-table', data: { runs: { rows: [{ id: 1 }] } } });
    controller.abort();
    await Promise.resolve();

    expect(listener).not.toHaveBeenCalled();
    expect(worker.messages.at(-1)).toEqual({
      operation: 'unsubscribe-canonical-dashboard',
      subscriptionId: 'owned-table'
    });
  });

  it('reports worker query errors without dropping the subscription', () => {
    vi.stubGlobal('Worker', SubscriptionWorker);
    const onError = vi.fn();
    const unsubscribe = subscribeCanonicalDashboardView(
      'failed-table',
      ['runs'],
      { pages: [] },
      () => {},
      undefined,
      { onError }
    );
    const worker = SubscriptionWorker.current;
    expect(worker).toBeDefined();
    if (!worker) throw new Error('Subscription worker was not created.');

    worker.emit({ subscriptionId: 'failed-table', error: 'Query failed' });

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Query failed' }));
    unsubscribe();
  });

  it('terminates subscriptions with an error when their worker fails', () => {
    vi.stubGlobal('Worker', SubscriptionWorker);
    const onError = vi.fn();
    const unsubscribe = subscribeCanonicalDashboardView(
      'worker-failure',
      ['runs'],
      { pages: [] },
      () => {},
      undefined,
      { onError }
    );
    const failedWorker = SubscriptionWorker.current;
    expect(failedWorker).toBeDefined();
    if (!failedWorker) throw new Error('Subscription worker was not created.');

    failedWorker.emitError('Worker crashed');

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Worker crashed' }));
    expect(failedWorker.terminated).toBe(true);
    unsubscribe();
  });

  it('rejects every request owned by a worker when cancellation terminates it', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', SubscriptionWorker);
    const first = processDashboardQueries([], {});
    cancelDataProcessing();
    const second = processDashboardQueries([], {});
    const firstRejection = expect(first).rejects.toMatchObject({ name: 'DataProcessingCancelledError' });
    const secondRejection = expect(second).rejects.toMatchObject({ name: 'DataProcessingCancelledError' });

    await vi.advanceTimersByTimeAsync(251);

    await firstRejection;
    await secondRejection;
  });

  it('does not post requests for an already-aborted owner signal', async () => {
    vi.stubGlobal('Worker', SubscriptionWorker);
    const controller = new AbortController();
    controller.abort();
    const worker = SubscriptionWorker.current;
    const messageCount = worker?.messages.length ?? 0;

    await expect(processDashboardQueries([], {}, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'DataProcessingCancelledError' });
    expect(worker?.messages.length ?? 0).toBe(messageCount);
  });
});
