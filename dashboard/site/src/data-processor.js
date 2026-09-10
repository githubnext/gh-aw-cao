import { tidy } from './data-operations.js';
import { summarizeTableColumns } from './table-summary-data.js';
import { clusterScatterPoints } from './scatter-clustering.js';
import { deriveDataHealthSources } from './data-health.js';
import { adaptDashboardSources } from './data/adapters/dashboard-sources.js';
import { normalize } from './data/normalize/index.js';
import { batch } from './reactive.js';

/** Milliseconds a cooperative cancellation is given before the worker is terminated. */
const CANCELLATION_GRACE_MS = 250;

/** @type {Worker | null} */
let worker = null;
let nextRequestId = 0;
/** @type {Map<number, { resolve: (value: unknown) => void, reject: (reason: Error) => void, cleanup: () => void, processor: Worker }>} */
const pending = new Map();
/**
 * @typedef {{ notify: (sources: Record<string, import('./presenter.js').LogicalSourceInput>) => void, onError?: (error: Error) => void, cleanup: () => void, frame: number | null }} SubscriptionListener
 */
/**
 * @typedef {{
 *   id: string,
 *   sourceNames: string[],
 *   context: { githubUrlBase?: string, dashboardRepository?: string | null, pages: unknown[], queries?: unknown[] },
 *   pagination?: Record<string, { limit: number, continuationToken?: string }>,
 *   listeners: Set<SubscriptionListener>,
 *   registeredWorker: Worker | null,
 *   latest: Record<string, import('./presenter.js').LogicalSourceInput> | null,
 *   snapshot: Record<string, import('./presenter.js').LogicalSourceInput> | null,
 *   frame: number | null,
 *   emitCurrent: boolean
 * }} ViewSubscription
 */
/** @type {Map<string, ViewSubscription>} */
const subscriptions = new Map();

/**
 * Cancels every in-flight data-worker request. The worker is first asked to
 * stop cooperatively; if it does not acknowledge within the grace period it is
 * blocked in a runaway computation and is terminated instead. A terminated
 * worker is recreated on the next request.
 *
 * @param {string} [reason]
 * @returns {number} the number of requests that were cancelled
 */
export function cancelDataProcessing(reason = 'Data processing was cancelled.') {
  const ids = [...pending.keys()];
  if (!ids.length) return 0;
  const processor = worker;
  if (processor) processor.postMessage({ id: ++nextRequestId, operation: 'cancel-data-processing', ids });
  const cancellation = new Error(reason);
  cancellation.name = 'DataProcessingCancelledError';
  if (processor) scheduleForcedCancellation(processor, ids, cancellation);
  return ids.length;
}

/** @param {Worker} processor @param {number[]} ids @param {Error} cancellation */
function scheduleForcedCancellation(processor, ids, cancellation) {
  setTimeout(() => {
    if (!ids.some((id) => pending.has(id))) return;
    rejectWorkerRequests(processor, cancellation);
    resetWorker(processor);
  }, CANCELLATION_GRACE_MS);
}

/** @param {Worker} processor @param {Error} error */
function rejectWorkerRequests(processor, error) {
  for (const [id, request] of pending) {
    if (request.processor !== processor) continue;
    request.cleanup();
    request.reject(error);
    pending.delete(id);
  }
}

/**
 * Runs a serializable tidy pipeline in a Web Worker when the environment supports it.
 * @param {Array<Record<string, unknown>>} data
 * @param {Parameters<typeof tidy>[1]} operators
 * @returns {Array<Record<string, unknown>>|Promise<Array<Record<string, unknown>>>}
 */
export function processRows(data, operators) {
  return processRequest(
    { data, operators },
    () => tidy(data, operators)
  );
}

/**
 * Computes serializable table summaries in a Web Worker when supported.
 * @param {import('./table-summary-data.js').TableSummaryColumn[]} columns
 * @returns {import('./table-summary-data.js').TableColumnSummary[]|Promise<import('./table-summary-data.js').TableColumnSummary[]>}
 */
