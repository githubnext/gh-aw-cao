// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const presenter = vi.hoisted(() => ({
  dashboardPagePaginatedSourceBindings: vi.fn(() => ({})),
  dashboardPageSourceNames: vi.fn(() => []),
  disposeDashboard: vi.fn(),
  renderDashboard: vi.fn((/** @type {import('../../src/presenter.js').PresentationInput} */ _input) => document.createElement("div")),
  updateWithViewTransition: vi.fn((_doc, callback) => callback())
}));
const dataProcessor = vi.hoisted(() => ({
  loadDashboardQuerySources: vi.fn(async (sources) => sources),
  processDashboardQueries: vi.fn(async () => ({})),
  subscribeWorkerLoadingProgress: vi.fn(() => () => {})
}));
const startup = vi.hoisted(() => ({
  startDashboardData: vi.fn(async () => {})
}));
const tableCapacity = vi.hoisted(() => ({
  applyTableQuerySafetyLimits: vi.fn((queries) => queries),
  browserTableCapacityDecision: vi.fn(() => ({ rowLimit: 25000 })),
  logTableCapacityDecision: vi.fn()
}));
const dashboardDataUpdates = vi.hoisted(() => ({
  startDashboardAppUpdates: vi.fn(() => () => {})
}));
const webmcpRuntime = vi.hoisted(() => ({
  startDashboardWebMCP: vi.fn(() => ({ refresh: vi.fn(), stop: vi.fn() })),
  supportsWebMCP: vi.fn(() => false)
}));

vi.mock("../../src/presenter.js", () => presenter);
vi.mock("../../src/loading-progress.js", () => ({ setLoadingProgressState: vi.fn() }));
vi.mock("../../src/cancel-command.js", () => ({
  offerCancelCommand: vi.fn(() => ({ complete: vi.fn() }))
}));
vi.mock("../../src/data-processor.js", () => dataProcessor);
vi.mock("../../src/data/startup.js", () => startup);
vi.mock("../../src/components/refresh-error.js", () => ({ renderRefreshError: vi.fn() }));
vi.mock("../../src/diagnostics.js", () => ({ collectFullDiagnostics: vi.fn() }));
vi.mock("../../src/dashboard-data-updates.js", () => dashboardDataUpdates);
vi.mock("../../src/components/cli-actions.js", () => ({
  attachCliActions: vi.fn(),
  setDeclaredCliActions: vi.fn()
}));
vi.mock("../../src/data/table-capacity.js", () => tableCapacity);
vi.mock("../../src/console-log-capture.js", () => ({ startConsoleLogCapture: vi.fn() }));
vi.mock("../../src/remote-data-backend.js", () => ({ usesRemoteDataBackend: vi.fn(() => false) }));
vi.mock("../../src/webmcp/runtime.js", () => webmcpRuntime);

/** @param {{ id: string, chunk?: string }} page */
function stubDashboardSchema(page) {
  return {
    "language-version": "1",
    dashboard: {
      pages: [{ ...page, "source-names": [], "lazy-source-names": [], "table-source-names": [] }],
      queries: []
    }
  };
}

/**
 * @param {ReturnType<typeof vi.fn>} debugFn
 * @param {string} search
 */
