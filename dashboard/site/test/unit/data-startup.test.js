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

/**
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
const runWithLoadingProgress = (task) => task();

/** @param {Record<string, unknown>} [overrides] */
function options(overrides = {}) {
  let renderedPage = false;
  return {
    browserWindow: window,
    document,
    sourceUrl: "https://example.test/dashboard/payload-hashes.json",
    dashboardContext: { pages: [], queries: [] },
    pageSourceNames: () => ["runs"],
    pageLazySourceNames: () => [],
    runWithLoadingProgress,
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
});
