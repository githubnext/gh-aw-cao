import { renderIndexedDBUnsupported } from "./components/browser-support.js";
import { disableRemoteDashboardPwa, usesRemoteDataBackend } from "./remote-data-backend.js";
import { createDebug } from "./debug.js";
import { clearBrowserDashboardApp } from "./components/reset-dashboard-control.js";

const debugMain = createDebug("main");

const root = document.querySelector("#root");
if (!(root instanceof HTMLElement)) throw new Error("Dashboard root element is missing.");

if (new URL(location.href).searchParams.get("clear-app") === "1") {
  try {
    await clearBrowserDashboardApp();
    const url = new URL(location.href);
    url.searchParams.delete("clear-app");
    location.replace(url.href);
  } catch {
    root.textContent = "Could not clear the app. Close other dashboard tabs and try again.";
  }
} else {
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
}
