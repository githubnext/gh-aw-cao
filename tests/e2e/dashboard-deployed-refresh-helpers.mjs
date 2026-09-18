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
    // Match flat deployed activity JSON shard filenames in the run-information and record shard directories.
    return parsed.origin === deployedDashboardBase.origin
      && parsed.pathname.startsWith(deployedDashboardBase.pathname)
      && /^gh-aw-logs-(?:runs|records)\/[^/]+\.json$/.test(
        parsed.pathname.slice(deployedDashboardBase.pathname.length)
      );
  } catch {
    return false;
  }
}

export async function scrollRenderedViewsIntoView(activePage) {
  const viewHandles = await activePage.locator("[data-view-id]").elementHandles();
  let unexpectedError;
  for (const viewHandle of viewHandles) {
    try {
      if (!unexpectedError) {
        await viewHandle.evaluate((element) => {
          element.scrollIntoView({ block: "center", inline: "nearest" });
        });
      }
    } catch (error) {
      if (!isDetachedViewError(error)) unexpectedError = error;
    } finally {
      await viewHandle.dispose();
    }
  }
  if (unexpectedError) throw unexpectedError;
}

function isDetachedViewError(error) {
  const name = error && typeof error === "object" && "name" in error
    ? String(error.name)
    : "";
  const message = error instanceof Error ? error.message : String(error);
  return name === "DetachedElementError"
    || /Element is not attached to the DOM|Execution context was destroyed/i.test(message);
}