export function processTableSummaries(columns) {
  return processRequest(
    { operation: 'summarize-table-columns', columns },
    () => summarizeTableColumns(columns)
  );
}

/**
 * @param {import('./scatter-clustering.js').ScatterPoint[]} points
 * @param {number} limit
 * @returns {import('./scatter-clustering.js').ScatterPoint[]|Promise<import('./scatter-clustering.js').ScatterPoint[]>}
 */
export function processScatterPoints(points, limit) {
  return processRequest(
    { operation: 'cluster-scatter-points', data: points, limit },
    () => clusterScatterPoints(points, limit)
  );
}

/**
 * Computes detailed data-health diagnostics in a Web Worker when supported.
 * @param {Record<string, import('./presenter.js').LogicalSourceInput>} sources
 * @param {{ githubUrlBase?: string, dashboardRepository?: string | null }} context
 * @returns {Record<string, import('./presenter.js').LogicalSourceInput>|Promise<Record<string, import('./presenter.js').LogicalSourceInput>>}
 */
export function processDataHealthSources(sources, context) {
  return processRequest(
    { operation: 'derive-data-health', sources, context },
    () => deriveDataHealthSources(sources, context)
  );
}

/**
 * Adapts and normalizes published dashboard sources in a Web Worker when supported.
 * @param {Record<string, unknown>} sources
 * @returns {import('./data/model/schema.js').CanonicalBatch|Promise<import('./data/model/schema.js').CanonicalBatch>}
 */
export function processCanonicalDashboardSources(sources) {
  return normalize(adaptDashboardSources(sources).observations);
}

/**
 * Executes declarative dashboard queries exclusively in the data worker.
 * There is no main-thread fallback: queries either run in the worker or fail.
 * @param {unknown[]} queries
 * @param {Record<string, import('./presenter.js').LogicalSourceInput>} sources
 * @param {{ signal?: AbortSignal, pagination?: Record<string, { limit: number, continuationToken?: string }> }} [options] cancels the request from outside
 * @returns {Promise<Record<string, import('./presenter.js').LogicalSourceInput>>}
 */
export function processDashboardQueries(queries, sources, options = {}) {
  return /** @type {Promise<Record<string, import('./presenter.js').LogicalSourceInput>>} */ (processRequest(
    { operation: 'execute-dashboard-queries', queries, sources, pagination: options.pagination },
    () => Promise.reject(new Error('Declarative dashboard queries require a data worker.')),
    false,
    options.signal
  ));
}

/**
 * Loads and hydrates the live canonical dashboard entirely in the data worker.
 * The main thread sends only a URL and receives the query projection needed by
 * the renderer.
 * @param {string} sourceUrl
 * @param {string[]} sourceNames
 * @param {{ githubUrlBase?: string, pages: unknown[] }} context
 * @param {Record<string, { limit: number, continuationToken?: string }>} [pagination]
 * @returns {Promise<Record<string, import('./presenter.js').LogicalSourceInput>>}
 */
export function loadCanonicalDashboardSources(sourceUrl, sourceNames, context, pagination) {
  return /** @type {Promise<Record<string, import('./presenter.js').LogicalSourceInput>>} */ (processRequest(
    { operation: 'load-canonical-dashboard', sourceUrl, sourceNames, context, pagination },
    () => Promise.reject(new Error('Live canonical dashboard loading requires a data worker.')),
    false
  ));
}

/**
 * Refreshes the canonical dashboard and reports whether fresh data was written.
 * @param {string} sourceUrl
 * @param {string[]} sourceNames
 * @param {{ githubUrlBase?: string, pages: unknown[] }} context
 * @param {Record<string, { limit: number, continuationToken?: string }>} [pagination]
 * @returns {Promise<{ sources: Record<string, import('./presenter.js').LogicalSourceInput>, changed: boolean }>}
 */
