import {
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

/** @typedef {{ pageId?: string, viewId?: string, sourceIndex?: number, queryContext?: DashboardQueryContext }} BatchedSourceOptions */

/**
 * Coalesces source requests issued by one view in the same turn so the worker
 * reads and projects their shared canonical dependencies only once.
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
          request.options?.viewId ?? null,
          request.options?.queryContext ?? null,
        ]);
        const group = groups.get(key) ?? [];
        group.push(request);
        groups.set(key, group);
      }

      await Promise.all([...groups.values()].map(async (group) => {
        const [{ options }] = group;
        const names = [...new Set(group.map(({ name }) => name))];
        try {
          const sources = await loadCanonicalDashboardPage(
            names,
            dashboardContext,
            undefined,
            {
              pageId: options?.pageId,
              viewId: options?.viewId,
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
/** @typedef {((pageId: string, options: PageLoadOptions) => Promise<DashboardSources>) & { prepare?: (pageId: string) => Promise<void>, loadSources?: (sourceNames: string[], options: PageLoadOptions) => Promise<DashboardSources> }} PageSourceLoader */

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
 *   render: (sources: DashboardSources, state: 'ready' | 'cached' | 'stale', loadPageSources: PageSourceLoader, retryRefresh?: () => void) => void,
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
  let stopAutomaticDataUpdates = () => {};
  browserWindow.addEventListener("pagehide", (event) => {
    if (!event.persisted) {
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
   * @param {{ subscriptionId: string, sourceNames: string[], pageOptions: PageLoadOptions & { pageId?: string }, pagination?: Record<string, { limit: number, continuationToken?: string }>, transform?: (sources: DashboardSources) => DashboardSources, errorLabel: string }} options
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
          routeParameters: pageOptions.routeParameters,
          queryContext: pageOptions.queryContext,
          onError: (error) => {
            cleanup();
            if (!receivedInitialSnapshot) {
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
  loadPageSources.loadSources = async (sourceNames, pageOptions) => {
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

  await loadCanonicalDashboardPage([], dashboardContext);
  render({}, "cached", loadPageSources);
  let refreshFailed = false;
  let refreshPending = false;
  /** @param {unknown} error */
  const showStaleSources = (error) => {
    if (refreshFailed) return;
    refreshFailed = true;
    refreshPending = false;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Unable to refresh live dashboard data: ${message}`);
    emitDashboardDebugEvent(document, DASHBOARD_DATA_EVENT, {
      kind: "refresh",
      status: "failed",
      message,
    });
    render({}, "stale", loadPageSources, refreshSources);
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
      render({}, "cached", loadPageSources);
    }
    void refreshCanonicalDashboardSources(
      sourceUrl,
      [],
      dashboardContext,
    ).then(
      ({ changed }) => {
        refreshPending = false;
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
          render({}, "ready", loadPageSources);
        }
      },
      showStaleSources,
    );
  };
  browserWindow.addEventListener(DASHBOARD_REFRESH_REQUEST_EVENT, () => refreshSources(), {
    signal: cleanup.signal,
  });

  await settleUi();
  if (!cleanup.signal.aborted) {
    startAutomaticUpdates();
    refreshSources(false);
  }
  return () => {
    cleanup.abort();
    stopAutomaticDataUpdates();
  };
}
