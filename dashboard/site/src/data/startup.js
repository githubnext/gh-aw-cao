import {
  loadDashboardSnapshotMetadata,
  loadCanonicalDashboardPage,
  refreshCanonicalDashboardSources,
  subscribeCanonicalDashboardView,
} from "../data-processor.js";
import { bindSourceContinuations, continuationRequests } from "./continuation.js";
import { DASHBOARD_DATA_EVENT, emitDashboardDebugEvent } from "../debug-events.js";
import {
  DASHBOARD_REFRESH_REQUEST_EVENT,
  startAutomaticDashboardDataUpdates,
} from "../dashboard-data-updates.js";
import { configureSourceLoader, refreshSources as refreshBoundSources } from "../source-store.js";
import { dashboardViewAliasName } from "./queries/view-payload-compiler.js";
import { usesRemoteDataBackend } from "../remote-data-backend.js";
import { createDebug } from "../debug.js";

const debugStartup = createDebug("startup");

/** @typedef {{ pageId?: string, viewId?: string, sourceIndex?: number, routeParameters?: Record<string, string>, queryContext?: DashboardQueryContext }} BatchedSourceOptions */

/**
 * Coalesces source requests issued by one page in the same turn so the worker
 * reads and projects shared canonical dependencies only once. Requests with
 * distinct query contexts remain isolated.
 *
 * @param {{ githubUrlBase?: string, dashboardRepository?: string | null, pages: unknown[], queries?: unknown[], views?: unknown[] }} dashboardContext
 * @returns {(name: string, options?: BatchedSourceOptions) => Promise<import("../presenter.js").LogicalSourceInput | undefined>}
 */
export function createBatchedSourceLoader(dashboardContext) {
  /** @type {Array<{ name: string, options: BatchedSourceOptions, resolve: (source: import("../presenter.js").LogicalSourceInput | undefined) => void, reject: (error: unknown) => void }>} */
  let pending = [];
  let scheduled = false;

  const flush = async () => {
    scheduled = false;
    const requests = pending;
    pending = [];
    try {
      /** @type {Map<string, typeof requests>} */
      const groups = new Map();
      for (const request of requests) {
        const key = JSON.stringify([
          request.options?.pageId ?? null,
          request.options?.routeParameters ?? null,
          request.options?.queryContext ?? null,
        ]);
        const group = groups.get(key) ?? [];
        group.push(request);
        groups.set(key, group);
      }

      debugStartup({
        op: "batched-source-flush",
        requestCount: requests.length,
        groupCount: groups.size,
      });

      await Promise.all([...groups.values()].map(async (group) => {
        const [{ options }] = group;
        const names = [...new Set(group.map(({ name }) => name))];
        const viewIds = new Set(group.map(({ options: requestOptions }) => requestOptions?.viewId));
        try {
          const sources = await loadCanonicalDashboardPage(
            names,
            dashboardContext,
            undefined,
            {
              pageId: options?.pageId,
              viewId: viewIds.size === 1 ? options?.viewId : undefined,
              routeParameters: options?.routeParameters,
              queryContext: options?.queryContext,
            },
          );
          for (const request of group) {
            const alias = request.options?.pageId && request.options.viewId
              ? dashboardViewAliasName(
                  request.options.pageId,
                  { id: request.options.viewId },
                  0,
                  request.name,
                  request.options.sourceIndex ?? 0,
                )
              : request.name;
            request.resolve(sources[alias] ?? sources[request.name]);
          }
        } catch (error) {
          for (const request of group) request.reject(error);
        }
      }));
    } catch (error) {
      for (const request of requests) request.reject(error);
    }
  };

  return (name, options = {}) => new Promise((resolve, reject) => {
    pending.push({ name, options, resolve, reject });
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => void flush());
  });
}

