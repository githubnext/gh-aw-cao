// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../../src/debug.js");
  vi.doUnmock("../../src/components/browser-support.js");
  vi.doUnmock("../../src/remote-data-backend.js");
  vi.doUnmock("../../src/dashboard-app.js");
  vi.resetModules();
  document.body.innerHTML = "";
});

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
      createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => search, output })
    };
  });
}

/** @param {boolean} remoteBackend */
function mockRemoteBackendModule(remoteBackend) {
  vi.doMock("../../src/remote-data-backend.js", () => ({
    usesRemoteDataBackend: () => remoteBackend,
    disableRemoteDashboardPwa: vi.fn(async () => {})
  }));
}

function mockDashboardAppModule() {
  vi.doMock("../../src/dashboard-app.js", () => ({}));
}

function mockBrowserSupportModule() {
  vi.doMock("../../src/components/browser-support.js", () => ({
    renderIndexedDBUnsupported: () => document.createElement("div")
  }));
}

describe("main debug logging", () => {
  it("is disabled by default (no debug output) when the debug query is absent", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const debugFn = vi.fn();
    mockDebugModule(debugFn, "");
    mockRemoteBackendModule(false);
    mockDashboardAppModule();
    mockBrowserSupportModule();
    vi.resetModules();

    await import("../../src/main.js");

    expect(debugFn).not.toHaveBeenCalled();
  });

  it("logs backend detection and dashboard-app load events under its predictable category when enabled", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const debugFn = vi.fn();
    mockDebugModule(debugFn, "?debug=main");
    mockRemoteBackendModule(false);
    mockDashboardAppModule();
    mockBrowserSupportModule();
    vi.resetModules();

    await import("../../src/main.js");

    expect(debugFn).toHaveBeenCalledWith(
      "[cao:main]",
      expect.objectContaining({ event: "backend-detected", remoteBackend: false })
    );
    expect(debugFn).toHaveBeenCalledWith(
      "[cao:main]",
      expect.objectContaining({ event: "dashboard-app-loaded", remoteBackend: false })
    );
  });

  it("logs the unsupported-browser event instead of loading the dashboard app when IndexedDB is unavailable", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const originalIndexedDb = window.indexedDB;
    Object.defineProperty(window, "indexedDB", { configurable: true, value: undefined });
    try {
      const debugFn = vi.fn();
      mockDebugModule(debugFn, "?debug=main");
      mockRemoteBackendModule(false);
      mockDashboardAppModule();
      mockBrowserSupportModule();
      vi.resetModules();

      await import("../../src/main.js");

      expect(debugFn).toHaveBeenCalledWith("[cao:main]", { event: "unsupported-browser-shown" });
      expect(debugFn).not.toHaveBeenCalledWith(
        "[cao:main]",
        expect.objectContaining({ event: "dashboard-app-loaded" })
      );
    } finally {
      Object.defineProperty(window, "indexedDB", { configurable: true, value: originalIndexedDb });
    }
  });

  it("never logs anything beyond scalar boolean metadata", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const debugFn = vi.fn();
    mockDebugModule(debugFn, "?debug=main");
    mockRemoteBackendModule(true);
    mockDashboardAppModule();
    mockBrowserSupportModule();
    vi.resetModules();

    await import("../../src/main.js");

    for (const call of debugFn.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === "string" || typeof value === "number" || typeof value === "boolean").toBe(true);
      }
    }
  });
});
