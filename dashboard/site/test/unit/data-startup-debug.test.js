import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dataProcessor = vi.hoisted(() => ({
  loadDashboardSnapshotMetadata: vi.fn(),
  loadCanonicalDashboardPage: vi.fn(),
  subscribeDatabaseUpgrade: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.doUnmock("../../src/debug.js");
  vi.resetModules();
});

describe("dashboard data startup debug logging", () => {
  it("is disabled by default (no debug output) when the debug query is absent", async () => {
    const output = { debug: vi.fn() };
    vi.doMock("../../src/debug.js", async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual("../../src/debug.js")
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => "", output }),
      };
    });
    vi.resetModules();
    const { createBatchedSourceLoader } = await import("../../src/data/startup.js");

    dataProcessor.loadCanonicalDashboardPage.mockResolvedValue({ runs: { source: "runs", rows: [] } });
    const loader = createBatchedSourceLoader({ pages: [], queries: [] });
    await loader("runs", {});

    expect(output.debug).not.toHaveBeenCalled();
  });

  it("logs the batched-source-flush request and group counts under its predictable category when enabled", async () => {
    const output = { debug: vi.fn() };
    vi.doMock("../../src/debug.js", async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual("../../src/debug.js")
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => "?debug=startup", output }),
      };
    });
    vi.resetModules();
    const { createBatchedSourceLoader } = await import("../../src/data/startup.js");

    dataProcessor.loadCanonicalDashboardPage.mockResolvedValue({
      runs: { source: "runs", rows: [] },
      outcomes: { source: "outcomes", rows: [] },
    });
    const loader = createBatchedSourceLoader({ pages: [], queries: [] });
    await Promise.all([
      loader("runs", { pageId: "overview" }),
      loader("outcomes", { pageId: "problems" }),
    ]);

    expect(output.debug).toHaveBeenCalledWith(
      "[cao:startup]",
      { op: "batched-source-flush", requestCount: 2, groupCount: 2 },
    );
  });

  it("logs the initial subscription error with a sanitized error name only", async () => {
    const output = { debug: vi.fn() };
    vi.doMock("../../src/debug.js", async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual("../../src/debug.js")
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => "?debug=startup", output }),
      };
    });
    vi.resetModules();
    const { startDashboardData } = await import("../../src/data/startup.js");

    dataProcessor.loadCanonicalDashboardPage.mockImplementation(async (sourceNames = []) =>
      sourceNames.length === 0 ? {} : { runs: { source: "runs", rows: [] } }
    );
    dataProcessor.loadDashboardSnapshotMetadata.mockResolvedValue({
      createdAt: "2026-09-28T12:00:00.000Z",
    });
    dataProcessor.subscribeDatabaseUpgrade.mockReturnValue(() => {});
    dataProcessor.refreshCanonicalDashboardSources.mockImplementation(() => new Promise(() => {}));
    updates.startAutomaticDashboardDataUpdates.mockImplementation(() => () => {});

    let rejectPageLoad = () => {};
    dataProcessor.subscribeCanonicalDashboardView.mockImplementation(
      (_id, _sourceNames, _context, _listener, _pagination, subscribeOptions) => {
        rejectPageLoad = () => subscribeOptions.onError(new TypeError("connection reset with token abc123"));
        return () => {};
      },
    );

    await startDashboardData({
      browserWindow: window,
      document,
      sourceUrl: "https://example.test/dashboard/payload-hashes.json",
      dashboardContext: { pages: [], queries: [] },
      pageSourceNames: () => ["runs"],
      pagePaginatedSourceBindings: () => ({}),
      render: (
        /** @type {Record<string, unknown>} */ _sources,
        /** @type {'ready' | 'loading' | 'cached' | 'stale'} */ _state,
        /** @type {(pageId: string, options: { signal: AbortSignal, onUpdate: () => void }) => Promise<unknown>} */ loadPageSources,
      ) => {
        void loadPageSources("overview", { signal: new AbortController().signal, onUpdate: () => {} }).catch(() => {});
      },
      settleUi: async () => {},
    });
    rejectPageLoad();
    await Promise.resolve();
    await Promise.resolve();

    const startupCalls = output.debug.mock.calls.filter(([prefix]) => prefix === "[cao:startup]");
    expect(startupCalls.some(([, payload]) => payload.op === "subscribe-sources" && payload.status === "initial-error")).toBe(true);
    for (const [, payload] of startupCalls) {
      for (const value of Object.values(payload)) {
        expect(typeof value === "string" || typeof value === "number").toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain("connection reset");
      expect(JSON.stringify(payload)).not.toContain("abc123");
    }
  });
});