/** @typedef {Record<string, import('../presenter.js').LogicalSourceInput>} DashboardSources */
/** @typedef {{ filters?: Record<string, string[]>, search?: { fields: string[], query: string }, orderBy?: Array<{ field: string, direction?: 'asc' | 'desc' }>, timeWindow?: { start?: string, end?: string }, viewMode?: 'chart'|'table'|'card', formValues?: Record<string, string|number|boolean> }} DashboardQueryContext */
/** @typedef {{ signal: AbortSignal, onUpdate: (sources: DashboardSources) => void, routeParameters?: Record<string, string>, queryContext?: DashboardQueryContext }} PageLoadOptions */
/** @typedef {((pageId: string, options: PageLoadOptions) => Promise<DashboardSources>) & { prepare?: (pageId: string) => Promise<void>, subscribeBackgroundSources?: (sourceNames: string[], options: PageLoadOptions) => Promise<DashboardSources>, subscribeViewSources?: (pageId: string, viewId: string, sourceNames: string[], options: PageLoadOptions) => Promise<DashboardSources> }} PageSourceLoader */

/**
 * Gives a cached render two animation frames to commit before network activity starts.
 * @param {Window} browserWindow
 * @returns {Promise<void>}
 */
export function waitForDashboardUi(browserWindow) {
  return new Promise((resolve) => {
    /** @type {(callback: FrameRequestCallback) => number} */
    const schedule = browserWindow.requestAnimationFrame
      ? (callback) => browserWindow.requestAnimationFrame(callback)
      : (callback) => browserWindow.setTimeout(() => callback(performance.now()), 0);
    schedule(() => schedule(() => resolve()));
  });
}

/**
 * Starts the live dashboard data pipeline without depending on the view engine.
 *
 * @param {{
 *   browserWindow: Window,
 *   document: Document,
 *   sourceUrl: string,
 *   dashboardContext: {
 *     githubUrlBase?: string,
 *     dashboardRepository?: string | null,
 *     pages: import('../presenter.js').PresentationDocument['dashboard']['pages'],
 *     queries: unknown[],
 *   },
 *   preparePage?: (pageId: string) => Promise<void>,
 *   pageSourceNames: (pageId: string, viewMode?: 'chart'|'table'|'card') => string[],
 *   pagePaginatedSourceBindings: (pageId: string) => Record<string, { sourceName: string, viewId: string }>,
 *   render: (sources: DashboardSources, state: 'ready' | 'loading' | 'cached' | 'stale', loadPageSources: PageSourceLoader, retryRefresh?: () => void, snapshot?: { createdAt: string } | null) => void,
 *   settleUi?: () => Promise<void>,
 * }} options
 * @returns {Promise<() => void>}
 */
