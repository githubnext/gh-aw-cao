import { tidy } from './data-operations.js';
import { summarizeTableColumns } from './table-summary-data.js';
import { clusterScatterPoints } from './scatter-clustering.js';
import { adaptDashboardSources } from './data/adapters/dashboard-sources.js';
import {
  ingestCachedGhAwJsonl,
  ingestDashboardSources,
  isCachedGhAwJsonlCurrent
} from './data/ingest/coordinator.js';
import { normalize } from './data/normalize/index.js';
import { queryCanonicalViewSources } from './data/queries/view-sources.js';
import { compileDashboardViewPayloadQueries } from './data/queries/view-payload-compiler.js';
import { BROWSER_RETENTION_WINDOWS_MS } from './data/storage/retention.js';
import { DashboardQueryCancelledError, continuationRevision, executeDashboardQueries, paginateDashboardSources, resolveDashboardQuerySources } from './data/queries/declarative.js';
import { createElapsedStepTracker } from './elapsed-step-tracker.js';
import { loadDashboardSources } from './source-loader.js';
import { createDebug } from './debug.js';

const debugIngestion = createDebug('data:ingestion');

/** @param {ReadableStream<Uint8Array>} body */
async function* responseChunks(body) {
  const reader = body.getReader();
  let completed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        return;
      }
      yield value;
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** @type {{ logicalSources: Record<string, import('./presenter.js').LogicalSourceInput>, revision: number } | null} */
let liveDashboard = null;
/**
 * @typedef {{ sourceNames: string[], context: ReturnType<typeof dashboardContext>, requestContext: { githubUrlBase?: string, dashboardRepository?: string | null }, pagination: Record<string, { limit: number, continuationToken?: string }>, revision: number | null, pageId?: string, routeParameters?: Record<string, string>, queryContext?: { filters?: Record<string, string[]>, search?: { fields: string[], query: string }, orderBy?: Array<{ field: string, direction?: 'asc'|'desc' }>, timeWindow?: { start?: string, end?: string } } }} DashboardSubscription
 */
/** @type {Map<string, DashboardSubscription>} */
const dashboardSubscriptions = new Map();
/** @type {Set<string>} */
const dirtyDashboardSubscriptions = new Set();
let subscriptionFlushScheduled = false;
let subscriptionFlushRunning = false;

/**
 * Publishes a user-facing notification from the data worker.
 * @param {{ id?: string, message?: string, tone?: 'info' | 'success' | 'warning' | 'error', duration?: number, details?: string[], dismiss?: boolean }} notification
 * @param {{ postMessage: (message: unknown) => void }} [target]
 */
export function publishWorkerNotification(notification, target = self) {
  target.postMessage({ type: 'notification', notification });
}

const INGESTION_PROGRESS_DELAY_MS = 3_000;
const INGESTION_PROGRESS_INTERVAL_MS = 1_000;
const INGESTION_PROGRESS_HISTORY_LIMIT = 100;
let nextIngestionProgressId = 0;

/**
 * Reports long-running ingestion status through the main-thread notification manager.
 * @param {{ postMessage: (message: unknown) => void }} [target]
 */
export function startIngestionProgress(target = self) {
  const id = `ingestion-progress-${++nextIngestionProgressId}`;
  const clock = createElapsedStepTracker('Preparing source data...', {
    historyLimit: INGESTION_PROGRESS_HISTORY_LIMIT
  });
  let completed = false;
  const report = () => {
    if (!completed) {
      const snapshot = clock.snapshot();
      publishWorkerNotification({
        id,
        message: snapshot.message,
        details: snapshot.history,
        tone: 'info',
        duration: 0
      }, target);
    }
  };
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let interval;
  const delay = setTimeout(() => {
    if (completed) return;
    report();
    interval = setInterval(report, INGESTION_PROGRESS_INTERVAL_MS);
  }, INGESTION_PROGRESS_DELAY_MS);
  return {
    /**
     * @param {{ bytesProcessed: number, recordsIngested: number, totalBytes?: number }} progress
     */
    update({ bytesProcessed, recordsIngested, totalBytes }) {
      const byteProgress = typeof totalBytes === 'number' && Number.isFinite(totalBytes) && totalBytes > 0
        ? `${formatDataSize(bytesProcessed)} of ${formatDataSize(totalBytes)}`
        : formatDataSize(bytesProcessed);
      clock.update(
        `Parsing activity data... ${recordsIngested.toLocaleString('en-US')} `
          + `${recordsIngested === 1 ? 'record' : 'records'}, ${byteProgress} read.`,
        'parsing'
      );
    },
    /**
     * Reports the storage phase, which dominates large ingestions and would
     * otherwise leave the notification frozen on the last parsed record count.
     * @param {{ storedRecords: number, totalRecords: number }} progress
     */
    store({ storedRecords, totalRecords }) {
      clock.update(
        `Storing data... ${storedRecords.toLocaleString('en-US')} of `
          + `${totalRecords.toLocaleString('en-US')} records stored.`,
        'storing'
      );
    },
    /** @param {string} nextMessage */
    log(nextMessage) {
      clock.advance(nextMessage);
    },
    complete() {
      if (completed) return;
      completed = true;
      clearTimeout(delay);
      if (interval) clearInterval(interval);
      publishWorkerNotification({ id, dismiss: true }, target);
    }
  };
}

