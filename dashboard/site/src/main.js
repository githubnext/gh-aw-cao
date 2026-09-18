import { renderIndexedDBUnsupported } from "./components/browser-support.js";
import { ensureOcticonSprite } from "./octicons.js";

const root = document.querySelector("#root");
if (!(root instanceof HTMLElement)) throw new Error("Dashboard root element is missing.");

if (!window.indexedDB) {
  root.replaceChildren(renderIndexedDBUnsupported());
} else {
  await ensureOcticonSprite().catch(() => undefined);
  await import("./dashboard-app.js");
}