export async function startDashboardData(options) {
  const {
    browserWindow,
    document,
    sourceUrl,
    dashboardContext,
    preparePage,
    pageSourceNames,
    pagePaginatedSourceBindings,
    render,
    settleUi = () => waitForDashboardUi(browserWindow),
  } = options;
  const cleanup = new AbortController();
  let nextViewSubscriptionId = 0;
  let stopAutomaticDataUpdates = () => {};
  /** @type {() => void} */
  let startBackgroundWork = () => {};
  const backgroundWorkStarted = new Promise((resolve) => {
    startBackgroundWork = () => resolve(undefined);
  });
  browserWindow.addEventListener("pagehide", (event) => {
    if (!event.persisted) {
      startBackgroundWork();
      cleanup.abort();
      stopAutomaticDataUpdates();
    }
  });

  /**
   * @param {string} pageId
   * @param {DashboardSources} sources
   * @param {Record<string, { sourceName: string, viewId: string }>} bindings
   * @param {Pick<PageLoadOptions, 'routeParameters' | 'queryContext'>} [pageOptions]
   */
  const bindContinuations = (pageId, sources, bindings, pageOptions = {}) => bindSourceContinuations(
    sources,
    Object.keys(bindings),
    (requested, pagination) => {
      const binding = bindings[requested[0]];
      return loadCanonicalDashboardPage(
        [...new Set(requested.flatMap((alias) => {
          const sourceName = bindings[alias]?.sourceName;
          return sourceName ? [sourceName] : [];
        }))],
        dashboardContext,
        pagination,
        {
          pageId,
          viewId: binding?.viewId,
          routeParameters: pageOptions.routeParameters,
          queryContext: pageOptions.queryContext,
        },
      );
    },
  );
  /**
   * Subscribes to a bounded source set. The returned promise resolves with the
   * first snapshot; later snapshots are delivered through `pageOptions.onUpdate`.
   * @param {{ subscriptionId: string, sourceNames: string[], pageOptions: PageLoadOptions & { pageId?: string, viewId?: string }, pagination?: Record<string, { limit: number, continuationToken?: string }>, transform?: (sources: DashboardSources) => DashboardSources, errorLabel: string }} options
   */
  const subscribeSources = (options) => {
    const pageOptions = options.pageOptions;
    const transform = options.transform ?? ((sources) => sources);
    if (pageOptions.signal.aborted) {
      throw new DOMException("Dashboard source load was cancelled.", "AbortError");
    }
    return new Promise((resolve, reject) => {
      let receivedInitialSnapshot = false;
      const cleanup = () => pageOptions.signal.removeEventListener("abort", abort);
      const abort = () => {
        cleanup();
        reject(new DOMException("Dashboard source load was cancelled.", "AbortError"));
      };
      pageOptions.signal.addEventListener("abort", abort, { once: true });
      subscribeCanonicalDashboardView(
        options.subscriptionId,
        options.sourceNames,
        dashboardContext,
        (sources) => {
          const transformedSources = transform(sources);
          if (!receivedInitialSnapshot) {
            receivedInitialSnapshot = true;
            cleanup();
            resolve(transformedSources);
            return;
          }
          pageOptions.onUpdate(transformedSources);
        },
        options.pagination ?? {},
        {
          signal: pageOptions.signal,
          pageId: pageOptions.pageId,
          viewId: pageOptions.viewId,
          routeParameters: pageOptions.routeParameters,
          queryContext: pageOptions.queryContext,
          onError: (error) => {
            cleanup();
            if (!receivedInitialSnapshot) {
              debugStartup({
                op: "subscribe-sources",
                subscriptionId: options.subscriptionId,
                status: "initial-error",
                errorName: error instanceof Error ? error.name : "Unknown",
              });
              reject(error);
            } else {
              console.error(`${options.errorLabel}: ${error.message}`);
            }
          },
        },
      );
    });
  };
  /** @type {PageSourceLoader} */
  const loadPageSources = async (pageId, pageOptions) => {
    await preparePage?.(pageId);
    const sourceNames = pageSourceNames(pageId, pageOptions.queryContext?.viewMode);
    const paginatedSources = pagePaginatedSourceBindings(pageId);
    const pagination = continuationRequests(Object.keys(paginatedSources));
    return subscribeSources({
      subscriptionId: `page:${pageId}`,
      sourceNames,
      pageOptions: { ...pageOptions, pageId },
      pagination,
      transform: (sources) => bindContinuations(pageId, sources, paginatedSources, pageOptions),
      errorLabel: `Unable to update dashboard page ${pageId}`
    });
  };
  loadPageSources.subscribeViewSources = (pageId, viewId, sourceNames, pageOptions) => {
    const bindings = Object.fromEntries(Object.entries(pagePaginatedSourceBindings(pageId))
      .filter(([, binding]) => binding.viewId === viewId));
    return subscribeSources({
      subscriptionId: `page:${pageId}:view:${viewId}:${++nextViewSubscriptionId}`,
      sourceNames: [...new Set(sourceNames)],
      pageOptions: { ...pageOptions, pageId, viewId },
      pagination: continuationRequests(Object.keys(bindings)),
      transform: (sources) => bindContinuations(pageId, sources, bindings, pageOptions),
      errorLabel: `Unable to update dashboard view ${viewId}`
    });
  };
  loadPageSources.subscribeBackgroundSources = async (sourceNames, pageOptions) => {
    await backgroundWorkStarted;
    if (pageOptions.signal.aborted) {
      throw new DOMException("Dashboard source load was cancelled.", "AbortError");
    }
    const subscriptionSourceNames = [...new Set(sourceNames)].toSorted();
    return subscribeSources({
      subscriptionId: `sources:${subscriptionSourceNames.join(",")}`,
      sourceNames: subscriptionSourceNames,
      pageOptions,
      errorLabel: "Unable to update dashboard sources"
    });
  };
  loadPageSources.prepare = async (pageId) => {
    await preparePage?.(pageId);
  };
  configureSourceLoader(createBatchedSourceLoader(dashboardContext));
  const startAutomaticUpdates = () => {
    if (usesRemoteDataBackend(document)) return;
    stopAutomaticDataUpdates = startAutomaticDashboardDataUpdates([
      new URL("./payload-hashes.json", sourceUrl).href,
      sourceUrl,
      new URL("./inventory-sources.json", sourceUrl).href,
    ]);
  };

  const bootstrapStartedAt = performance.now();
  /** @template T @param {string} step @param {() => Promise<T>} run @returns {Promise<T>} */
  const bootstrapStep = async (step, run) => {
    const stepStartedAt = performance.now();
    debugStartup({ op: "bootstrap", step, status: "started" });
    try {
      const result = await run();
      debugStartup({ op: "bootstrap", step, status: "completed", durationMs: Math.round(performance.now() - stepStartedAt) });
      return result;
    } catch (error) {
      debugStartup({
        op: "bootstrap",
        step,
        status: "failed",
        durationMs: Math.round(performance.now() - stepStartedAt),
        errorName: error instanceof Error ? error.name : "Unknown",
      });
      throw error;
    }
  };
  await bootstrapStep("open-canonical-database", () => loadCanonicalDashboardPage([], dashboardContext));
  let snapshot = await bootstrapStep("read-snapshot-metadata", () => loadDashboardSnapshotMetadata());
  debugStartup({
    op: "bootstrap",
    status: "ready",
    snapshot: snapshot === null ? "absent" : "present",
    durationMs: Math.round(performance.now() - bootstrapStartedAt),
  });
  const remoteDataBackend = usesRemoteDataBackend(document);
  let hasCompleteSnapshot = remoteDataBackend || snapshot !== null;
  render({}, hasCompleteSnapshot ? "cached" : "loading", loadPageSources, undefined, snapshot);
  let refreshFailed = false;
  let refreshPending = false;
  /** @param {unknown} error */
  const showStaleSources = (error) => {
    if (refreshFailed) return;
    refreshFailed = true;
    refreshPending = false;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Unable to refresh live dashboard data: ${message}`);
    debugStartup({
      op: "refresh-sources",
      status: "stale",
      errorName: error instanceof Error ? error.name : "Unknown",
    });
    emitDashboardDebugEvent(document, DASHBOARD_DATA_EVENT, {
      kind: "refresh",
      status: "failed",
      message,
    });
    render({}, hasCompleteSnapshot ? "stale" : "loading", loadPageSources, refreshSources, snapshot);
  };
  const refreshSources = (showRefreshing = true) => {
    if (refreshPending || cleanup.signal.aborted) return;
    refreshFailed = false;
    refreshPending = true;
    emitDashboardDebugEvent(document, DASHBOARD_DATA_EVENT, {
      kind: "refresh",
      status: "started",
    });
    if (showRefreshing) {
      render({}, hasCompleteSnapshot ? "cached" : "loading", loadPageSources, undefined, snapshot);
    }
    void refreshCanonicalDashboardSources(
      sourceUrl,
      [],
      dashboardContext,
    ).then(
      async ({ changed }) => {
        refreshPending = false;
        snapshot = await loadDashboardSnapshotMetadata().catch(() => null) ?? snapshot;
        hasCompleteSnapshot = remoteDataBackend || snapshot !== null;
        emitDashboardDebugEvent(document, DASHBOARD_DATA_EVENT, {
          kind: "refresh",
          status: "completed",
          changed,
        });
        refreshBoundSources();
        if (usesRemoteDataBackend(document)) {
          const dashboard = document.querySelector("#root > .dashboard-root");
          dashboard?.classList.remove("dashboard-refreshing");
          dashboard?.removeAttribute("aria-busy");
        } else {
          render({}, "ready", loadPageSources, undefined, snapshot);
        }
      },
      showStaleSources,
    );
  };
  browserWindow.addEventListener(DASHBOARD_REFRESH_REQUEST_EVENT, () => refreshSources(), {
    signal: cleanup.signal,
  });

  await settleUi();
  // The active page is subscribed and painted before lower-priority work begins.
  startBackgroundWork();
  if (!cleanup.signal.aborted) {
    startAutomaticUpdates();
    refreshSources(false);
  }
  return () => {
    cleanup.abort();
    stopAutomaticDataUpdates();
  };
}
