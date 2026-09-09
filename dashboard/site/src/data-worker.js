import { tidy } from './data-operations.js';
import { summarizeTableColumns } from './table-summary-data.js';
import { clusterScatterPoints } from './scatter-clustering.js';
import { deriveDataHealthSources } from './data-health.js';
import { adaptDashboardSources } from './data/adapters/dashboard-sources.js';
import { ingestDashboardSources } from './data/ingest/coordinator.js';
import { normalize } from './data/normalize/index.js';
import { queryCanonicalViewSources } from './data/queries/view-sources.js';
import { activeGenerationMetadata } from './data/storage/indexeddb.js';
import { DashboardQueryCancelledError, continuationRevision, executeDashboardQueries, paginateDashboardSources, resolveDashboardQuerySources } from './data/queries/declarative.js';
import { loadDashboardSources } from './source-loader.js';
import { deriveOverviewSources } from './overview-data.js';
import { deriveRepositorySources } from './repository-data.js';
import { deriveRuntimeSources } from './runtime-data.js';
import { deriveWorkflowSources } from './workflow-data.js';
import { deriveDashboardLinkSources } from './inferred-sources.js';

/** @type {{ logicalSources: Record<string, import('./presenter.js').LogicalSourceInput>, generation: string } | null} */
let liveDashboard = null;

async function loadActiveDashboard() {
  if (liveDashboard) return liveDashboard;
  const active = await activeGenerationMetadata(indexedDB);
  if (!active) throw new Error('Canonical dashboard data has not been loaded.');
  liveDashboard = {
    logicalSources: {},
    generation: active.generation
  };
  return liveDashboard;
}

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
  return Object.fromEntries(Object.entries(sources).filter(([name]) => requested.has(name)));
}

/**
 * @param {Set<string>} requested
 * @param {ReturnType<typeof dashboardContext>} context
 * @param {{ githubUrlBase?: string, dashboardRepository?: string | null }} requestContext
 * @param {{ aborted?: boolean }} [signal]
 * @param {Record<string, { limit: number, continuationToken?: string }>} [pagination]
 */
async function queryLiveDashboard(requested, context, requestContext, signal, pagination = {}) {
  const dashboard = await loadActiveDashboard();
  const required = resolveDashboardQuerySources(context.queries, requested);
  const canonicalPayload = await queryCanonicalViewSources(
    indexedDB,
    dashboard.logicalSources,
    dashboard.generation,
    required
  );
  const hasPublishedSources = Object.keys(dashboard.logicalSources).length > 0;
  if (!hasPublishedSources) {
    return paginateDashboardSources(
      deriveDashboardLinkSources(pageScopedSources(canonicalPayload, requested), context),
      /** @type {Record<string, { limit: number, continuationToken?: string }>} */ (pagination ?? {}),
      continuationRevision(context.queries, dashboard.generation)
    );
  }
  const derivedSources = deriveRuntimeSources(
    deriveRepositorySources(
      deriveOverviewSources(
        deriveWorkflowSources({ ...dashboard.logicalSources, ...canonicalPayload })
      )
    )
  );
  const healthSources = [...requested].some((name) => name.startsWith('data-health-'))
    ? { ...derivedSources, ...deriveDataHealthSources(derivedSources, requestContext) }
    : derivedSources;
  const querySources = {
    ...healthSources,
    ...executeDashboardQueries(context.queries, healthSources, requested, { signal })
  };
  return paginateDashboardSources(
    deriveDashboardLinkSources(pageScopedSources(querySources, requested), context),
    /** @type {Record<string, { limit: number, continuationToken?: string }>} */ (pagination ?? {}),
    continuationRevision(context.queries, dashboard.generation)
  );
}

/** @param {unknown} value */
function dashboardContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Canonical dashboard queries require a dashboard context.');
  }
  const context = /** @type {{ githubUrlBase?: unknown, pages?: unknown, queries?: unknown }} */ (value);
  if (!Array.isArray(context.pages)) {
    throw new TypeError('Canonical dashboard context requires pages.');
  }
  if (context.queries !== undefined && !Array.isArray(context.queries)) {
    throw new TypeError('Canonical dashboard queries must be an array.');
  }
  return {
    githubUrlBase: typeof context.githubUrlBase === 'string' && context.githubUrlBase
      ? context.githubUrlBase : 'https://github.com',
    pages: /** @type {import('./inferred-sources.js').DashboardPage[]} */ (context.pages),
    queries: /** @type {unknown[]} */ (context.queries ?? [])
  };
}

