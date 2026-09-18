export function shouldIgnoreRequestFailure({ method, errorText, reloading = false }) {
  return errorText === "net::ERR_ABORTED" && (reloading || method === "HEAD");
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
