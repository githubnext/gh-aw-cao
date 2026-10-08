import { disableRemoteDashboardPwa, usesRemoteDataBackend } from "./backend-mode.js";
import { createDebug } from "./debug.js";

const debugMain = createDebug("main");

const root = document.querySelector("#root");
if (!(root instanceof HTMLElement)) throw new Error("Dashboard root element is missing.");

if (new URL(location.href).searchParams.get("clear-app") === "1") {
  try {
    const { clearBrowserDashboardApp } = await import("./components/reset-dashboard-control.js");
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
  const { renderIndexedDBUnsupported } = await import("./components/browser-support.js");
  root.replaceChildren(renderIndexedDBUnsupported());
} else {
  if (remoteBackend) await disableRemoteDashboardPwa();
  await import("./dashboard-app.js");
  debugMain({ event: "dashboard-app-loaded", remoteBackend });
}
}
