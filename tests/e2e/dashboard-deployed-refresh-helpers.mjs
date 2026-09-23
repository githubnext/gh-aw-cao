import { isSpuriousAbortAfterSuccessResponse } from "./dashboard-view-assessment.mjs";

export const deployedDashboardUrl = "https://githubnext.github.io/gh-aw-cao/cao/";
export const populatedDashboardPages = [
  { pageId: "repositories", storeName: "repositories" },
  { pageId: "workflows", storeName: "workflows" },
  { pageId: "runs", storeName: "runs" },
];
const deployedDashboardBase = new URL(deployedDashboardUrl);
const deployedActivityShardDirectories = new Set(["gh-aw-logs-runs", "gh-aw-logs-records"]);

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
    // Match flat deployed activity JSON shard filenames in the run-information and record shard directories.
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
    && filename.endsWith(".json");
}

export async function scrollRenderedViewsIntoView(activePage) {
  const viewHandles = await activePage.locator("[data-view-id]").elementHandles();
  try {
    for (const viewHandle of viewHandles) {
      try {
        await viewHandle.evaluate((element) => {
          element.scrollIntoView({ block: "center", inline: "nearest" });
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