export function refreshCanonicalDashboardSources(sourceUrl, sourceNames, context, pagination) {
  return /** @type {Promise<{ sources: Record<string, import('./presenter.js').LogicalSourceInput>, changed: boolean }>} */ (processRequest(
    { operation: 'load-canonical-dashboard', sourceUrl, sourceNames, context, pagination, reportActivation: true },
    () => Promise.reject(new Error('Live canonical dashboard refresh requires a data worker.')),
    false
  ));
}

/**
 * Queries one page from the live canonical dashboard retained by the worker.
 * @param {string[]} sourceNames
 * @param {{ githubUrlBase?: string, dashboardRepository?: string | null, pages: unknown[], queries?: unknown[] }} context
 * @param {Record<string, { limit: number, continuationToken?: string }>} [pagination]
 * @returns {Promise<Record<string, import('./presenter.js').LogicalSourceInput>>}
 */
export function loadCanonicalDashboardPage(sourceNames, context, pagination) {
  return /** @type {Promise<Record<string, import('./presenter.js').LogicalSourceInput>>} */ (processRequest(
    { operation: 'query-canonical-dashboard', sourceNames, context, pagination },
    () => Promise.reject(new Error('Live canonical dashboard queries require a data worker.')),
    false
  ));
}

/**
 * Subscribes UI code to the latest rows for one dashboard view. Multiple
 * listeners for the same view share one worker subscription, and rapid worker
 * updates collapse into one notification containing the newest tables.
 *
 * @param {string} viewId
 * @param {string[]} sourceNames
 * @param {{ githubUrlBase?: string, dashboardRepository?: string | null, pages: unknown[] }} context
 * @param {(sources: Record<string, import('./presenter.js').LogicalSourceInput>) => void} listener
 * @param {Record<string, { limit: number, continuationToken?: string }>} [pagination]
 * @param {{ signal?: AbortSignal, onError?: (error: Error) => void, emitCurrent?: boolean }} [options]
 * @returns {() => void}
 */
export function subscribeCanonicalDashboardView(viewId, sourceNames, context, listener, pagination, options = {}) {
  if (typeof viewId !== 'string' || !viewId.trim()) {
    throw new TypeError('Canonical dashboard subscriptions require a view identifier.');
  }
  if (!Array.isArray(sourceNames) || sourceNames.some((name) => typeof name !== 'string')) {
    throw new TypeError('Canonical dashboard subscription source names must be an array of strings.');
  }
  if (typeof listener !== 'function') {
    throw new TypeError('Canonical dashboard subscriptions require a listener.');
  }
  if (options.signal?.aborted) return () => {};
  let subscription = subscriptions.get(viewId);
  if (subscription) {
    if (!sameSubscription(subscription, sourceNames, context, pagination)) {
      throw new Error(`Canonical dashboard view ${viewId} is already subscribed with different query parameters.`);
    }
  } else {
    subscription = {
      id: viewId,
      sourceNames: [...sourceNames],
      context,
      pagination,
      listeners: new Set(),
      registeredWorker: null,
      latest: null,
      snapshot: null,
      frame: null,
      emitCurrent: options.emitCurrent !== false
    };
    subscriptions.set(viewId, subscription);
  }
  const listenerEntry = {
    notify: listener,
    onError: options.onError,
    cleanup: () => options.signal?.removeEventListener('abort', unsubscribeFromSignal),
    frame: null
  };
  subscription.listeners.add(listenerEntry);
  if (subscription.snapshot && subscription.frame === null) {
    const snapshot = subscription.snapshot;
    scheduleSubscriber(listenerEntry, subscription, () => listener(snapshot));
  }
  const unsubscribeFromSignal = () => unsubscribe();
  options.signal?.addEventListener('abort', unsubscribeFromSignal, { once: true });
  const processor = getWorker();
  if (processor) registerSubscription(processor, subscription);

  let active = true;
  const unsubscribe = () => {
    if (!active) return;
    active = false;
    listenerEntry.cleanup();
    cancelSubscriberFrame(listenerEntry);
    const current = subscriptions.get(viewId);
    if (!current) return;
    current.listeners.delete(listenerEntry);
    if (current.listeners.size > 0) return;
    subscriptions.delete(viewId);
    current.latest = null;
    current.snapshot = null;
    if (current.frame !== null && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(current.frame);
    }
    current.frame = null;
    current.registeredWorker?.postMessage({
      operation: 'unsubscribe-canonical-dashboard',
      subscriptionId: viewId
    });
    current.registeredWorker = null;
  };
  return unsubscribe;
}

