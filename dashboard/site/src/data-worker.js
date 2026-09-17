import { tidy } from './data-operations.js';
import { summarizeTableColumns } from './table-summary-data.js';
import { clusterScatterPoints } from './scatter-clustering.js';
import { adaptDashboardSources } from './data/adapters/dashboard-sources.js';
import {
  ingestCachedGhAwJsonl,
  ingestDashboardSources,
  ingestNormalizedJson,
  isCachedGhAwJsonlCurrent,
  isNormalizedJsonCurrent
} from './data/ingest/coordinator.js';
import { normalize } from './data/normalize/index.js';
import { queryCanonicalViewSources } from './data/queries/view-sources.js';
import { compileDashboardViewPayloadQueries } from './data/queries/view-payload-compiler.js';
import { createDashboardQueryMemoization, dashboardQueryMemoizationKey } from './data/queries/memoization.js';
import { BROWSER_RETENTION_WINDOWS_MS } from './data/storage/retention.js';
import { DashboardQueryCancelledError, continuationRevision, executeDashboardQueries, paginateDashboardSources, resolveDashboardQuerySources } from './data/queries/declarative.js';
import { formatDataSize, startIngestionProgress } from './ingestion-progress.js';
import { loadDashboardSources } from './source-loader.js';
import { createDebug, debugShardLimit } from './debug.js';
import { withRetries } from './retry.js';

const debugIngestion = createDebug('data:ingestion');
const workerScope = typeof self !== 'undefined' && 'postMessage' in self ? self : null;

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
let dashboardActivated = false;
const dashboardQueryMemoization = createDashboardQueryMemoization();
/**
 * @typedef {{ sourceNames: string[], context: ReturnType<typeof dashboardContext>, requestContext: { githubUrlBase?: string, dashboardRepository?: string | null }, pagination: Record<string, { limit: number, continuationToken?: string }>, revision: number | null, emitted: boolean, pageId?: string, viewId?: string, routeParameters?: Record<string, string>, queryContext?: { filters?: Record<string, string[]>, search?: { fields: string[], query: string }, orderBy?: Array<{ field: string, direction?: 'asc'|'desc' }>, timeWindow?: { start?: string, end?: string } } }} DashboardSubscription
 */
/** @type {Map<string, DashboardSubscription>} */
const dashboardSubscriptions = new Map();
/** @type {Set<string>} */
const dirtyDashboardSubscriptions = new Set();
const SUBSCRIPTION_FLUSH_DELAY_MS = 50;
/** @type {ReturnType<typeof setTimeout> | null} */
let subscriptionFlushTimer = null;
let subscriptionFlushRunning = false;
let dashboardIngestionCount = 0;

const INGESTION_LOCK_WAIT_MESSAGE = 'Waiting for another dashboard ingestion to finish.';

function hasUnrenderedDashboardSubscription() {
  return [...dirtyDashboardSubscriptions].some((id) => dashboardSubscriptions.get(id)?.emitted === false);
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
 * @param {string} [viewId]
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
  viewId,
  dashboard = liveDashboard
) {
  dashboard ??= await loadActiveDashboard();
  if (signal?.aborted) throw new DashboardQueryCancelledError('dashboard queries were cancelled', 'aborted');
  const key = dashboardQueryMemoizationKey([
    [...requested].sort(),
    context,
    requestContext,
    pagination,
    pageId,
    routeParameters,
    queryContext,
    viewId
  ]);
  return dashboardQueryMemoization.get(dashboard.revision, key, async () => {
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
          queries: context.queries,
          views: context.views,
          viewId,
          sourceNames: requested
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
  });
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
  const hasUnrenderedSubscription = hasUnrenderedDashboardSubscription();
  if (subscriptionFlushRunning
      || dirtyDashboardSubscriptions.size === 0
      || (dashboardIngestionCount > 0 && !hasUnrenderedSubscription)) return;
  if (subscriptionFlushTimer !== null) clearTimeout(subscriptionFlushTimer);
  const delay = hasUnrenderedSubscription && dashboardIngestionCount === 0 ? 0 : SUBSCRIPTION_FLUSH_DELAY_MS;
  subscriptionFlushTimer = setTimeout(() => {
    subscriptionFlushTimer = null;
    void flushDashboardSubscriptions();
  }, delay);
}

