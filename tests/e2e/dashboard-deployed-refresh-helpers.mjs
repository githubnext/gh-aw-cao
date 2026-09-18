export const deployedDashboardUrl = "https://githubnext.github.io/gh-aw-cao/cao/";
const deployedDashboardBase = new URL(deployedDashboardUrl);

export function shouldIgnoreRequestFailure({ method, url, errorText, reloading = false }) {
  return errorText === "net::ERR_ABORTED" && (
    reloading || isDeployedDashboardShardProbe({ method, url })
  );
}

function isDeployedDashboardShardProbe({ method, url }) {
  if (method !== "HEAD" || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    // Match deployed activity JSON shard probes, including phased run and record shards.
    return parsed.origin === deployedDashboardBase.origin
      && parsed.pathname.startsWith(deployedDashboardBase.pathname)
      && /^(?:gh-aw-logs-(?:runs|records)\/)?[^/]+\.json$/.test(
        parsed.pathname.slice(deployedDashboardBase.pathname.length)
      );
  } catch {
    return false;
  }
}

export async function scrollRenderedViewsIntoView(activePage) {
  const viewHandles = await activePage.locator("[data-view-id]").elementHandles();
  for (const viewHandle of viewHandles) {
    try {
      await viewHandle.evaluate((element) => {
        element.scrollIntoView({ block: "center", inline: "nearest" });
      });
    } catch (error) {
      if (!isDetachedViewError(error)) throw error;
    } finally {
      await viewHandle.dispose();
    }
  }
}

function isDetachedViewError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /not attached|detached|Execution context was destroyed|Cannot find context/i.test(message);
}
