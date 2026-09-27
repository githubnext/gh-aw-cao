// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIndexedDBUnsupported } from "../../src/components/browser-support.js";

afterEach(() => {
  vi.doUnmock("../../src/debug.js");
  vi.resetModules();
});

describe("browser support", () => {
  it("renders an accessible message when IndexedDB is unavailable", () => {
    const message = renderIndexedDBUnsupported();

    expect(message.className).toBe("browser-support-message");
    expect(message.querySelector('[role="alert"]')).not.toBeNull();
    expect(message.querySelector("h1")?.textContent).toBe("Browser not supported");
    expect(message.textContent).toContain("This dashboard requires IndexedDB");
  });

  it("does not log when the debug query is absent", async () => {
    const output = { debug: vi.fn() };
    vi.doMock("../../src/debug.js", async () => {
      const actual = /** @type {typeof import("../../src/debug.js")} */ (
        await vi.importActual("../../src/debug.js")
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => "", output })
      };
    });
    vi.resetModules();
    const { renderIndexedDBUnsupported: renderForTest } = await import("../../src/components/browser-support.js");

    renderForTest();

    expect(output.debug).not.toHaveBeenCalled();
  });

  it("logs a scalar event under its predictable category when enabled", async () => {
    const output = { debug: vi.fn() };
    vi.doMock("../../src/debug.js", async () => {
      const actual = /** @type {typeof import("../../src/debug.js")} */ (
        await vi.importActual("../../src/debug.js")
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => "?debug=browser-support", output })
      };
    });
    vi.resetModules();
    const { renderIndexedDBUnsupported: renderForTest } = await import("../../src/components/browser-support.js");

    renderForTest();

    expect(output.debug).toHaveBeenCalledWith(
      "[cao:browser-support]",
      { event: "indexeddb-unsupported" }
    );

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === "string" || typeof value === "number").toBe(true);
      }
    }
  });
});
