import { beforeEach, describe, expect, it, vi } from "vitest";

/** @type {string[]} */
const calls = [];
const dataProcessor = vi.hoisted(() => ({
  loadCanonicalDashboardPage: vi.fn(),
  loadCanonicalDashboardSources: vi.fn(),
  refreshCanonicalDashboardSources: vi.fn(),
  subscribeCanonicalDashboardView: vi.fn(),
}));
const updates = vi.hoisted(() => ({
  DASHBOARD_REFRESH_REQUEST_EVENT: "dashboard-refresh-request",
  startAutomaticDashboardDataUpdates: vi.fn(),
}));

vi.mock("../../src/data-processor.js", () => dataProcessor);
vi.mock("../../src/dashboard-data-updates.js", () => updates);

import { createBatchedSourceLoader, startDashboardData } from "../../src/data/startup.js";
import { dashboardViewAliasName } from "../../src/data/queries/view-payload-compiler.js";

const cachedSources = {
  runs: { source: "runs", rows: [{ run: "cached" }] },
};

/** @param {Record<string, unknown>} [overrides] */
function options(overrides = {}) {
  let renderedPage = false;
  return {
    browserWindow: window,
    document,
    sourceUrl: "https://example.test/dashboard/payload-hashes.json",
    dashboardContext: { pages: [], queries: [] },
    pageSourceNames: () => ["runs"],
    pagePaginatedSourceBindings: () => ({}),
    render: (
      /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ _sources,
      /** @type {'ready' | 'cached' | 'stale'} */ state,
      /** @type {(pageId: string, options: { signal: AbortSignal, onUpdate: () => void }) => Promise<unknown>} */ loadPageSources,
    ) => {
      calls.push(`render:${state}`);
      if (!renderedPage) {
        renderedPage = true;
        void loadPageSources("overview", {
          signal: new AbortController().signal,
          onUpdate: () => {},
        }).catch(() => {});
      }
    },
    settleUi: async () => {
      calls.push("settle");
    },
    ...overrides,
  };
}