function mockDebugModule(debugFn, search) {
  const output = /** @type {Pick<Console, "debug">} */ ({ debug: debugFn });
  vi.doMock("../../src/debug.js", async () => {
    const actual = /** @type {typeof import("../../src/debug.js")} */ (
      await vi.importActual("../../src/debug.js")
    );
    return {
      ...actual,
      createDebug: (/** @type {string} */ category) =>
        actual.createDebug(category, { search: () => search, output })
    };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="root"></div>';
});

afterEach(() => {
  vi.doUnmock("../../src/debug.js");
  vi.resetModules();
  document.body.innerHTML = "";
});

describe("dashboard app page-chunk debug logging", () => {
  it("passes loaded page queries to the presenter for semantic prompts", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      if (String(input).includes("dashboard.json")) {
        return new Response(JSON.stringify(stubDashboardSchema({ id: "overview", chunk: "dashboard-pages/overview.json" })), { status: 200 });
      }
      return new Response(JSON.stringify({
        page: { id: "overview", views: [{ data: { source: "observations" }, prompt: "auto" }] },
        queries: [{ name: "observations", from: "runs", intent: "Inspect runs" }]
      }), { status: 200 });
    }));
    vi.resetModules();

    await import("../../src/dashboard-app.js");
    await vi.waitFor(() => expect(presenter.renderDashboard.mock.calls.some(
      ([argument]) => argument.document.dashboard.queries?.some((query) => query.name === "observations")
    )).toBe(true));

    vi.unstubAllGlobals();
  });

  it("is disabled by default (no debug output) when the debug query is absent", async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(stubDashboardSchema({ id: "overview", chunk: "dashboard-pages/overview.json" })), { status: 200 }))
    );
    vi.resetModules();

    await import("../../src/dashboard-app.js");
    await vi.waitFor(() => expect(dataProcessor.subscribeWorkerLoadingProgress).toHaveBeenCalled());

    expect(debugFn).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("logs a page-chunk fetch start and success outcome under its predictable category when enabled", async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, "?debug=dashboard-app");
    const chunkResponse = new Response(
      JSON.stringify({ page: { id: "overview", views: [] }, queries: [] }),
      { status: 200 }
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        const url = String(input);
        if (url.includes("dashboard.json")) {
          return new Response(JSON.stringify(stubDashboardSchema({ id: "overview", chunk: "dashboard-pages/overview.json" })), { status: 200 });
        }
        return chunkResponse.clone();
      })
    );
    vi.resetModules();

    await import("../../src/dashboard-app.js");
    await vi.waitFor(() => expect(dataProcessor.subscribeWorkerLoadingProgress).toHaveBeenCalled());

    const calls = debugFn.mock.calls.filter(([prefix]) => prefix === "[cao:dashboard-app]");
    expect(calls.some(([, payload]) => payload.event === "page-chunk-fetch-start" && payload.pageId === "overview")).toBe(true);
    expect(calls.some(([, payload]) => payload.event === "page-chunk-fetch-outcome" && payload.pageId === "overview" && payload.status === "success")).toBe(true);
    vi.unstubAllGlobals();
  });

  it("logs a sanitized error name when the page-chunk fetch fails", async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, "?debug=dashboard-app");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        const url = String(input);
        if (url.includes("dashboard.json")) {
          return new Response(JSON.stringify(stubDashboardSchema({ id: "overview", chunk: "dashboard-pages/overview.json" })), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      })
    );
    vi.resetModules();

    await import("../../src/dashboard-app.js").catch(() => {});
    await vi.waitFor(() => {
      const calls = debugFn.mock.calls.filter(([prefix]) => prefix === "[cao:dashboard-app]");
      expect(calls.some(([, payload]) => payload.event === "page-chunk-fetch-outcome" && payload.status === "error")).toBe(true);
    });

    const calls = debugFn.mock.calls.filter(([prefix]) => prefix === "[cao:dashboard-app]");
    const errorCall = calls.find(([, payload]) => payload.event === "page-chunk-fetch-outcome" && payload.status === "error");
    expect(errorCall).toBeDefined();
    expect(errorCall?.[1].errorName).toBe("Error");
    expect(JSON.stringify(errorCall?.[1])).not.toContain("404");
    vi.unstubAllGlobals();
  });

  it("never logs anything beyond scalar metadata", async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, "?debug=dashboard-app");
    const chunkResponse = new Response(
      JSON.stringify({ page: { id: "overview", views: [] }, queries: [] }),
      { status: 200 }
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        const url = String(input);
        if (url.includes("dashboard.json")) {
          return new Response(JSON.stringify(stubDashboardSchema({ id: "overview", chunk: "dashboard-pages/overview.json" })), { status: 200 });
        }
        return chunkResponse.clone();
      })
    );
    vi.resetModules();

    await import("../../src/dashboard-app.js");
    await vi.waitFor(() => expect(dataProcessor.subscribeWorkerLoadingProgress).toHaveBeenCalled());

    const calls = debugFn.mock.calls.filter(([prefix]) => prefix === "[cao:dashboard-app]");
    expect(calls.length).toBeGreaterThan(0);
    for (const [, payload] of calls) {
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean").toBe(true);
      }
    }
    vi.unstubAllGlobals();
  });
});
