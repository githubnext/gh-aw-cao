import { tidy } from './data-operations.js';
import { summarizeTableColumns } from './table-summary-data.js';
import { clusterScatterPoints } from './scatter-clustering.js';
import { queryDashboardSourceObservations } from './data/queries/ingestion.js';
import {
  finalizeNormalizedJsonlIngestion,
  ingestDashboardSources,
  ingestNormalizedJsonl,
  isNormalizedJsonCurrent,
  NORMALIZED_JSONL_INGESTION_VERSION
} from './data/ingest/coordinator.js';
import { normalize } from './data/normalize/index.js';
import {
  queryDatabaseSources,
  queryIndexedDatabaseSources
} from './data/queries/database.js';
import { relationshipErrors } from './data/model/schema.js';
import {
  DATABASE_VERSION,
  ENTITY_STORES,
  readCollections
} from './data/storage/indexeddb.js';
import { queryDailyOverviewAggregateSources } from './data/queries/daily-aggregate-fast-path.js';
import { compileDashboardViewPayloadQueries } from './data/queries/view-payload-compiler.js';
import { BROWSER_RETENTION_WINDOWS_MS } from './data/storage/retention.js';
import { DashboardQueryCancelledError, continuationRevision, executeDashboardQueries, paginateDashboardSources, resolveDashboardQuerySources } from './data/queries/declarative.js';
import { deriveDataHealthCalloutSources } from './data-health.js';
import { formatDataSize, startIngestionProgress } from './ingestion-progress.js';
import { loadDashboardSources } from './source-loader.js';
import { createDebug, debugEagerIngest, debugShardLimit } from './debug.js';
import { withRetries } from './retry.js';

const debugIngestion = createDebug('data:ingestion');
const debugPerformance = createDebug('data:performance');
/**
 * Forces every published activity shard to be ingested before results are
 * published, so diagnostics and measurement runs observe a fully ingested
 * canonical database instead of run-phase-only data.
 */
const eagerIngest = debugEagerIngest();
if (eagerIngest) debugIngestion('eager ingestion requested', { eagerIngest });
const monotonicNow = () => globalThis.performance?.now() ?? Date.now();
const workerScope = typeof self !== 'undefined' && 'postMessage' in self ? self : null;

/** Returns one self-contained database diagnostics payload to the main thread. */
async function collectCanonicalDatabaseDiagnostics() {
  const records = await readCollections(indexedDB, ENTITY_STORES);
  return {
    schemaVersion: DATABASE_VERSION,
    counts: Object.fromEntries(
      ENTITY_STORES.map((store) => [store, records[store].length])
    ),
    relationshipErrors: relationshipErrors(
      /** @type {import('./data/model/schema.js').CanonicalBatch} */ (records)
    ),
    duplicateRecordIds: Object.fromEntries(ENTITY_STORES.map((store) => [store, []]))
  };
}

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
let runPhaseOnly = false;
/**
 * @typedef {{ sourceNames: string[], context: ReturnType<typeof dashboardContext>, requestContext: { githubUrlBase?: string, dashboardRepository?: string | null }, pagination: Record<string, { limit: number, continuationToken?: string }>, revision: number | null, emitted: boolean, pageId?: string, viewId?: string, routeParameters?: Record<string, string>, queryContext?: { filters?: Record<string, string[]>, search?: { fields: string[], query: string }, orderBy?: Array<{ field: string, direction?: 'asc'|'desc' }>, timeWindow?: { start?: string, end?: string }, viewMode?: 'chart'|'table'|'card' } }} DashboardSubscription
 */
/** @type {Map<string, DashboardSubscription>} */
const dashboardSubscriptions = new Map();
/** @type {Map<number, Record<string, unknown>>} */
const inFlightDashboardSources = new Map();
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

const RUN_PHASE_DATABASE_SOURCES = new Set(['campaigns', 'repositories', 'workflows', 'runs']);

