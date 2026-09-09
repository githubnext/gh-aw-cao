import { tidy } from './data-operations.js';
import { summarizeTableColumns } from './table-summary-data.js';
import { clusterScatterPoints } from './scatter-clustering.js';
import { deriveDataHealthSources } from './data-health.js';
import { adaptDashboardSources } from './data/adapters/dashboard-sources.js';
import { normalize } from './data/normalize/index.js';

/** Milliseconds a cooperative cancellation is given before the worker is terminated. */
const CANCELLATION_GRACE_MS = 250;

/** @type {Worker | null} */
let worker = null;
let nextRequestId = 0;
/** @type {Map<number, { resolve: (value: unknown) => void, reject: (reason: Error) => void }>} */
const pending = new Map();

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
  setTimeout(() => {
    if (!ids.some((id) => pending.has(id))) return;
    for (const id of ids) {
      pending.get(id)?.reject(cancellation);
      pending.delete(id);
    }
    processor?.terminate();
    if (worker === processor) worker = null;
  }, CANCELLATION_GRACE_MS);
  return ids.length;
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
 * @param {string} generation
 * @returns {import('./data/model/schema.js').CanonicalBatch|Promise<import('./data/model/schema.js').CanonicalBatch>}
 */
export function processCanonicalDashboardSources(sources, generation) {
  return normalize(adaptDashboardSources(sources).observations, { generation });
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
 * Refreshes the canonical dashboard and reports whether ingestion activated a
 * changed generation or hydrated transient published sources after reload.
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
 * @param {{ githubUrlBase?: string, dashboardRepository?: string | null, pages: unknown[] }} context
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
 * @template T
 * @param {Record<string, unknown>} request
 * @param {() => T} fallback
 * @param {boolean} [recoverWorkerError]
 * @param {AbortSignal} [signal]
 * @returns {T|Promise<T>}
 */
function processRequest(request, fallback, recoverWorkerError = true, signal) {
  const processor = getWorker();
  if (!processor) return fallback();
  const id = ++nextRequestId;
  const result = new Promise((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve(/** @type {T} */ (value)),
      reject
    });
    processor.postMessage({ id, ...request });
    const onAbort = () => {
      if (pending.has(id)) processor.postMessage({ id: ++nextRequestId, operation: 'cancel-data-processing', ids: [id] });
    };
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
  worker.addEventListener('message', (event) => {
    const request = pending.get(event.data?.id);
    if (!request) return;
    pending.delete(event.data.id);
    if (typeof event.data.error === 'string') {
      const error = new Error(event.data.error);
      if (event.data.cancelled) error.name = 'DataProcessingCancelledError';
      request.reject(error);
    } else {
      request.resolve(event.data.data);
    }
  });
  worker.addEventListener('error', (event) => {
    for (const request of pending.values()) request.reject(new Error(event.message || 'Data worker failed.'));
    pending.clear();
    worker?.terminate();
    worker = null;
  });
  return worker;
}
