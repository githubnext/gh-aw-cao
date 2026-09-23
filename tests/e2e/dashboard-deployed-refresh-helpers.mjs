import { isSpuriousAbortAfterSuccessResponse } from "./dashboard-view-assessment.mjs";

export const deployedDashboardUrl = "https://githubnext.github.io/gh-aw-cao/cao/";
export const populatedDashboardPages = [
  { pageId: "repositories", storeName: "repositories" },
  { pageId: "workflows", storeName: "workflows" },
  { pageId: "runs", storeName: "runs" },
];
const deployedDashboardBase = new URL(deployedDashboardUrl);
const deployedActivityShardDirectories = new Set(["gh-aw-logs-runs", "gh-aw-logs-records"]);

export function deployedActivityShardEntries(manifest) {
  const entries = Object.entries(manifest ?? {})
    .filter(([, hash]) => typeof hash === "string" && /^[a-f0-9]{64}$/i.test(hash));
  const select = (extension) => entries
    .filter(([name]) => {
      const [directory, filename, ...extraSegments] = name.split("/");
      return deployedActivityShardDirectories.has(directory)
        && extraSegments.length === 0
        && filename?.endsWith(extension);
    })
    .map(([sourceName, hash]) => ({
      sourceName,
      name: extension === ".json" ? sourceName.replace(/\.json$/, ".jsonl") : sourceName,
      hash,
    }))
    .sort((left, right) => {
      const leftPhase = left.name.startsWith("gh-aw-logs-runs/") ? 0 : 1;
      const rightPhase = right.name.startsWith("gh-aw-logs-runs/") ? 0 : 1;
      return leftPhase - rightPhase || left.name.localeCompare(right.name);
    });
  const current = select(".jsonl");
  const selected = current.some(({ name }) => name.startsWith("gh-aw-logs-runs/"))
    ? current
    : select(".json");
  if (!selected.some(({ name }) => name.startsWith("gh-aw-logs-runs/"))) {
    throw new Error("Deployed dashboard manifest contains no compacted run-information shards.");
  }
  return selected;
}

export function legacyPhaseJsonToJsonl(content) {
  const payload = JSON.parse(Buffer.isBuffer(content) ? content.toString("utf8") : String(content));
  if (!payload?.batch || typeof payload.batch !== "object" || !["runs", "records"].includes(payload.phase)) {
    throw new Error("Legacy deployed phase payload is invalid.");
  }
  const records = Object.entries(payload.batch).flatMap(([collection, values]) => {
    if (!Array.isArray(values)) throw new Error(`Legacy deployed phase collection ${collection} is invalid.`);
    return values.map((record) => ({ kind: "record", collection, record }));
  });
  return [
    {
      kind: "metadata",
      schemaVersion: payload.schemaVersion,
      ingestionVersion: 3,
      sourceRecords: payload.sourceRecords,
      phase: payload.phase,
      records: records.length,
    },
    ...records,
  ].map((line) => JSON.stringify(line)).join("\n") + "\n";
}

export function shouldIgnoreRequestFailure({ method, url, errorText, reloading = false, hadSuccessResponse = false }) {
  return isSpuriousAbortAfterSuccessResponse(errorText, hadSuccessResponse)
    || errorText === "net::ERR_ABORTED" && (
    reloading || isDeployedDashboardShardProbe({ method, url })
  );
}

function isDeployedDashboardShardProbe({ method, url }) {
  if (method !== "HEAD" || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    // Match flat deployed activity JSONL shard filenames in the run-information and record shard directories.
    return parsed.origin === deployedDashboardBase.origin
      && parsed.pathname.startsWith(deployedDashboardBase.pathname)
      && isFlatDeployedActivityShardPath(parsed.pathname.slice(deployedDashboardBase.pathname.length));
  } catch {
    return false;
  }
}

function isFlatDeployedActivityShardPath(relativePath) {
  const [directory, filename, ...extraSegments] = relativePath.split("/");
  return deployedActivityShardDirectories.has(directory)
    && extraSegments.length === 0
    && typeof filename === "string"
    && filename.length > 0
    && filename.endsWith(".jsonl");
}

export async function scrollRenderedViewsIntoView(activePage) {
  const viewHandles = await activePage.locator("[data-view-id]").elementHandles();
  try {
    for (const viewHandle of viewHandles) {
      try {
        await viewHandle.evaluate((element) => {
          element.scrollIntoView({ block: "center", inline: "nearest" });
          if (element.matches("[data-lazy-view]")) {
            element.focus({ preventScroll: true });
          }
        });
      } catch (error) {
        if (!isDetachedViewError(error)) throw error;
      }
    }
  } finally {
    await Promise.allSettled(viewHandles.map((viewHandle) => viewHandle.dispose()));
  }
}

function isDetachedViewError(error) {
  const name = error && typeof error === "object" && "name" in error
    ? String(error.name)
    : "";
  const message = error instanceof Error ? error.message : String(error);
  return name === "DetachedElementError"
    || /Element is not attached to the DOM|Execution context was destroyed/i.test(message);
}