/** @param {number} bytes */
function formatDataSize(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  const units = ['B', 'KB', 'MB', 'GB'];
  let scaled = value;
  let unit = units[0];
  for (let index = 1; index < units.length && scaled >= 1_000; index += 1) {
    scaled /= 1_000;
    unit = units[index];
  }
  const digits = scaled >= 10 || unit === 'B' ? 0 : 1;
  return `${scaled.toFixed(digits)} ${unit}`;
}

async function loadActiveDashboard() {
  if (liveDashboard) return liveDashboard;
  liveDashboard = {
    logicalSources: {},
    revision: 0
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
 * @param {string} [pageId]
 * @param {Record<string, string>} [routeParameters]
 * @param {{ filters?: Record<string, string[]>, timeWindow?: { start?: string, end?: string } }} [queryContext]
 * @param {typeof liveDashboard} [dashboard]
 */
async function queryLiveDashboard(
  requested,
  context,
  requestContext,
  signal,
  pagination = {},
  pageId,
  routeParameters,
  queryContext,
  dashboard = liveDashboard
) {
  dashboard ??= await loadActiveDashboard();
  const required = resolveDashboardQuerySources(context.queries, requested);
  const canonicalPayload = await queryCanonicalViewSources(
    indexedDB,
    dashboard.logicalSources,
    required
  );
  const page = pageId
    ? context.pages.find((candidate) => candidate?.id === pageId)
    : null;
  const viewPayload = page && pageId
    ? compileDashboardViewPayloadQueries(page, pageId, {
        routeParameters,
        queryContext,
        evaluatedAt: queryContext?.timeWindow?.end ?? latestCanonicalInstant(canonicalPayload),
        queries: context.queries
      })
    : { aliases: [], queries: [], replacedSources: [] };
  const replacedSources = new Set(viewPayload.replacedSources);
  const directRequests = new Set([...requested].filter((name) => !replacedSources.has(name)));
  const querySources = {
    ...canonicalPayload,
    ...executeDashboardQueries(context.queries, canonicalPayload, directRequests, { signal })
  };
  const viewAliases = viewPayload.queries.length > 0
    ? executeDashboardQueries(viewPayload.queries, querySources, viewPayload.aliases, { signal, pagination })
    : {};
  const selected = pageScopedSources(querySources, requested);
  const responseSources = { ...selected, ...viewAliases };
  return paginateDashboardSources(
    responseSources,
    /** @type {Record<string, { limit: number, continuationToken?: string }>} */ (pagination ?? {}),
    continuationRevision(context.queries, dashboard.revision)
  );
}

/** @param {Record<string, import('./presenter.js').LogicalSourceInput>} sources */
function latestCanonicalInstant(sources) {
  let latest = Number.NEGATIVE_INFINITY;
  for (const source of Object.values(sources)) {
    for (const value of [source.metadata?.['as-of'], source.metadata?.['retrieved-at']]) {
      const timestamp = Date.parse(String(value ?? ''));
      if (Number.isFinite(timestamp)) latest = Math.max(latest, timestamp);
    }
    for (const row of source.rows ?? []) {
      for (const field of ['observed-at', 'started-at', 'ended-at']) {
        const timestamp = Date.parse(String(row[field] ?? ''));
        if (Number.isFinite(timestamp)) latest = Math.max(latest, timestamp);
      }
    }
  }
  return Number.isFinite(latest) ? new Date(latest).toISOString() : undefined;
}

/** @param {Iterable<string>} [ids] */
function scheduleDashboardSubscriptions(ids = dashboardSubscriptions.keys()) {
  for (const id of ids) {
    if (dashboardSubscriptions.has(id)) dirtyDashboardSubscriptions.add(id);
  }
  if (subscriptionFlushScheduled || subscriptionFlushRunning || dirtyDashboardSubscriptions.size === 0) return;
  subscriptionFlushScheduled = true;
  queueMicrotask(() => {
    subscriptionFlushScheduled = false;
    void flushDashboardSubscriptions();
  });
}

async function flushDashboardSubscriptions() {
  if (subscriptionFlushRunning) return;
  subscriptionFlushRunning = true;
  try {
    while (dirtyDashboardSubscriptions.size > 0) {
      const ids = [...dirtyDashboardSubscriptions];
      dirtyDashboardSubscriptions.clear();
      const dashboard = liveDashboard;
      if (!dashboard) {
        for (const id of ids) dirtyDashboardSubscriptions.add(id);
        break;
      }
      await Promise.all(ids.map(async (id) => {
        const subscription = dashboardSubscriptions.get(id);
        if (!subscription) return;
        try {
          const pagination = subscription.revision === dashboard.revision
            ? subscription.pagination
            : resetPagination(subscription.pagination);
          const data = await queryLiveDashboard(
            new Set(subscription.sourceNames),
            subscription.context,
            subscription.requestContext,
            undefined,
            pagination,
            subscription.pageId,
            subscription.routeParameters,
            subscription.queryContext,
            dashboard
          );
          if (dashboardSubscriptions.get(id) === subscription && liveDashboard === dashboard) {
            subscription.revision = dashboard.revision;
            subscription.pagination = pagination;
            self.postMessage({ subscriptionId: id, data });
          }
        } catch (error) {
          if (dashboardSubscriptions.get(id) === subscription && liveDashboard === dashboard) {
            self.postMessage({
              subscriptionId: id,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }

      }));
    }

    /** @param {Record<string, { limit: number, continuationToken?: string }>} pagination */
    function resetPagination(pagination) {
      return Object.fromEntries(Object.entries(pagination).map(([source, request]) => [
        source,
        { limit: request.limit }
      ]));
    }
  } finally {
    subscriptionFlushRunning = false;
    if (liveDashboard) scheduleDashboardSubscriptions(dirtyDashboardSubscriptions);
  }
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
    pages: /** @type {Array<{ id: string, kind: 'built-in' | 'custom', route?: { ['hash-query-parameter']?: string } }>} */ (context.pages),
    queries: /** @type {unknown[]} */ (context.queries ?? [])
  };
}

/** @param {unknown} hashes */
export function publishedJsonlShards(hashes) {
  if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes)) return [];
  return Object.entries(/** @type {Record<string, unknown>} */ (hashes))
    .filter(([name, hash]) => /^gh-aw-logs-shards\/[a-zA-Z0-9._-]+\.jsonl$/.test(name)
      && typeof hash === 'string'
      && /^[a-f0-9]{64}$/i.test(hash))
    .map(([name, hash]) => ({ name, hash: /** @type {string} */ (hash).toLowerCase() }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * @param {{ operation?: unknown, data?: unknown, operators?: unknown, columns?: unknown, limit?: unknown, sources?: unknown, queries?: unknown, context?: unknown, sourceUrl?: unknown, sourceNames?: unknown, pagination?: unknown, reportActivation?: unknown, emitCurrent?: unknown, pageId?: unknown, routeParameters?: unknown, queryContext?: unknown }} request
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
      /** @type {Record<string, { limit: number, continuationToken?: string }>} */ (request.pagination ?? {}),
      typeof request.pageId === 'string' ? request.pageId : undefined,
      routeParameters(request.routeParameters),
      queryContext(request.queryContext)
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
      const progress = startIngestionProgress();
      const activity = sourceUrl.pathname.endsWith('/payload-hashes.json');
      let changed = false;
      try {
        progress.log(activity ? 'Loading ingestion metadata.' : 'Downloading dashboard source data.');
        let sources = activity ? {} : await loadDashboardSources(fetch, sourceUrl.href, {
          onShardLoaded: ({ name, sizeBytes, cacheStatus }) => {
            const size = sizeBytes === null ? 'size unavailable' : `${sizeBytes.toLocaleString()} bytes`;
            progress.log(`Loaded dashboard source shard ${name} (${size}; cache: ${cacheStatus ?? 'unavailable'}).`);
          }
        });
        if (activity) {
          const payloadHashesUrl = sourceUrl;
          progress.log('Checking the published payload identity.');
          const payloadHashesResponse = await fetch(payloadHashesUrl, { cache: 'no-store' }).catch(() => null);
          const payloadHashes = payloadHashesResponse?.ok
            ? await payloadHashesResponse.json().catch(() => null)
            : null;
          const shards = publishedJsonlShards(payloadHashes);
          const shardCount = shards.length;
          debugIngestion('loaded activity manifest', {
            source: sourceUrl.pathname,
            shardCount,
            manifestAvailable: payloadHashesResponse?.ok === true
          });
          if (shardCount > 0) {
            progress.log(`Published activity data includes ${shardCount.toLocaleString('en-US')} `
              + `${shardCount === 1 ? 'shard' : 'shards'}.`);
          }
          const inventoryUrl = new URL('./inventory-sources.json', payloadHashesUrl);
          progress.log('Loading workflow and repository inventory.');
          const inventoryResponse = await fetch(inventoryUrl);
          if (inventoryResponse.ok) {
            sources = await inventoryResponse.json();
            progress.log('Inventory metadata loaded.');
          } else if (inventoryResponse.status !== 404) {
            throw new Error(`Unable to load dashboard inventory sources: ${inventoryResponse.status}`);
          } else {
            progress.log('No separate inventory metadata was published.');
          }
          const workflowSource = sources.workflows && typeof sources.workflows === 'object'
            ? /** @type {{ rows?: unknown }} */ (sources.workflows)
            : null;
          const workflowRows = Array.isArray(workflowSource?.rows) ? workflowSource.rows : [];
          const workflowHints = workflowRows.flatMap((/** @type {unknown} */ candidate) => {
            if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
            const row = /** @type {Record<string, unknown>} */ (candidate);
            return typeof row.organization === 'string'
              && typeof row.repository === 'string'
              && typeof row['workflow-name'] === 'string'
              && typeof row.workflow === 'string'
              ? [{
                  owner: row.organization,
                  repository: row.repository,
                  name: row['workflow-name'],
                  path: row.workflow
                }]
              : [];
          });
          progress.log(`Prepared ${workflowHints.length} workflow ${workflowHints.length === 1 ? 'hint' : 'hints'} for normalization.`);
          const collectionContext = request.context && typeof request.context === 'object'
            ? /** @type {Record<string, unknown>} */ (request.context).collectionContext
            : undefined;
          if (shards.length === 0) {
            throw new Error('Activity shard manifest is missing or contains no valid JSONL shards.');
          }
          let processedBytes = 0;
          let processedRecords = 0;
          for (const [index, shard] of shards.entries()) {
            const shardUrl = new URL(`./${shard.name}`, payloadHashesUrl);
            const current = await isCachedGhAwJsonlCurrent(indexedDB, {
              payloadIdentity: shard.hash,
              payloadScope: shardUrl.href,
              context: collectionContext,
              workflowHints
            });
            if (current) {
              debugIngestion('skipping current activity shard', {
                shard: shard.name,
                index: index + 1,
                shardCount
              });
              continue;
            }
            progress.log(`Downloading activity shard ${index + 1} of ${shardCount}.`);
            debugIngestion('fetching activity shard', {
              shard: shard.name,
              index: index + 1,
              shardCount
            });
            const response = await fetch(shardUrl);
            if (!response.ok) throw new Error(`Unable to load activity shard ${shard.name}: ${response.status}`);
            if (!response.body) throw new Error(`Unable to stream activity shard ${shard.name}`);
            {
              const contentLengthHeader = response.headers.get('content-length');
              const contentLength = contentLengthHeader === null ? Number.NaN : Number(contentLengthHeader);
              const payloadBytes = Number.isFinite(contentLength) && contentLength >= 0
                ? contentLength
                : undefined;
              const compressed = response.headers.has('content-encoding');
              progress.log(payloadBytes === undefined
                ? `Activity shard ${index + 1} received; parsing records.`
                : `Activity shard ${index + 1} received (${formatDataSize(payloadBytes)}`
                  + `${compressed ? ' compressed' : ''}); parsing records.`);
              const ingestion = await ingestCachedGhAwJsonl(indexedDB, responseChunks(response.body), {
                storage: globalThis.navigator?.storage,
                retentionWindowMsByStore: BROWSER_RETENTION_WINDOWS_MS,
                workflowHints,
                onProgress: ({ bytesProcessed, recordsIngested }) => progress.update({
                  bytesProcessed: processedBytes + bytesProcessed,
                  recordsIngested: processedRecords + recordsIngested,
                  totalBytes: undefined
                }),
                onWriteProgress: (written) => progress.store(written),
                payloadIdentity: shard.hash,
                payloadScope: shardUrl.href,
                context: collectionContext
              });
              processedBytes += payloadBytes ?? 0;
              const sourceRecords = 'records' in ingestion ? ingestion.records : 0;
              processedRecords += sourceRecords;
              changed ||= ingestion.updated;
              debugIngestion('committed activity shard', {
                shard: shard.name,
                index: index + 1,
                shardCount,
                committedRecords: ingestion.committedRecords,
                sourceRecords
              });
              progress.log(`Activity shard ${index + 1} of ${shardCount} committed `
                + `${ingestion.committedRecords} canonical records.`);
            }
          }
          if (inventoryResponse.ok) {
            progress.log('Normalizing inventory metadata.');
            const inventoryIngestion = await ingestDashboardSources(indexedDB, sources, {
              storage: globalThis.navigator?.storage,
              retentionWindowMsByStore: BROWSER_RETENTION_WINDOWS_MS,
              payloadScope: inventoryUrl.href,
              onWriteProgress: (written) => progress.store(written)
            });
            changed ||= inventoryIngestion.updated;
            progress.log('skipped' in inventoryIngestion && inventoryIngestion.skipped
              ? 'Inventory metadata is already current.'
              : `Inventory ingestion committed ${inventoryIngestion.committedRecords} canonical records.`);
          }
        } else {
          progress.log('Normalizing dashboard source data.');
          const ingestion = await ingestDashboardSources(indexedDB, sources, {
            storage: globalThis.navigator?.storage,
            retentionWindowMsByStore: BROWSER_RETENTION_WINDOWS_MS,
            payloadScope: sourceUrl.href,
            onWriteProgress: (written) => progress.store(written)
          });
          changed ||= ingestion.updated;
          progress.log('skipped' in ingestion && ingestion.skipped
            ? 'Dashboard source data is already current.'
            : `Dashboard ingestion committed ${ingestion.committedRecords} canonical records.`);
        }
        progress.log('Refreshing active dashboard queries.');
        liveDashboard = {
          logicalSources: /** @type {Record<string, import('./presenter.js').LogicalSourceInput>} */ (sources),
          revision: (liveDashboard?.revision ?? 0) + 1
        };
        scheduleDashboardSubscriptions();
        progress.complete();
        const projected = await queryLiveDashboard(
          requested,
          context,
          /** @type {{ githubUrlBase?: string, dashboardRepository?: string | null }} */ (request.context ?? {}),
          signal,
          /** @type {Record<string, { limit: number, continuationToken?: string }>} */ (request.pagination ?? {}),
          typeof request.pageId === 'string' ? request.pageId : undefined,
          routeParameters(request.routeParameters),
          queryContext(request.queryContext)
        );
        return request.reportActivation
          ? { sources: projected, changed }
          : projected;
      } finally {
        progress.complete();
      }
    })();
  }
  if (request?.operation === 'execute-dashboard-queries') {
    if (!request.sources || typeof request.sources !== 'object' || Array.isArray(request.sources)) {
      throw new TypeError('Dashboard query requests require a sources object.');
    }
    if (!Array.isArray(request.queries)) {
      throw new TypeError('Dashboard query requests require a queries array.');
    }
    const requested = request.sourceNames === undefined
      ? undefined
      : requestedSourceNames(request.sourceNames);
    const querySources = executeDashboardQueries(
      request.queries,
      /** @type {Record<string, import('./presenter.js').LogicalSourceInput>} */ (request.sources),
      requested,
      {
        signal,
        pagination: /** @type {Record<string, { limit: number, continuationToken?: string }>} */ (request.pagination ?? {})
      }
    );
    return querySources;
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
  if (request?.operation === 'canonicalize-dashboard-sources') {
    if (!request.sources || typeof request.sources !== 'object' || Array.isArray(request.sources)) {
      throw new TypeError('Canonical source requests require a sources object.');
    }
    const adapted = adaptDashboardSources(/** @type {Record<string, unknown>} */ (request.sources));
    return normalize(adapted.observations);
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
    if (event.data?.operation === 'subscribe-canonical-dashboard') {
      const subscriptionId = event.data.subscriptionId;
      if (typeof subscriptionId !== 'string' || !subscriptionId.trim()) return;
      const context = dashboardContext(event.data.context);
      dashboardSubscriptions.set(subscriptionId, {
        sourceNames: [...requestedSourceNames(event.data.sourceNames)],
        context,
        requestContext: /** @type {{ githubUrlBase?: string, dashboardRepository?: string | null }} */ (event.data.context ?? {}),
        pagination: /** @type {Record<string, { limit: number, continuationToken?: string }>} */ (event.data.pagination ?? {}),
        pageId: typeof event.data.pageId === 'string' ? event.data.pageId : undefined,
        routeParameters: routeParameters(event.data.routeParameters),
        queryContext: queryContext(event.data.queryContext),
        revision: liveDashboard?.revision ?? null
      });
      if (liveDashboard && event.data.emitCurrent !== false) {
        scheduleDashboardSubscriptions([subscriptionId]);
      }
      return;
    }
    if (event.data?.operation === 'unsubscribe-canonical-dashboard') {
      dashboardSubscriptions.delete(event.data.subscriptionId);
      dirtyDashboardSubscriptions.delete(event.data.subscriptionId);
      return;
    }
    if (event.data?.operation === 'cancel-data-processing') {
      const cancelled = cancelInFlight(event.data.ids);
      self.postMessage({ id, data: { cancelled } });
      return;
    }
    const controller = new AbortController();
    inFlight.set(id, controller);
    /** @param {unknown} error */
    const failure = (error) => ({
      error: error instanceof Error ? error.message : String(error),
      cancelled: error instanceof DashboardQueryCancelledError
    });
    const settle = (/** @type {Record<string, unknown>} */ message) => {
      inFlight.delete(id);
      try {
        self.postMessage({ id, ...message });
      } catch (error) {
        self.postMessage({ id, ...failure(error) });
      }
    };
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

/** @param {unknown} value */
function routeParameters(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => typeof item === 'string')
    .map(([key, item]) => [key, String(item)]));
}

/** @param {unknown} value */
function queryContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const context = /** @type {{ filters?: unknown, search?: unknown, orderBy?: unknown, timeWindow?: unknown }} */ (value);
  const filters = context.filters && typeof context.filters === 'object' && !Array.isArray(context.filters)
    ? Object.fromEntries(Object.entries(context.filters)
      .map(([field, candidates]) => [field, Array.isArray(candidates)
        ? candidates.filter((item) => typeof item === 'string').map(String)
        : []])
      .filter(([, candidates]) => candidates.length > 0))
    : undefined;
  const rawSearch = context.search && typeof context.search === 'object' && !Array.isArray(context.search)
    ? /** @type {Record<string, unknown>} */ (context.search)
    : null;
  const searchFields = rawSearch && Array.isArray(rawSearch.fields)
    ? rawSearch.fields.filter((field) => typeof field === 'string' && field.trim()).map(String)
    : [];
  const searchQuery = rawSearch && typeof rawSearch.query === 'string' ? rawSearch.query.trim() : '';
  const search = searchQuery && searchFields.length > 0 ? { fields: searchFields, query: searchQuery } : undefined;
  const orderBy = Array.isArray(context.orderBy)
    ? context.orderBy.flatMap((ordering) => {
        if (!ordering || typeof ordering !== 'object' || Array.isArray(ordering)) return [];
        const candidate = /** @type {Record<string, unknown>} */ (ordering);
        if (typeof candidate.field !== 'string' || !candidate.field.trim()) return [];
        const direction = candidate.direction === 'asc' || candidate.direction === 'desc'
          ? /** @type {'asc'|'desc'} */ (candidate.direction)
          : undefined;
        return [{ field: candidate.field, ...(direction ? { direction } : {}) }];
      })
    : [];
  const rawTimeWindow = context.timeWindow && typeof context.timeWindow === 'object' && !Array.isArray(context.timeWindow)
    ? /** @type {Record<string, unknown>} */ (context.timeWindow)
    : null;
  const timeWindow = rawTimeWindow
    ? {
        start: typeof rawTimeWindow.start === 'string' ? rawTimeWindow.start : undefined,
        end: typeof rawTimeWindow.end === 'string' ? rawTimeWindow.end : undefined
      }
    : undefined;
  return {
    ...(filters ? { filters } : {}),
    ...(search ? { search } : {}),
    ...(orderBy.length > 0 ? { orderBy } : {}),
    ...(timeWindow?.start || timeWindow?.end ? { timeWindow } : {})
  };
}
