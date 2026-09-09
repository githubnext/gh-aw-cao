import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeCanonicalDashboardView } from '../../src/data-processor.js';
import { effect, state } from '../../src/reactive.js';

class SubscriptionWorker {
  /** @type {SubscriptionWorker | undefined} */
  static current;

  constructor() {
    SubscriptionWorker.current = this;
    /** @type {Record<string, unknown>[]} */
    this.messages = [];
    /** @type {Map<string, (event: { data: Record<string, unknown> }) => void>} */
    this.listeners = new Map();
  }

  /** @param {string} type @param {(event: { data: Record<string, unknown> }) => void} listener */
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

  terminate() {}
}

afterEach(() => {
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

  it('collapses rapid table updates per view and batches dependent UI effects', async () => {
    vi.stubGlobal('Worker', SubscriptionWorker);
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
    await Promise.resolve();

    expect(renders).toEqual([':0', 'latest:2']);
    unsubscribe();
    renderEffect.stop();
  });

  it('rejects conflicting query parameters for the same view', () => {
    vi.stubGlobal('Worker', SubscriptionWorker);
    const unsubscribe = subscribeCanonicalDashboardView('overview', ['runs'], { pages: [] }, () => {});

    expect(() => subscribeCanonicalDashboardView('overview', ['jobs'], { pages: [] }, () => {}))
      .toThrow('already subscribed with different query parameters');
    unsubscribe();
  });
});