/**
 * @param {{ operation?: unknown, data?: unknown, operators?: unknown, columns?: unknown, limit?: unknown, sources?: unknown, queries?: unknown, context?: unknown, generation?: unknown, sourceUrl?: unknown, sourceNames?: unknown, pagination?: unknown, reportActivation?: unknown }} request
 * @param {{ aborted?: boolean }} [signal] cancels declarative query execution
 * @returns {unknown}
 */
export function processDataRequest(request, signal) {
  if (request?.operation === 'query-canonical-dashboard') {
    const requested = requestedSourceNames(request.sourceNames);
    const context = dashboardContext(request.context);
    return queryLiveDashboard(
      requested,
      context,
      /** @type {{ githubUrlBase?: string, dashboardRepository?: string | null }} */ (request.context ?? {}),
      signal,
      /** @type {Record<string, { limit: number, continuationToken?: string }>} */ (request.pagination ?? {})
    );
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
    const context = dashboardContext(request.context);
    return (async () => {
      const hadPublishedSources = Object.keys(liveDashboard?.logicalSources ?? {}).length > 0;
      const sources = await loadDashboardSources(fetch, sourceUrl.href);
      const { generation, activated } = await ingestDashboardSources(indexedDB, sources, {
        storage: globalThis.navigator?.storage
      });
      liveDashboard = {
        logicalSources: /** @type {Record<string, import('./presenter.js').LogicalSourceInput>} */ (sources),
        generation
      };
      const projected = await queryLiveDashboard(
        requested,
        context,
        /** @type {{ githubUrlBase?: string, dashboardRepository?: string | null }} */ (request.context ?? {}),
        signal,
        /** @type {Record<string, { limit: number, continuationToken?: string }>} */ (request.pagination ?? {})
      );
      return request.reportActivation
        ? { sources: projected, changed: activated || !hadPublishedSources }
        : projected;
    })();
  }
  if (request?.operation === 'execute-dashboard-queries') {
    if (!request.sources || typeof request.sources !== 'object' || Array.isArray(request.sources)) {
      throw new TypeError('Dashboard query requests require a sources object.');
    }
    if (!Array.isArray(request.queries)) {
      throw new TypeError('Dashboard query requests require a queries array.');
    }
    return executeDashboardQueries(
      request.queries,
      /** @type {Record<string, import('./presenter.js').LogicalSourceInput>} */ (request.sources),
      undefined,
      {
        signal,
        pagination: /** @type {Record<string, { limit: number, continuationToken?: string }>} */ (request.pagination ?? {})
      }
    );
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

/** @type {Map<number, AbortController>} */
const inFlight = new Map();

/**
 * Cancels the identified in-flight requests, or every in-flight request when
 * no identifier is supplied.
 * @param {unknown} ids
 */
function cancelInFlight(ids) {
  const targets = Array.isArray(ids) && ids.length
    ? ids.filter((id) => inFlight.has(/** @type {number} */ (id)))
    : [...inFlight.keys()];
  for (const id of targets) inFlight.get(/** @type {number} */ (id))?.abort();
  return targets.length;
}

if (typeof document === 'undefined' && typeof self !== 'undefined' && 'postMessage' in self) {
  self.addEventListener('message', (event) => {
    const id = event.data?.id;
    if (event.data?.operation === 'cancel-data-processing') {
      const cancelled = cancelInFlight(event.data.ids);
      self.postMessage({ id, data: { cancelled } });
      return;
    }
    const controller = new AbortController();
    inFlight.set(id, controller);
    const settle = (/** @type {Record<string, unknown>} */ message) => {
      inFlight.delete(id);
      self.postMessage({ id, ...message });
    };
    /** @param {unknown} error */
    const failure = (error) => ({
      error: error instanceof Error ? error.message : String(error),
      cancelled: error instanceof DashboardQueryCancelledError
    });
    try {
      Promise.resolve(processDataRequest(event.data, controller.signal)).then(
        (data) => settle({ data }),
        (error) => settle(failure(error))
      );
    } catch (error) {
      settle(failure(error));
    }
  });
}
