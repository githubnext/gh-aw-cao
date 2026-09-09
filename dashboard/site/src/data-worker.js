import { tidy } from './data-operations.js';
import { summarizeTableColumns } from './table-summary-data.js';
import { clusterScatterPoints } from './scatter-clustering.js';
import { deriveDataHealthSources } from './data-health.js';
import { adaptDashboardSources } from './data/adapters/dashboard-sources.js';
import { ingestDashboardSources } from './data/ingest/coordinator.js';
import { normalize } from './data/normalize/index.js';
import { projectCanonicalViewSources } from './data/queries/view-sources.js';
import { loadDashboardSources } from './source-loader.js';
import { deriveOverviewSources } from './overview-data.js';
import { deriveRepositorySources } from './repository-data.js';
import { deriveRuntimeSources } from './runtime-data.js';
import { deriveWorkflowSources } from './workflow-data.js';

/** @type {Record<string, import('./presenter.js').LogicalSourceInput> | null} */
let liveDashboardSources = null;

/**
 * @param {unknown} sourceNames
 * @returns {Set<string>}
 */
function requestedSourceNames(sourceNames) {
  if (!Array.isArray(sourceNames) || sourceNames.some((name) => typeof name !== 'string')) {
    throw new TypeError('Canonical dashboard source names must be an array of strings.');
  }
  return new Set(sourceNames);
}

/**
 * @param {Record<string, import('./presenter.js').LogicalSourceInput>} sources
 * @param {Set<string>} requested
 */
function pageScopedSources(sources, requested) {
  return Object.fromEntries(Object.entries(sources).flatMap(([name, source]) => {
    if (requested.has(name)) return [[name, source]];
    return source?.metadata ? [[name, { source: name, rows: [], metadata: source.metadata }]] : [];
  }));
}

/**
 * @param {{ operation?: unknown, data?: unknown, operators?: unknown, columns?: unknown, limit?: unknown, sources?: unknown, context?: unknown, generation?: unknown, sourceUrl?: unknown, sourceNames?: unknown }} request
 * @returns {unknown}
 */
export function processDataRequest(request) {
  if (request?.operation === 'query-canonical-dashboard') {
    const requested = requestedSourceNames(request.sourceNames);
    if (!liveDashboardSources) throw new Error('Canonical dashboard data has not been loaded.');
    const requiresDataHealth = [...requested].some((name) => name.startsWith('data-health-'));
    const querySources = requiresDataHealth
      ? {
          ...liveDashboardSources,
          ...deriveDataHealthSources(
            liveDashboardSources,
            /** @type {{ githubUrlBase?: string, dashboardRepository?: string | null }} */ (request.context ?? {})
          )
        }
      : liveDashboardSources;
    return pageScopedSources(querySources, requested);
  }
  if (request?.operation === 'load-canonical-dashboard') {
    if (typeof request.sourceUrl !== 'string' || !request.sourceUrl.trim()) {
      throw new TypeError('Canonical dashboard loading requires a source URL.');
    }
    const sourceUrl = new URL(request.sourceUrl);
    if (!['http:', 'https:'].includes(sourceUrl.protocol)) {
      throw new TypeError('Canonical dashboard source URL must use HTTP or HTTPS.');
    }
    if (typeof globalThis.location?.origin === 'string'
        && globalThis.location.origin !== 'null'
        && sourceUrl.origin !== globalThis.location.origin) {
      throw new TypeError('Canonical dashboard source URL must be same-origin.');
    }
    const requested = requestedSourceNames(request.sourceNames);
    return (async () => {
      const sources = await loadDashboardSources(fetch, sourceUrl.href);
      const { generation } = await ingestDashboardSources(indexedDB, sources, {
        storage: globalThis.navigator?.storage
      });
      const canonicalSources = await projectCanonicalViewSources(indexedDB, sources, generation);
      liveDashboardSources = deriveRuntimeSources(
        deriveRepositorySources(deriveOverviewSources(deriveWorkflowSources(canonicalSources)))
      );
      return pageScopedSources(liveDashboardSources, requested);
    })();
  }
  if (request?.operation === 'summarize-table-columns') {
    if (!Array.isArray(request.columns)) {
      throw new TypeError('Table summary requests require a columns array.');
    }
    return summarizeTableColumns(request.columns);
  }
  if (request?.operation === 'cluster-scatter-points') {
    if (!Array.isArray(request.data)) {
      throw new TypeError('Scatter clustering requests require a data array.');
    }
    const limit = Number(request.limit);
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError('Scatter clustering requests require a positive integer limit.');
    }
    return clusterScatterPoints(request.data, limit);
  }
  if (request?.operation === 'derive-data-health') {
    if (!request.sources || typeof request.sources !== 'object' || Array.isArray(request.sources)) {
      throw new TypeError('Data health requests require a sources object.');
    }
    if (request.context !== undefined && (!request.context || typeof request.context !== 'object' || Array.isArray(request.context))) {
      throw new TypeError('Data health requests require an object context.');
    }
    return deriveDataHealthSources(
      /** @type {Record<string, import('./presenter.js').LogicalSourceInput>} */ (request.sources),
      /** @type {{ githubUrlBase?: string, dashboardRepository?: string | null }} */ (request.context ?? {})
    );
  }
  if (request?.operation === 'canonicalize-dashboard-sources') {
    if (!request.sources || typeof request.sources !== 'object' || Array.isArray(request.sources)) {
      throw new TypeError('Canonical source requests require a sources object.');
    }
    if (typeof request.generation !== 'string' || !request.generation.trim()) {
      throw new TypeError('Canonical source requests require a generation.');
    }
    const adapted = adaptDashboardSources(/** @type {Record<string, unknown>} */ (request.sources));
    if (adapted.generation !== request.generation) {
      throw new TypeError('Canonical source generation changed during processing.');
    }
    return normalize(adapted.observations, { generation: request.generation });
  }
  if (!Array.isArray(request?.data) || !Array.isArray(request?.operators)) {
    throw new TypeError('Data worker requests require data and operators arrays.');
  }
  return tidy(request.data, request.operators);
}

if (typeof document === 'undefined' && typeof self !== 'undefined' && 'postMessage' in self) {
  self.addEventListener('message', (event) => {
    const id = event.data?.id;
    try {
      Promise.resolve(processDataRequest(event.data)).then(
        (data) => self.postMessage({ id, data }),
        (error) => self.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
      );
    } catch (error) {
      self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
