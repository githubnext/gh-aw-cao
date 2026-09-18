import { describe, expect, it } from "vitest";
import { renderIndexedDBUnsupported } from "../../src/components/browser-support.js";

describe("browser support", () => {
  it("renders an accessible message when IndexedDB is unavailable", () => {
    const message = renderIndexedDBUnsupported();

    expect(message.className).toBe("browser-support-message");
    expect(message.querySelector('[role="alert"]')).not.toBeNull();
    expect(message.querySelector("h1")?.textContent).toBe("Browser not supported");
    expect(message.textContent).toContain("This dashboard requires IndexedDB");
  });
});
