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
  return {
    browserWindow: window,
    document,
    sourceUrl: "https://example.test/dashboard/gh-aw-logs.jsonl",
    dashboardContext: { pages: [], queries: [] },
    initialPageId: "overview",
    initialSources: ["runs"],
    initialLazySources: [],
    pageSourceNames: () => ["runs"],
    pageLazySourceNames: () => [],
    runWithLoadingProgress,
    render: (
      /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ _sources,
      /** @type {'ready' | 'cached' | 'stale'} */ state,
    ) => calls.push(`render:${state}`),
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
    dataProcessor.loadCanonicalDashboardPage.mockImplementation(async () => {
      calls.push("cache");
      return cachedSources;
    });
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
      "cache",
      "render:cached",
      "settle",
      "automatic",
      "refresh",
    ]);
  });

  it("tries the cache before downloading when no compatible cache exists", async () => {
    dataProcessor.loadCanonicalDashboardPage.mockImplementationOnce(async () => {
      calls.push("cache");
      throw new Error("empty cache");
    });
    dataProcessor.loadCanonicalDashboardSources.mockImplementation(async () => {
      calls.push("download");
      return cachedSources;
    });

    await startDashboardData(options());

    expect(calls).toEqual([
      "cache",
      "automatic",
      "download",
      "render:ready",
    ]);
  });
});
