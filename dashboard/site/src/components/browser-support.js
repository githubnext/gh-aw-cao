import { h } from "../dom.js";
import { getPrimerStyles } from "../styles.js";

/**
 * @returns {HTMLElement}
 */
export function renderIndexedDBUnsupported() {
  return h(
    "main",
    { className: "browser-support-message" },
    h("style", null, getPrimerStyles()),
    h(
      "section",
      {
        className: "browser-support-message-panel",
        role: "alert",
        "aria-labelledby": "browser-support-message-title",
      },
      h("h1", { id: "browser-support-message-title" }, "Browser not supported"),
      h(
        "p",
        null,
        "This dashboard requires IndexedDB, but it is not available in this browser. Open the dashboard in a browser that supports IndexedDB.",
      ),
    ),
  );
}