describe("dashboard data startup", () => {
  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
    document.head.replaceChildren();
    document.body.replaceChildren();
    dataProcessor.loadCanonicalDashboardPage.mockImplementation(async (sourceNames = ["runs"]) => {
      if (sourceNames.length === 0) return {};
      calls.push("cache");
      return cachedSources;
    });

    dataProcessor.subscribeCanonicalDashboardView.mockImplementation(
      (_id, _sources, _context, listener, _pagination, options) => {
        void dataProcessor.loadCanonicalDashboardPage().then(listener, options.onError);
        return () => {};
      },
    );
    dataProcessor.refreshCanonicalDashboardSources.mockImplementation(() => {
      calls.push("refresh");
      return new Promise(() => {});
    });
    updates.startAutomaticDashboardDataUpdates.mockImplementation(() => {
      calls.push("automatic");
      return () => {};
    });
  });

  it("loads source requests from the same view in one worker query", async () => {
    const runs = { source: "runs", rows: [{ run: "1" }] };
    const outcomes = { source: "outcomes", rows: [{ outcome: "1" }] };
    const runsAlias = dashboardViewAliasName("overview", { id: "overview-floor" }, 0, "runs", 0);
    const outcomesAlias = dashboardViewAliasName("overview", { id: "overview-floor" }, 0, "outcomes", 1);
    dataProcessor.loadCanonicalDashboardPage.mockResolvedValue({
      [runsAlias]: runs,
      [outcomesAlias]: outcomes,
    });
    const loader = createBatchedSourceLoader({ pages: [], queries: [] });

    const [loadedRuns, loadedOutcomes] = await Promise.all([
      loader("runs", { pageId: "overview", viewId: "overview-floor", sourceIndex: 0 }),
      loader("outcomes", { pageId: "overview", viewId: "overview-floor", sourceIndex: 1 }),
    ]);

    expect(dataProcessor.loadCanonicalDashboardPage).toHaveBeenCalledOnce();
    expect(dataProcessor.loadCanonicalDashboardPage).toHaveBeenCalledWith(
      ["runs", "outcomes"],
      { pages: [], queries: [] },
      undefined,
      {
        pageId: "overview",
        viewId: "overview-floor",
        queryContext: undefined,
      },
    );
    expect(loadedRuns).toBe(runs);
    expect(loadedOutcomes).toBe(outcomes);
  });

  it("rejects every request when a batch cannot be grouped", async () => {
    const loader = createBatchedSourceLoader({ pages: [], queries: [] });
    const circularContext = {};
    circularContext.filters = circularContext;

    await expect(Promise.all([
      loader("runs", { queryContext: /** @type {never} */ (circularContext) }),
      loader("outcomes", { queryContext: /** @type {never} */ (circularContext) }),
    ])).rejects.toThrow("circular");
  });

  it("renders cached data and lets the UI settle before any download starts", async () => {
    await startDashboardData(options());

    expect(calls).toEqual([
      "render:cached",
      "settle",
      "cache",
      "automatic",
      "refresh",
    ]);
  });

  it("releases background queries only after UI-bound startup work is registered", async () => {
    /** @type {() => void} */
    let settle = () => {};
    const settled = new Promise((resolve) => {
      settle = () => resolve(undefined);
    });
    dataProcessor.subscribeCanonicalDashboardView.mockImplementation(
      (id, _sources, _context, listener) => {
        calls.push(`subscribe:${id}`);
        listener({});
        return () => {};
      },
    );
    const startup = startDashboardData(options({
      settleUi: () => settled,
      render: /** @type {Parameters<typeof startDashboardData>[0]['render']} */ ((
        _sources,
        state,
        loadPageSources,
      ) => {
        calls.push(`render:${state}`);
        if (state !== "cached") return;
        void loadPageSources("overview", {
          signal: new AbortController().signal,
          onUpdate: () => {},
        });
        void loadPageSources.subscribeBackgroundSources?.(["maintenance-campaign-updates"], {
          signal: new AbortController().signal,
          onUpdate: () => {},
        });
      }),
    }));

    await vi.waitFor(() => expect(calls).toContain("subscribe:page:overview"));
    expect(calls).not.toContain("subscribe:sources:maintenance-campaign-updates");
    expect(calls).not.toContain("refresh");

    settle();
    await startup;

    expect(calls.indexOf("subscribe:page:overview"))
      .toBeLessThan(calls.indexOf("subscribe:sources:maintenance-campaign-updates"));
    expect(calls.indexOf("subscribe:page:overview")).toBeLessThan(calls.indexOf("refresh"));
  });

  it("starts ingestion after settling when an empty cache emits no page snapshot", async () => {
    dataProcessor.subscribeCanonicalDashboardView.mockImplementation(() => () => {});

    await startDashboardData(options());

    expect(calls).toEqual([
      "render:cached",
      "settle",
      "automatic",
      "refresh",
    ]);
  });

  it("downloads current deployed data when a refresh is requested", async () => {
    dataProcessor.refreshCanonicalDashboardSources.mockResolvedValue({ changed: false });
    await startDashboardData(options());
    dataProcessor.refreshCanonicalDashboardSources.mockClear();

    window.dispatchEvent(new Event("dashboard-refresh-request"));

    expect(dataProcessor.refreshCanonicalDashboardSources).toHaveBeenCalledOnce();
  });

  it("keeps remote navigation mounted when the revision is unchanged", async () => {
    const marker = document.createElement("meta");
    marker.name = "dashboard-data-backend";
    marker.content = "redis-http";
    document.head.append(marker);
    const root = document.createElement("div");
    root.id = "root";
    const dashboard = document.createElement("div");
    dashboard.className = "dashboard-root dashboard-refreshing";
    dashboard.setAttribute("aria-busy", "true");
    root.append(dashboard);
    document.body.append(root);
    dataProcessor.refreshCanonicalDashboardSources.mockResolvedValue({ changed: false });

    await startDashboardData(options({
      render: (
        /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ _sources,
        /** @type {'ready' | 'cached' | 'stale'} */ state,
      ) => calls.push(`render:${state}`),
    }));
    await vi.waitFor(() => expect(dataProcessor.refreshCanonicalDashboardSources).toHaveBeenCalled());
    await vi.waitFor(() => expect(dashboard.classList.contains("dashboard-refreshing")).toBe(false));

    expect(calls).toEqual(["render:cached", "settle"]);
    expect(root.firstElementChild).toBe(dashboard);
    expect(dashboard.hasAttribute("aria-busy")).toBe(false);
    expect(updates.startAutomaticDashboardDataUpdates).not.toHaveBeenCalled();
  });

  it("paginates view aliases and reloads only the originating view", async () => {
    const alias = "view:runs:timeline:runs-table";
    const page = {
      source: alias,
      rows: [{ run: "2" }],
      continuationToken: "next",
      metadata: { "total-row-count": 2 },
    };
    /** @type {((pageId: string, options: { signal: AbortSignal, onUpdate: () => void }) => Promise<Record<string, import('../../src/presenter.js').LogicalSourceInput>>) | undefined} */
    let loadPageSources;
    dataProcessor.subscribeCanonicalDashboardView.mockImplementation(
      (_id, _sources, _context, listener) => {
        listener({ [alias]: page });
        return () => {};
      },
    );
    dataProcessor.loadCanonicalDashboardPage.mockResolvedValue({
      [alias]: {
        ...page,
        rows: [{ run: "1" }],
        continuationToken: undefined,
      },
    });

    await startDashboardData(options({
      pageSourceNames: () => ["runs-table"],
      pagePaginatedSourceBindings: () => ({
        [alias]: { sourceName: "runs-table", viewId: "timeline" },
      }),
      render: (
        /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ _sources,
        /** @type {'ready' | 'cached' | 'stale'} */ state,
        /** @type {(pageId: string, options: { signal: AbortSignal, onUpdate: () => void }) => Promise<Record<string, import('../../src/presenter.js').LogicalSourceInput>>} */ loader,
      ) => {
        calls.push(`render:${state}`);
        loadPageSources = loader;
      },
    }));

    const loader = loadPageSources;
    if (!loader) throw new Error("Page source loader was not registered.");
    const sources = await loader("runs", {
      signal: new AbortController().signal,
      onUpdate: () => {},
    });
    const loadContinuation = sources[alias]?.loadContinuation;
    if (!loadContinuation) throw new Error("Continuation loader was not bound.");
    await loadContinuation("next");

    expect(dataProcessor.subscribeCanonicalDashboardView).toHaveBeenCalledWith(
      "page:runs",
      ["runs-table"],
      expect.anything(),
      expect.any(Function),
      { [alias]: { limit: 25 } },
      expect.objectContaining({ pageId: "runs" }),
    );
    expect(dataProcessor.loadCanonicalDashboardPage).toHaveBeenLastCalledWith(
      ["runs-table"],
      expect.anything(),
      { [alias]: { limit: 25, continuationToken: "next" } },
      expect.objectContaining({ pageId: "runs", viewId: "timeline" }),
    );
  });
});
