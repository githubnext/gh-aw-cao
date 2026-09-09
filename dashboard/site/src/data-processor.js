import { tidy } from './data-operations.js';
import { summarizeTableColumns } from './table-summary-data.js';
import { clusterScatterPoints } from './scatter-clustering.js';
import { deriveDataHealthSources } from './data-health.js';
import { adaptDashboardSources } from './data/adapters/dashboard-sources.js';
import { normalize } from './data/normalize/index.js';

/** @type {Worker | null} */
let worker = null;
let nextRequestId = 0;
/** @type {Map<number, { resolve: (value: unknown) => void, reject: (reason: Error) => void }>} */
const pending = new Map();

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
 * @returns {Promise<Record<string, import('./presenter.js').LogicalSourceInput>>}
 */
export function processDashboardQueries(queries, sources) {
  return /** @type {Promise<Record<string, import('./presenter.js').LogicalSourceInput>>} */ (processRequest(
    { operation: 'execute-dashboard-queries', queries, sources },
    () => Promise.reject(new Error('Declarative dashboard queries require a data worker.')),
    false
  ));
}

/**
 * Loads and hydrates the live canonical dashboard entirely in the data worker.
 * The main thread sends only a URL and receives the query projection needed by
 * the renderer.
 * @param {string} sourceUrl
 * @param {string[]} sourceNames
 * @param {{ githubUrlBase?: string, pages: unknown[] }} context
 * @returns {Promise<Record<string, import('./presenter.js').LogicalSourceInput>>}
 */
export function loadCanonicalDashboardSources(sourceUrl, sourceNames, context) {
  return /** @type {Promise<Record<string, import('./presenter.js').LogicalSourceInput>>} */ (processRequest(
    { operation: 'load-canonical-dashboard', sourceUrl, sourceNames, context },
    () => Promise.reject(new Error('Live canonical dashboard loading requires a data worker.')),
    false
  ));
}

/**
 * Queries one page from the live canonical dashboard retained by the worker.
 * @param {string[]} sourceNames
 * @param {{ githubUrlBase?: string, dashboardRepository?: string | null, pages: unknown[] }} context
 * @returns {Promise<Record<string, import('./presenter.js').LogicalSourceInput>>}
 */
export function loadCanonicalDashboardPage(sourceNames, context) {
  return /** @type {Promise<Record<string, import('./presenter.js').LogicalSourceInput>>} */ (processRequest(
    { operation: 'query-canonical-dashboard', sourceNames, context },
    () => Promise.reject(new Error('Live canonical dashboard queries require a data worker.')),
    false
  ));
}

/**
 * @template T
 * @param {Record<string, unknown>} request
 * @param {() => T} fallback
 * @param {boolean} [recoverWorkerError]
 * @returns {T|Promise<T>}
 */
function processRequest(request, fallback, recoverWorkerError = true) {
  const processor = getWorker();
  if (!processor) return fallback();
  const id = ++nextRequestId;
  const result = new Promise((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve(/** @type {T} */ (value)),
      reject
    });
    processor.postMessage({ id, ...request });
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
    if (typeof event.data.error === 'string') request.reject(new Error(event.data.error));
    else request.resolve(event.data.data);
  });
  worker.addEventListener('error', (event) => {
    for (const request of pending.values()) request.reject(new Error(event.message || 'Data worker failed.'));
    pending.clear();
    worker?.terminate();
    worker = null;
  });
  return worker;
}
