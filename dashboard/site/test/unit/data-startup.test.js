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
  startAutomaticDashboardDataUpdates: vi.fn(),
}));

vi.mock("../../src/data-processor.js", () => dataProcessor);
vi.mock("../../src/dashboard-data-updates.js", () => updates);

import { startDashboardData } from "../../src/data/startup.js";

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
