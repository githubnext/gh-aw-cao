import { renderIndexedDBUnsupported } from "./components/browser-support.js";
import { disableRemoteDashboardPwa, usesRemoteDataBackend } from "./remote-data-backend.js";
import { createDebug } from "./debug.js";

const debugMain = createDebug("main");

const root = document.querySelector("#root");
if (!(root instanceof HTMLElement)) throw new Error("Dashboard root element is missing.");

const remoteBackend = usesRemoteDataBackend(document);
debugMain({ event: "backend-detected", remoteBackend, indexedDbAvailable: Boolean(window.indexedDB) });
if (!window.indexedDB && !remoteBackend) {
  debugMain({ event: "unsupported-browser-shown" });
  root.replaceChildren(renderIndexedDBUnsupported());
} else {
  if (remoteBackend) await disableRemoteDashboardPwa();
  await import("./dashboard-app.js");
  debugMain({ event: "dashboard-app-loaded", remoteBackend });
}