/** @param {ViewSubscription} subscription @param {string[]} sourceNames @param {ViewSubscription['context']} context @param {ViewSubscription['pagination']} pagination */
function sameSubscription(subscription, sourceNames, context, pagination) {
  return sameContext(subscription.context, context)
    && samePagination(subscription.pagination, pagination)
    && subscription.sourceNames.length === sourceNames.length
    && subscription.sourceNames.every((name, index) => name === sourceNames[index]);
}

/** @param {ViewSubscription['context']} left @param {ViewSubscription['context']} right */
function sameContext(left, right) {
  return left === right || (
    left.githubUrlBase === right.githubUrlBase
    && left.dashboardRepository === right.dashboardRepository
    && left.pages === right.pages
    && left.queries === right.queries
  );
}

/** @param {ViewSubscription['pagination']} left @param {ViewSubscription['pagination']} right */
function samePagination(left, right) {
  if (left === right) return true;
  const leftEntries = Object.entries(left ?? {});
  const rightEntries = Object.entries(right ?? {});
  return leftEntries.length === rightEntries.length && leftEntries.every(([source, request]) => {
    const candidate = right?.[source];
    return candidate?.limit === request.limit
      && candidate?.continuationToken === request.continuationToken;
  });
}

/** @param {Worker} processor @param {ViewSubscription} subscription */
function registerSubscription(processor, subscription) {
  if (subscription.registeredWorker === processor) return;
  subscription.registeredWorker = processor;
  processor.postMessage({
    operation: 'subscribe-canonical-dashboard',
    subscriptionId: subscription.id,
    sourceNames: subscription.sourceNames,
    context: subscription.context,
    pagination: subscription.pagination,
    emitCurrent: subscription.emitCurrent
  });
}

/**
 * Retains only the newest worker payload until the current microtask completes.
 * @param {ViewSubscription} subscription
 * @param {Record<string, import('./presenter.js').LogicalSourceInput>} sources
 */
function enqueueSubscriptionUpdate(subscription, sources) {
  subscription.latest = sources;
  for (const listener of subscription.listeners) cancelSubscriberFrame(listener);
  if (subscription.frame !== null) return;
  const flush = () => {
    subscription.frame = null;
    const latest = subscription.latest;
    subscription.latest = null;
    if (!latest || subscriptions.get(subscription.id) !== subscription) return;
    subscription.snapshot = latest;
    batch(() => {
      for (const listener of [...subscription.listeners]) {
        if (subscription.listeners.has(listener)) invokeSubscriber(() => listener.notify(latest));
      }
    });
  };
  if (typeof globalThis.requestAnimationFrame === 'function') {
    subscription.frame = globalThis.requestAnimationFrame(flush);
  } else {
    subscription.frame = 0;
    queueMicrotask(flush);
  }
}

/** @param {SubscriptionListener} listener @param {ViewSubscription} subscription @param {() => void} notify */
function scheduleSubscriber(listener, subscription, notify) {
  let scheduledFrame = 0;
  const flush = () => {
    if (listener.frame !== scheduledFrame) return;
    listener.frame = null;
    if (subscriptions.get(subscription.id) === subscription
        && subscription.listeners.has(listener)) {
      batch(() => invokeSubscriber(notify));
    }
  };
  if (typeof globalThis.requestAnimationFrame === 'function') {
    scheduledFrame = globalThis.requestAnimationFrame(flush);
    listener.frame = scheduledFrame;
  } else {
    listener.frame = 0;
    queueMicrotask(flush);
  }
}

