export function shouldIgnoreRequestFailure({ method, url, errorText, reloading = false }) {
  return errorText === "net::ERR_ABORTED" && (
    reloading || isDeployedDashboardShardProbe({ method, url })
  );
}

function isDeployedDashboardShardProbe({ method, url }) {
  if (method !== "HEAD" || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://githubnext.github.io"
      && /^\/gh-aw-cao\/cao\/(?:gh-aw-logs-(?:runs|records)\/)?[^/]+\.json$/.test(parsed.pathname);
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
    } catch {
      // Ignore views that are replaced while lazy content hydrates.
    } finally {
      await viewHandle.dispose();
    }
  }
}
