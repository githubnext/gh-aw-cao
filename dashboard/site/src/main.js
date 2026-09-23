import { renderIndexedDBUnsupported } from "./components/browser-support.js";
import { usesRemoteDataBackend } from "./remote-data-backend.js";

const root = document.querySelector("#root");
if (!(root instanceof HTMLElement)) throw new Error("Dashboard root element is missing.");

if (!window.indexedDB && !usesRemoteDataBackend(document)) {
  root.replaceChildren(renderIndexedDBUnsupported());
} else {
  await import("./dashboard-app.js");
}
