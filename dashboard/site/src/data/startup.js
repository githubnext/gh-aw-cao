import {
  loadCanonicalDashboardPage,
  refreshCanonicalDashboardSources,
  subscribeCanonicalDashboardView,
} from "../data-processor.js";
import { bindSourceContinuations, continuationRequests } from "./continuation.js";
import { DASHBOARD_DATA_EVENT, emitDashboardDebugEvent } from "../debug-events.js";
import { startAutomaticDashboardDataUpdates } from "../dashboard-data-updates.js";
import { configureSourceLoader, refreshSources as refreshBoundSources } from "../source-store.js";

/** @typedef {Record<string, import('../presenter.js').LogicalSourceInput>} DashboardSources */
/** @typedef {{ filters?: Record<string, string[]>, search?: { fields: string[], query: string }, orderBy?: Array<{ field: string, direction?: 'asc' | 'desc' }>, timeWindow?: { start?: string, end?: string } }} DashboardQueryContext */
/** @typedef {{ signal: AbortSignal, onUpdate: (sources: DashboardSources) => void, routeParameters?: Record<string, string>, queryContext?: DashboardQueryContext }} PageLoadOptions */
/** @typedef {(pageId: string, options: PageLoadOptions) => Promise<DashboardSources>} PageSourceLoader */

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
 *   pageSourceNames: (pageId: string) => string[],
 *   pageLazySourceNames: (pageId: string) => string[],
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
    pageLazySourceNames,
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
   * @param {string[]} sourceNames
   * @param {Pick<PageLoadOptions, 'routeParameters' | 'queryContext'>} [pageOptions]
   */
  const bindContinuations = (pageId, sources, sourceNames, pageOptions = {}) => bindSourceContinuations(
    sources,
    sourceNames,
    (requested, pagination) => loadCanonicalDashboardPage(requested, dashboardContext, pagination, {
      pageId,
      routeParameters: pageOptions.routeParameters,
      queryContext: pageOptions.queryContext,
    }),
  );
  /** @type {PageSourceLoader} */
  const loadPageSources = async (pageId, pageOptions) => {
    await preparePage?.(pageId);
    const sourceNames = pageSourceNames(pageId);
    const lazySources = pageLazySourceNames(pageId);
    const pagination = continuationRequests(lazySources);
    return new Promise((resolve, reject) => {
      let receivedInitialSnapshot = false;
      const abort = () => reject(new DOMException("Dashboard page load was cancelled.", "AbortError"));
      pageOptions.signal.addEventListener("abort", abort, { once: true });
      subscribeCanonicalDashboardView(
        `page:${pageId}`,
        sourceNames,
        dashboardContext,
        (sources) => {
          const boundSources = bindContinuations(pageId, sources, lazySources, pageOptions);
          if (!receivedInitialSnapshot) {
            receivedInitialSnapshot = true;
            pageOptions.signal.removeEventListener("abort", abort);
            resolve(boundSources);
            return;
          }
          pageOptions.onUpdate(boundSources);
        },
        pagination,
        {
          signal: pageOptions.signal,
          pageId,
          routeParameters: pageOptions.routeParameters,
          queryContext: pageOptions.queryContext,
          onError: (error) => {
            if (!receivedInitialSnapshot) {
              pageOptions.signal.removeEventListener("abort", abort);
              reject(error);
            } else {
              console.error(`Unable to update dashboard page ${pageId}: ${error.message}`);
            }
          },
        },
      );
    });
  };
  configureSourceLoader(async (name) => (await loadCanonicalDashboardPage([name], dashboardContext))[name]);
  const startAutomaticUpdates = () => {
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
        render({}, "ready", loadPageSources);
      },
      showStaleSources,
    );
  };

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