/** @param {{ sourceNames: string[], context: ReturnType<typeof dashboardContext> }} subscription */
function isRunPhaseSubscription(subscription) {
  const queryNames = new Set(subscription.context.queries
    .filter((definition) => definition && typeof definition === 'object' && !Array.isArray(definition))
    .map((definition) => /** @type {{ name?: unknown }} */ (definition).name)
    .filter((name) => typeof name === 'string'));
  return resolveDashboardQuerySources(subscription.context.queries, subscription.sourceNames)
    .filter((name) => !queryNames.has(name))
    .every((name) => RUN_PHASE_DATABASE_SOURCES.has(name));
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
 * @param {{ filters?: Record<string, string[]>, timeWindow?: { start?: string, end?: string }, viewMode?: 'chart'|'table'|'card' }} [queryContext]
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
  const startedAt = monotonicNow();
    const nativeSources = await queryIndexedDatabaseSources(
      indexedDB,
      dashboard.logicalSources,
      context.queries,
      requested
    );
    const nativeSourceNames = new Set(Object.keys(nativeSources));
    const nonNativeRequested = [...requested].filter((name) => !nativeSourceNames.has(name));
    // The daily-aggregate fast path only ever satisfies a query name when its
    // live definition still matches a known-safe additive shape (spec §72.6);
    // any query it does not recognize, or whose materialized projection is
    // unavailable, is simply absent here and falls through to the canonical
    // path below unchanged.
    const dailyAggregateSources = await queryDailyOverviewAggregateSources(
      indexedDB,
      context.queries,
      nonNativeRequested
    );
    const dailyAggregateSourceNames = new Set(Object.keys(dailyAggregateSources));
    const required = resolveDashboardQuerySources(
      context.queries,
      nonNativeRequested.filter((name) => !dailyAggregateSourceNames.has(name))
    );
    /** @type {{ databaseMs: number, projectionMs: number, totalMs: number, recordsRead: number, stores: string[] } | undefined} */
    let databaseMetrics;
    const databasePayload = await queryDatabaseSources(
      indexedDB,
      dashboard.logicalSources,
      required,
      { onMetrics: (metrics) => { databaseMetrics = metrics; } }
    );
    const healthPayload = required.some((name) => (
      name === 'data-health-collections' || name === 'data-health-coverage'
    ))
      ? deriveDataHealthCalloutSources(databasePayload)
      : {};
    const page = pageId
      ? context.pages.find((candidate) => candidate?.id === pageId)
      : null;
    const viewPayload = page && pageId
      ? compileDashboardViewPayloadQueries(page, pageId, {
          routeParameters,
          queryContext,
          evaluatedAt: queryContext?.timeWindow?.end ?? latestCanonicalInstant(databasePayload),
          queries: context.queries,
          views: context.views,
          viewId,
          sourceNames: nonNativeRequested.filter((name) => !dailyAggregateSourceNames.has(name))
        })
      : { aliases: [], queries: [], replacedSources: [] };
    const replacedSources = new Set(viewPayload.replacedSources);
    const directRequests = new Set([...requested].filter((name) => (
      !replacedSources.has(name) && !nativeSourceNames.has(name) && !dailyAggregateSourceNames.has(name)
    )));
    const querySources = {
      ...databasePayload,
      ...healthPayload,
      ...nativeSources,
      ...dailyAggregateSources,
      ...executeDashboardQueries(
        context.queries,
        { ...databasePayload, ...healthPayload },
        directRequests,
        { signal }
      )
    };
    const viewAliases = viewPayload.queries.length > 0
      ? executeDashboardQueries(viewPayload.queries, querySources, viewPayload.aliases, { signal })
      : {};
    const selected = pageScopedSources(querySources, requested);
    const responseSources = { ...selected, ...viewAliases };
    const response = paginateDashboardSources(
      responseSources,
      /** @type {Record<string, { limit: number, continuationToken?: string }>} */ (pagination ?? {}),
      continuationRevision(context.queries, dashboard.revision)
    );
    const totalMs = monotonicNow() - startedAt;
    const databaseMs = databaseMetrics?.databaseMs ?? 0;
    debugPerformance('page query', {
      pageId: pageId ?? null,
      viewId: viewId ?? null,
      databaseMs,
      queryMs: Math.max(0, totalMs - databaseMs),
      projectionMs: databaseMetrics?.projectionMs ?? 0,
      totalMs,
      recordsRead: databaseMetrics?.recordsRead ?? 0,
      stores: databaseMetrics?.stores ?? [],
      requestedSources: [...requested],
      returnedRows: Object.fromEntries(Object.entries(response).map(([name, source]) => [name, source.rows.length]))
    });
  return response;
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

async function flushDashboardSubscriptions(allowDuringIngestion = false) {
  if (subscriptionFlushRunning
      || (!allowDuringIngestion && dashboardIngestionCount > 0 && !hasUnrenderedDashboardSubscription())) return;
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
            workerScope?.postMessage({ subscriptionId: id, revision: dashboard.revision, data });
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

/**
 * Publishes the latest committed canonical projection without blocking the next
 * shard download. The subscription flusher coalesces commits that arrive while
 * an earlier refresh is still running.
 *
 * @param {Record<string, import('./presenter.js').LogicalSourceInput>} logicalSources
 * @param {boolean} runsOnly
 * @returns {Promise<void>}
 */
function refreshDashboardSubscriptions(logicalSources, runsOnly) {
  const runPhasePublication = runsOnly && !eagerIngest;
  if (runsOnly !== runPhasePublication) {
    debugIngestion('publishing every phase because eager ingestion is active', {
      subscriptions: dashboardSubscriptions.size
    });
  }
  liveDashboard = {
    logicalSources,
    revision: (liveDashboard?.revision ?? 0) + 1
  };
  runPhaseOnly = runPhasePublication;
  scheduleDashboardSubscriptions(runPhasePublication
    ? [...dashboardSubscriptions]
        .filter(([, subscription]) => isRunPhaseSubscription(subscription))
        .map(([id]) => id)
    : dashboardSubscriptions.keys());
  return flushDashboardSubscriptions(true);
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

/** @param {unknown} hashes @param {'runs' | 'records'} phase */
function publishedPhaseShards(hashes, phase) {
  if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes)) return [];
  const pattern = new RegExp(`^gh-aw-logs-${phase}/[^/]+\\.jsonl$`, 'i');
  return Object.entries(/** @type {Record<string, unknown>} */ (hashes))
    .filter(([name, hash]) => pattern.test(name)
      && typeof hash === 'string'
      && /^[a-f0-9]{64}$/i.test(hash))
    .map(([name, hash]) => ({ name, hash: /** @type {string} */ (hash).toLowerCase(), phase }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** @param {unknown} hashes */
export function publishedRunInformationShards(hashes) {
  return publishedPhaseShards(hashes, 'runs');
}

/** @param {unknown} hashes */
export function publishedRunRecordShards(hashes) {
  return publishedPhaseShards(hashes, 'records');
}

/** @param {unknown} hashes */
export function publishedPhasedActivityShards(hashes) {
  const runs = publishedRunInformationShards(hashes);
  const records = publishedRunRecordShards(hashes);
  return runs.length > 0 ? [...runs, ...records] : [];
}

/**
 * @param {{ id?: unknown, operation?: unknown, data?: unknown, operators?: unknown, columns?: unknown, limit?: unknown, sources?: unknown, queries?: unknown, context?: unknown, sourceUrl?: unknown, sourceNames?: unknown, pagination?: unknown, reportActivation?: unknown, emitCurrent?: unknown, ingest?: unknown, pageId?: unknown, viewId?: unknown, routeParameters?: unknown, queryContext?: unknown }} request
 * @param {AbortSignal} [signal] cancels declarative query execution
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
      const progress = startIngestionProgress(
        undefined,
        typeof request.id === 'number' ? request.id : undefined
      );
      /** @type {typeof fetch} */
      const ingestionFetch = (input, init) => fetch(input, { ...init, signal });
      const activity = sourceUrl.pathname.endsWith('/payload-hashes.json');
      if (!activity) progress.start();
      let changed = false;
      /** @type {Record<string, unknown>} */
      let sources = {};
      if (typeof request.id === 'number') {
        inFlightDashboardSources.set(request.id, sources);
      }
      try {
        progress.log(activity ? 'Loading ingestion metadata.' : 'Downloading dashboard source data.');
        sources = activity ? {} : await loadDashboardSources(ingestionFetch, sourceUrl.href, {
          onShardLoaded: ({ name, sizeBytes, cacheStatus }) => {
            const size = sizeBytes === null ? 'size unavailable' : `${sizeBytes.toLocaleString()} bytes`;
            progress.log(`Loaded dashboard source shard ${name} (${size}; cache: ${cacheStatus ?? 'unavailable'}).`);
          }
        });
        if (typeof request.id === 'number') inFlightDashboardSources.set(request.id, sources);
        if (activity) {
          const payloadHashesUrl = sourceUrl;
          const inventoryUrl = new URL('./inventory-sources.json', payloadHashesUrl);
          progress.log('Refreshing workflow and repository inventory.');
          const { response: inventoryResponse, value: inventorySources } = await withRetries(async () => {
            const response = await ingestionFetch(inventoryUrl, { cache: 'no-store' });
            if (!response.ok) {
              if (response.status === 404) return { response, value: {} };
              throw new Error(`Unable to load dashboard inventory sources: ${response.status}`);
            }
            return { response, value: await response.json() };
          });
          if (inventoryResponse.ok) {
            sources = inventorySources;
            if (typeof request.id === 'number') inFlightDashboardSources.set(request.id, sources);
            progress.log('Inventory metadata refreshed.');
          } else {
            progress.log('No separate inventory metadata was published.');
          }
          progress.log('Checking the published payload identity.');
          const payloadHashesResponse = await ingestionFetch(payloadHashesUrl, { cache: 'no-store' }).catch(() => null);
          if (signal?.aborted) throw new DashboardQueryCancelledError('data ingestion was cancelled', 'aborted');
          const payloadHashes = payloadHashesResponse?.ok
            ? await payloadHashesResponse.json().catch(() => null)
            : null;
          const runInformationShards = publishedRunInformationShards(payloadHashes);
          const phasedShards = publishedPhasedActivityShards(payloadHashes);
          const shardLimit = eagerIngest ? undefined : debugShardLimit();
          const shards = shardLimit === undefined ? phasedShards : phasedShards.slice(0, shardLimit);
          const shardCount = shards.length;
          debugIngestion('loaded activity manifest', {
            source: sourceUrl.pathname,
            shardCount,
            shardLimit,
            eagerIngest,
            manifestAvailable: payloadHashesResponse?.ok === true
          });
          if (shardCount > 0) {
            progress.log(`Published activity data includes ${shardCount.toLocaleString('en-US')} `
              + `${shardCount === 1 ? 'shard' : 'shards'}.`);
          }
          if (shards.length === 0) {
            throw new Error('Activity shard manifest is missing compacted run-information shards.');
          }
          /** @type {Array<{ index: number, shard: { name: string, hash: string }, shardUrl: URL, current: boolean, sizeBytes: number | undefined }>} */
          const shardStates = [];
          for (const [index, shard] of shards.entries()) {
            if (signal?.aborted) throw new DashboardQueryCancelledError('data ingestion was cancelled', 'aborted');
            const shardUrl = new URL(`./${shard.name}`, payloadHashesUrl);
            const current = await isNormalizedJsonCurrent(indexedDB, {
              payloadIdentity: shard.hash,
              payloadScope: shardUrl.href
            }, NORMALIZED_JSONL_INGESTION_VERSION);
            shardStates.push({ index, shard, shardUrl, current, sizeBytes: undefined });
          }
          const pendingShards = shardStates.filter(({ current }) => !current);
          const runPhaseShardCount = phasedShards.length > 0 && !eagerIngest
            ? Math.min(runInformationShards.length, shardStates.length)
            : 0;
          const initialPendingShards = runPhaseShardCount > 0
            ? pendingShards.filter(({ index }) => index < runPhaseShardCount)
            : pendingShards;
          debugIngestion('planned shard ingestion phases', {
            shardCount,
            pendingShardCount: pendingShards.length,
            runPhaseShardCount,
            initialPendingShardCount: initialPendingShards.length,
            eagerIngest
          });
          if (pendingShards.length > 0) {
            progress.start();
            progress.reportShardImportProgress(shardStates.length - pendingShards.length, shardCount);
          }
          const measureShards = (/** @type {typeof pendingShards} */ states) => Promise.all(states.map(async (state) => {
            const response = await ingestionFetch(state.shardUrl, { method: 'HEAD' }).catch(() => null);
            const contentLength = response?.ok ? Number(response.headers.get('content-length')) : Number.NaN;
            state.sizeBytes = Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : undefined;
          }));
          await measureShards(initialPendingShards);
          let workloadBytes = initialPendingShards.every(({ sizeBytes }) => typeof sizeBytes === 'number')
            ? initialPendingShards.reduce((sum, { sizeBytes }) => sum + (sizeBytes ?? 0), 0)
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
            if (signal?.aborted) throw new DashboardQueryCancelledError('data ingestion was cancelled', 'aborted');
            if (runPhaseShardCount > 0 && index === runPhaseShardCount) {
              const eventPendingShards = pendingShards.filter((state) => state.index >= runPhaseShardCount);
              await measureShards(eventPendingShards);
              workloadBytes = pendingShards.every(({ sizeBytes }) => typeof sizeBytes === 'number')
                ? pendingShards.reduce((sum, state) => sum + (state.sizeBytes ?? 0), 0)
                : undefined;
              progress.setWorkload(workloadBytes);
            }
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
            const response = await ingestionFetch(shardUrl);
            if (!response.ok) throw new Error(`Unable to load activity shard ${shard.name}: ${response.status}`);
            if (!response.body) throw new Error(`Unable to stream activity shard ${shard.name}`);
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
              const expectedPhase = 'phase' in shard && (shard.phase === 'runs' || shard.phase === 'records')
                ? /** @type {'runs' | 'records'} */ (shard.phase)
                : undefined;
              const ingestionOptions = {
                storage: globalThis.navigator?.storage,
                retentionWindowMsByStore: BROWSER_RETENTION_WINDOWS_MS,
                onWriteProgress: (/** @type {{ storedRecords: number, totalRecords: number }} */ written) => progress.store(written),
                onLockWait: () => progress.log(INGESTION_LOCK_WAIT_MESSAGE),
                signal,
                payloadIdentity: shard.hash,
                payloadScope: shardUrl.href,
                expectedPhase,
                deferMaintenance: true
              };
              const ingestion = await ingestNormalizedJsonl(
                indexedDB,
                responseChunks(/** @type {ReadableStream<Uint8Array>} */ (response.body)),
                ingestionOptions
              );
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
          if (changed) {
            progress.log('Applying retention limits.');
            await finalizeNormalizedJsonlIngestion(indexedDB, {
              storage: globalThis.navigator?.storage,
              retentionWindowMsByStore: BROWSER_RETENTION_WINDOWS_MS,
              onLockWait: () => progress.log(INGESTION_LOCK_WAIT_MESSAGE),
              signal
            });
          }
          if (inventoryResponse.ok) {
            progress.log('Normalizing inventory metadata.');
            const inventoryIngestion = await ingestDashboardSources(indexedDB, sources, {
              storage: globalThis.navigator?.storage,
              retentionWindowMsByStore: BROWSER_RETENTION_WINDOWS_MS,
              payloadScope: inventoryUrl.href,
              onWriteProgress: (written) => progress.store(written),
              onLockWait: () => progress.log(INGESTION_LOCK_WAIT_MESSAGE),
              signal
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
            onLockWait: () => progress.log(INGESTION_LOCK_WAIT_MESSAGE),
            signal
          });
          changed ||= ingestion.updated;
          progress.log('skipped' in ingestion && ingestion.skipped
            ? 'Dashboard source data is already current.'
            : `Dashboard ingestion committed ${ingestion.committedRecords} canonical records.`);
        }
        if (signal?.aborted) throw new DashboardQueryCancelledError('data ingestion was cancelled', 'aborted');
        progress.log('Refreshing active dashboard queries.');
        // A different tab may have committed the current payload to IndexedDB,
        // leaving this worker's in-memory query results stale even when this
        // ingestion reports no local writes.
        const nextRevision = (liveDashboard?.revision ?? 0) + 1;
        liveDashboard = {
          logicalSources: /** @type {Record<string, import('./presenter.js').LogicalSourceInput>} */ (sources),
          revision: nextRevision
        };
        runPhaseOnly = false;
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
        if (typeof request.id === 'number') inFlightDashboardSources.delete(request.id);
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
  if (request?.operation === 'load-dashboard-query-sources') {
    if (!request.sources || typeof request.sources !== 'object' || Array.isArray(request.sources)) {
      throw new TypeError('Dashboard database query requests require a sources object.');
    }
    return (async () => {
      const sources = /** @type {Record<string, unknown>} */ (request.sources);
      if (request.ingest === true) await ingestDashboardSources(indexedDB, sources);
      const sourceNames = request.sourceNames === undefined
        ? Object.keys(sources)
        : [...requestedSourceNames(request.sourceNames)];
      const queries = Array.isArray(request.queries) ? request.queries : [];
      const required = resolveDashboardQuerySources(queries, sourceNames);
      const database = await queryDatabaseSources(indexedDB, sources, required);
      return {
        ...database,
        ...executeDashboardQueries(queries, database, sourceNames, { signal })
      };
    })();
  }
  if (request?.operation === 'query-canonical-database-diagnostics') {
    return collectCanonicalDatabaseDiagnostics();
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
    const adapted = queryDashboardSourceObservations(/** @type {Record<string, unknown>} */ (request.sources));
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
      try {
        const context = dashboardContext(event.data.context);
        const subscription = {
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
        };
        dashboardSubscriptions.set(subscriptionId, subscription);
        if (liveDashboard && event.data.emitCurrent !== false) {
          if (!runPhaseOnly || isRunPhaseSubscription(subscription)) {
            scheduleDashboardSubscriptions([subscriptionId]);
          }
        }
      } catch (error) {
        // Remove any partially-registered subscription so it cannot linger
        // as a stale, unusable entry, then report the failure so the main
        // thread's pending page load rejects instead of waiting forever for
        // a snapshot that will never arrive.
        dashboardSubscriptions.delete(subscriptionId);
        workerScope.postMessage({
          subscriptionId,
          error: error instanceof Error ? error.message : String(error)
        });
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
    if (event.data?.operation === 'sync-dashboard-queries') {
      const requestId = event.data.requestId;
      const sources = Number.isSafeInteger(requestId)
        ? inFlightDashboardSources.get(requestId)
        : undefined;
      if (sources) {
        void refreshDashboardSubscriptions(
          /** @type {Record<string, import('./presenter.js').LogicalSourceInput>} */ (sources),
          false
        );
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
      cancelled: controller.signal.aborted || error instanceof DashboardQueryCancelledError
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

/** @param {unknown} value @returns {DashboardSubscription['queryContext']} */
function queryContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const context = /** @type {{ filters?: unknown, search?: unknown, orderBy?: unknown, timeWindow?: unknown, viewMode?: unknown }} */ (value);
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
  const viewMode = context.viewMode === 'chart' || context.viewMode === 'table' || context.viewMode === 'card'
    ? context.viewMode
    : undefined;
  return {
    ...(filters ? { filters } : {}),
    ...(search ? { search } : {}),
    ...(orderBy.length > 0 ? { orderBy } : {}),
    ...(timeWindow?.start || timeWindow?.end ? { timeWindow } : {}),
    ...(viewMode ? { viewMode } : {})
  };
}
