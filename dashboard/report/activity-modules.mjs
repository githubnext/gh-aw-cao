import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The activity runtime is authored and installed at .github/aw/activity. The
// dashboard report scripts run either from that installed layout
// (.github/aw/dashboard/report) or from the catalog source layout
// (dashboard/report), so resolve both before loading the shared helpers.
const ACTIVITY_ROOT_CANDIDATES = ["../../activity/", "../../.github/aw/activity/"];
const PROBE_MODULE = "actions-log.mjs";

function resolveActivityRoot() {
  for (const candidate of ACTIVITY_ROOT_CANDIDATES) {
    const root = new URL(candidate, import.meta.url);
    if (existsSync(fileURLToPath(new URL(PROBE_MODULE, root)))) {
      return root;
    }
  }
  throw new Error("Activity runtime modules are unavailable for the dashboard report scripts");
}

const activityRoot = resolveActivityRoot();

function loadActivityModule(specifier) {
  return import(new URL(specifier, activityRoot).href);
}

export const { actionsLog } = await loadActivityModule("actions-log.mjs");
export const { setActionsGlobals } = await loadActivityModule("actions-context.mjs");
export const { parseGhAwLogsJsonl } = await loadActivityModule("gh-aw-logs.mjs");
