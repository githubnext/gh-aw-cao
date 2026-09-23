import { renderIndexedDBUnsupported } from "./components/browser-support.js";
import { disableRemoteDashboardPwa, usesRemoteDataBackend } from "./remote-data-backend.js";

const root = document.querySelector("#root");
if (!(root instanceof HTMLElement)) throw new Error("Dashboard root element is missing.");

const remoteBackend = usesRemoteDataBackend(document);
if (!window.indexedDB && !remoteBackend) {
  root.replaceChildren(renderIndexedDBUnsupported());
} else {
  if (remoteBackend) await disableRemoteDashboardPwa();
  await import("./dashboard-app.js");
}