/** @param {SubscriptionListener} listener */
function cancelSubscriberFrame(listener) {
  if (listener.frame !== null && typeof globalThis.cancelAnimationFrame === 'function') {
    globalThis.cancelAnimationFrame(listener.frame);
  }
  listener.frame = null;
}

/**
 * @template T
 * @param {Record<string, unknown>} request
 * @param {() => T} fallback
 * @param {boolean} [recoverWorkerError]
 * @param {AbortSignal} [signal]
 * @returns {T|Promise<T>}
 */
function processRequest(request, fallback, recoverWorkerError = true, signal) {
  if (signal?.aborted) {
    const cancellation = new Error('Data processing was cancelled.');
    cancellation.name = 'DataProcessingCancelledError';
    return Promise.reject(cancellation);
  }
  const processor = getWorker();
  if (!processor) return fallback();
  const id = ++nextRequestId;
  const result = new Promise((resolve, reject) => {
    const onAbort = () => {
      if (!pending.has(id)) return;
      processor.postMessage({ id: ++nextRequestId, operation: 'cancel-data-processing', ids: [id] });
    };
    pending.set(id, {
      resolve: (value) => resolve(/** @type {T} */ (value)),
      reject,
      cleanup: () => signal?.removeEventListener('abort', onAbort),
      processor
    });
    processor.postMessage({ id, ...request });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
  return recoverWorkerError ? result.catch(fallback) : result;
}

/** @returns {Worker | null} */
function getWorker() {
  if (worker) return worker;
  if (typeof Worker === 'undefined' || import.meta.url.startsWith('data:')) return null;
  worker = new Worker(new URL('./data-worker.js', import.meta.url), { type: 'module' });
  const processor = worker;
  worker.addEventListener('message', (event) => {
    if (typeof event.data?.subscriptionId === 'string') {
      const subscription = subscriptions.get(event.data.subscriptionId);
      if (subscription?.registeredWorker === processor
          && event.data.data && typeof event.data.data === 'object') {
        enqueueSubscriptionUpdate(subscription, event.data.data);
      } else if (subscription?.registeredWorker === processor
          && typeof event.data.error === 'string') {
        const error = new Error(event.data.error);
        for (const listener of [...subscription.listeners]) {
          if (subscription.listeners.has(listener) && listener.onError) {
            invokeSubscriber(() => listener.onError?.(error));
          }
        }
      }
      return;
    }
    const request = pending.get(event.data?.id);
    if (!request) return;
    pending.delete(event.data.id);
    request.cleanup();
    if (typeof event.data.error === 'string') {
      const error = new Error(event.data.error);
      if (event.data.cancelled) error.name = 'DataProcessingCancelledError';
      request.reject(error);
    } else {
      request.resolve(event.data.data);
    }
  });
  worker.addEventListener('error', (event) => {
    const failedWorker = processor;
    const error = new Error(event.message || 'Data worker failed.');
    rejectWorkerRequests(failedWorker, error);
    terminateWorkerSubscriptions(failedWorker, error);
    resetWorker(failedWorker);
  });
  for (const subscription of subscriptions.values()) registerSubscription(worker, subscription);
  return worker;
}

/** @param {Worker | null} processor */
function resetWorker(processor) {
  processor?.terminate();
  if (worker !== processor) return;
  worker = null;
  for (const subscription of subscriptions.values()) subscription.registeredWorker = null;
}

/** @param {Worker} processor @param {Error} error */
function terminateWorkerSubscriptions(processor, error) {
  for (const [id, subscription] of subscriptions) {
    if (subscription.registeredWorker !== processor) continue;
    subscriptions.delete(id);
    subscription.latest = null;
    subscription.snapshot = null;
    if (subscription.frame !== null && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(subscription.frame);
    }
    subscription.frame = null;
    for (const listener of [...subscription.listeners]) {
      cancelSubscriberFrame(listener);
      listener.cleanup();
      if (listener.onError) invokeSubscriber(() => listener.onError?.(error));
    }
    subscription.listeners.clear();
  }
}

/** @param {() => void} notify */
function invokeSubscriber(notify) {
  try {
    notify();
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
}
