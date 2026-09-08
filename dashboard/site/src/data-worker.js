import { tidy } from './data-operations.js';
import { summarizeTableColumns } from './table-summary-data.js';
import { clusterScatterPoints } from './scatter-clustering.js';
import { deriveDataHealthSources } from './data-health.js';

/**
 * @param {{ operation?: unknown, data?: unknown, operators?: unknown, columns?: unknown, limit?: unknown, sources?: unknown, context?: unknown }} request
 * @returns {unknown}
 */
export function processDataRequest(request) {
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
  if (!Array.isArray(request?.data) || !Array.isArray(request?.operators)) {
    throw new TypeError('Data worker requests require data and operators arrays.');
  }
  return tidy(request.data, request.operators);
}

if (typeof document === 'undefined' && typeof self !== 'undefined' && 'postMessage' in self) {
  self.addEventListener('message', (event) => {
    const id = event.data?.id;
    try {
      self.postMessage({ id, data: processDataRequest(event.data) });
    } catch (error) {
      self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