async function flushDashboardSubscriptions() {
  if (subscriptionFlushRunning
      || (dashboardIngestionCount > 0 && !hasUnrenderedDashboardSubscription())) return;
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
      for (const id of ids) {
        const subscription = dashboardSubscriptions.get(id);
        if (!subscription) continue;
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
            subscription.viewId,
            dashboard
          );
          if (dashboardSubscriptions.get(id) === subscription && liveDashboard === dashboard) {
            subscription.emitted = true;
            subscription.revision = dashboard.revision;
            subscription.pagination = pagination;
            workerScope?.postMessage({ subscriptionId: id, data });
          }
        } catch (error) {
          if (dashboardSubscriptions.get(id) === subscription && liveDashboard === dashboard) {
            workerScope?.postMessage({
              subscriptionId: id,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }

      }
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

  const context = /** @type {{ githubUrlBase?: unknown, pages?: unknown, queries?: unknown, views?: unknown }} */ (value);
  if (!Array.isArray(context.pages)) {
    throw new TypeError('Canonical dashboard context requires pages.');
  }
  if (context.queries !== undefined && !Array.isArray(context.queries)) {
    throw new TypeError('Canonical dashboard queries must be an array.');
  }
  if (context.views !== undefined && !Array.isArray(context.views)) {
    throw new TypeError('Canonical dashboard views must be an array.');
  }
  return {
    githubUrlBase: typeof context.githubUrlBase === 'string' && context.githubUrlBase
      ? context.githubUrlBase : 'https://github.com',
    pages: /** @type {Array<{ id: string, kind: 'built-in' | 'custom', route?: { ['hash-query-parameter']?: string } }>} */ (context.pages),
    queries: /** @type {unknown[]} */ (context.queries ?? []),
    views: /** @type {unknown[]} */ (context.views ?? [])
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

/** @param {unknown} hashes */
export function publishedNormalizedShards(hashes) {
  if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes)) return [];
  return Object.entries(/** @type {Record<string, unknown>} */ (hashes))
    .filter(([name, hash]) => /^gh-aw-logs-normalized\/[a-f0-9]{64}-[a-f0-9]{16}\.json$/i.test(name)
      && typeof hash === 'string'
      && /^[a-f0-9]{64}$/i.test(hash))
    .map(([name, hash]) => ({ name, hash: /** @type {string} */ (hash).toLowerCase() }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * @param {{ operation?: unknown, data?: unknown, operators?: unknown, columns?: unknown, limit?: unknown, sources?: unknown, queries?: unknown, context?: unknown, sourceUrl?: unknown, sourceNames?: unknown, pagination?: unknown, reportActivation?: unknown, emitCurrent?: unknown, pageId?: unknown, viewId?: unknown, routeParameters?: unknown, queryContext?: unknown }} request
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
      queryContext(request.queryContext),
      typeof request.viewId === 'string' ? request.viewId : undefined
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
      dashboardIngestionCount += 1;
      const progress = startIngestionProgress();
      const activity = sourceUrl.pathname.endsWith('/payload-hashes.json');
      if (!activity) progress.start();
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
          const inventoryUrl = new URL('./inventory-sources.json', payloadHashesUrl);
          progress.log('Refreshing workflow and repository inventory.');
          const { response: inventoryResponse, value: inventorySources } = await withRetries(async () => {
            const response = await fetch(inventoryUrl, { cache: 'no-store' });
            if (!response.ok) {
              if (response.status === 404) return { response, value: {} };
              throw new Error(`Unable to load dashboard inventory sources: ${response.status}`);
            }
            return { response, value: await response.json() };
          });
          if (inventoryResponse.ok) {
            sources = inventorySources;
            progress.log('Inventory metadata refreshed.');
          } else {
            progress.log('No separate inventory metadata was published.');
          }
          progress.log('Checking the published payload identity.');
          const payloadHashesResponse = await fetch(payloadHashesUrl, { cache: 'no-store' }).catch(() => null);
          const payloadHashes = payloadHashesResponse?.ok
            ? await payloadHashesResponse.json().catch(() => null)
            : null;
          const normalizedShards = publishedNormalizedShards(payloadHashes);
          const publishedShards = normalizedShards.length > 0 ? normalizedShards : publishedJsonlShards(payloadHashes);
          const shardLimit = debugShardLimit();
          const shards = shardLimit === undefined ? publishedShards : publishedShards.slice(0, shardLimit);
          const normalized = normalizedShards.length > 0;
          const shardCount = shards.length;
          debugIngestion('loaded activity manifest', {
            source: sourceUrl.pathname,
            shardCount,
            shardLimit,
            manifestAvailable: payloadHashesResponse?.ok === true
          });
          if (shardCount > 0) {
            progress.log(`Published activity data includes ${shardCount.toLocaleString('en-US')} `
              + `${shardCount === 1 ? 'shard' : 'shards'}.`);
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
            throw new Error('Activity shard manifest is missing or contains no valid activity shards.');
          }
          /** @type {Array<{ index: number, shard: { name: string, hash: string }, shardUrl: URL, current: boolean, sizeBytes: number | undefined }>} */
          const shardStates = [];
          for (const [index, shard] of shards.entries()) {
            const shardUrl = new URL(`./${shard.name}`, payloadHashesUrl);
            const current = normalized
              ? await isNormalizedJsonCurrent(indexedDB, {
                  payloadIdentity: shard.hash,
                  payloadScope: shardUrl.href
                })
              : await isCachedGhAwJsonlCurrent(indexedDB, {
                  payloadIdentity: shard.hash,
                  payloadScope: shardUrl.href,
                  context: collectionContext,
                  workflowHints
                });
            shardStates.push({ index, shard, shardUrl, current, sizeBytes: undefined });
          }
          const pendingShards = shardStates.filter(({ current }) => !current);
          if (pendingShards.length > 0) {
            progress.start();
            progress.reportShardImportProgress(shardStates.length - pendingShards.length, shardCount);
          }
          await Promise.all(pendingShards.map(async (state) => {
            const response = await fetch(state.shardUrl, { method: 'HEAD' }).catch(() => null);
            const contentLength = response?.ok ? Number(response.headers.get('content-length')) : Number.NaN;
            state.sizeBytes = Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : undefined;
          }));
          const workloadBytes = pendingShards.every(({ sizeBytes }) => typeof sizeBytes === 'number')
            ? pendingShards.reduce((sum, { sizeBytes }) => sum + (sizeBytes ?? 0), 0)
            : undefined;
          progress.setWorkload(workloadBytes);
          let completedShardCount = shardStates.length - pendingShards.length;
          progress.reportShardImportProgress(completedShardCount, shardCount);
          if (completedShardCount > 0) {
            progress.log(`Reusing ${completedShardCount}/${shardCount} cached activity `
              + `${completedShardCount === 1 ? 'shard' : 'shards'}.`);
          }
          let processedBytes = 0;
          let processedRecords = 0;
          for (const { index, shard, shardUrl, current, sizeBytes } of shardStates) {
            if (current) {
              debugIngestion('skipping current activity shard', {
                shard: shard.name,
                index: index + 1,
                shardCount
              });
              continue;
            }
            progress.log(`Downloading shard ${index + 1}/${shardCount}.`);
            debugIngestion('fetching activity shard', {
              shard: shard.name,
              index: index + 1,
              shardCount
            });
            const response = await fetch(shardUrl);
            if (!response.ok) throw new Error(`Unable to load activity shard ${shard.name}: ${response.status}`);
            if (!normalized && !response.body) throw new Error(`Unable to stream activity shard ${shard.name}`);
            {
              const contentLengthHeader = response.headers.get('content-length');
              const contentLength = contentLengthHeader === null ? Number.NaN : Number(contentLengthHeader);
              const payloadBytes = sizeBytes ?? (Number.isFinite(contentLength) && contentLength >= 0
                ? contentLength
                : undefined);
              const compressed = response.headers.has('content-encoding');
              progress.log(payloadBytes === undefined
                ? `Shard ${index + 1} received; parsing.`
                : `Shard ${index + 1} received (${formatDataSize(payloadBytes)}`
                  + `${compressed ? ' compressed' : ''}); parsing.`);
              const ingestionOptions = {
                storage: globalThis.navigator?.storage,
                retentionWindowMsByStore: BROWSER_RETENTION_WINDOWS_MS,
                onWriteProgress: (/** @type {{ storedRecords: number, totalRecords: number }} */ written) => progress.store(written),
                onLockWait: () => progress.log(INGESTION_LOCK_WAIT_MESSAGE),
                payloadIdentity: shard.hash,
                payloadScope: shardUrl.href
              };
              const ingestion = normalized
                ? await ingestNormalizedJson(indexedDB, await response.json(), ingestionOptions)
                : await ingestCachedGhAwJsonl(indexedDB, responseChunks(/** @type {ReadableStream<Uint8Array>} */ (response.body)), {
                    ...ingestionOptions,
                    workflowHints,
                    onProgress: ({ bytesProcessed, recordsIngested }) => progress.update({
                      bytesProcessed: processedBytes + (compressed ? 0 : bytesProcessed),
                      recordsIngested: processedRecords + recordsIngested,
                      totalBytes: workloadBytes
                    }),
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
              progress.log(`Shard ${index + 1}/${shardCount} committed `
                + `${ingestion.committedRecords.toLocaleString('en-US')} rec.`);
              progress.update({
                bytesProcessed: processedBytes,
                recordsIngested: processedRecords,
                totalBytes: workloadBytes
              });
              completedShardCount += 1;
              progress.reportShardImportProgress(completedShardCount, shardCount);
            }
          }
          if (inventoryResponse.ok) {
            progress.log('Normalizing inventory metadata.');
            const inventoryIngestion = await ingestDashboardSources(indexedDB, sources, {
              storage: globalThis.navigator?.storage,
              retentionWindowMsByStore: BROWSER_RETENTION_WINDOWS_MS,
              payloadScope: inventoryUrl.href,
              onWriteProgress: (written) => progress.store(written),
              onLockWait: () => progress.log(INGESTION_LOCK_WAIT_MESSAGE)
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
            onWriteProgress: (written) => progress.store(written),
            onLockWait: () => progress.log(INGESTION_LOCK_WAIT_MESSAGE)
          });
          changed ||= ingestion.updated;
          progress.log('skipped' in ingestion && ingestion.skipped
            ? 'Dashboard source data is already current.'
            : `Dashboard ingestion committed ${ingestion.committedRecords} canonical records.`);
        }
        progress.log('Refreshing active dashboard queries.');
        const nextRevision = (liveDashboard?.revision ?? 0)
          + (!dashboardActivated || changed ? 1 : 0);
        liveDashboard = {
          logicalSources: /** @type {Record<string, import('./presenter.js').LogicalSourceInput>} */ (sources),
          revision: nextRevision
        };
        dashboardActivated = true;
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
          queryContext(request.queryContext),
          typeof request.viewId === 'string' ? request.viewId : undefined
        );
        return request.reportActivation
          ? { sources: projected, changed }
          : projected;
      } finally {
        progress.complete();
        dashboardIngestionCount = Math.max(0, dashboardIngestionCount - 1);
        if (dashboardIngestionCount === 0) scheduleDashboardSubscriptions(dirtyDashboardSubscriptions);
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

if (typeof document === 'undefined' && workerScope) {
  workerScope.addEventListener('message', (event) => {
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
        viewId: typeof event.data.viewId === 'string' ? event.data.viewId : undefined,
        routeParameters: routeParameters(event.data.routeParameters),
        queryContext: queryContext(event.data.queryContext),
        revision: liveDashboard?.revision ?? null,
        emitted: false
      });
      if (liveDashboard && event.data.emitCurrent !== false) {
        scheduleDashboardSubscriptions([subscriptionId]);
      }
      return;
    }
    if (event.data?.operation === 'unsubscribe-canonical-dashboard') {
      dashboardSubscriptions.delete(event.data.subscriptionId);
      dirtyDashboardSubscriptions.delete(event.data.subscriptionId);
      if (dirtyDashboardSubscriptions.size === 0 && subscriptionFlushTimer !== null) {
        clearTimeout(subscriptionFlushTimer);
        subscriptionFlushTimer = null;
      }
      return;
    }
    if (event.data?.operation === 'cancel-data-processing') {
      const cancelled = cancelInFlight(event.data.ids);
      workerScope.postMessage({ id, data: { cancelled } });
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
        workerScope.postMessage({ id, ...message });
      } catch (error) {
        workerScope.postMessage({ id, ...failure(error) });
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
