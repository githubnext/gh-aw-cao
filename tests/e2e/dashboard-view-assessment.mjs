// Pages excluded from the informational dashboard view assessment.
export const ignoredDashboardPageIds = ["operations", "readiness"];

export function isIgnoredDashboardPageId(pageId) {
  return ignoredDashboardPageIds.includes(pageId);
}

export function withoutIgnoredDashboardPageIds(pageIds) {
  return pageIds.filter((pageId) => !isIgnoredDashboardPageId(pageId));
}

export function isExpectedPageCloseAbort(errorText, closing) {
  return closing && errorText === "net::ERR_ABORTED";
}

// Some Chromium builds report a spurious "requestfailed" (net::ERR_ABORTED)
// for a request that already received a successful response, most often for
// fetch() calls made from a Web Worker (as the dashboard's data ingestion
// worker does when probing and downloading activity shards). The request
// still delivered its response to the application; only the browser's own
// bookkeeping considers it aborted, so it should not fail the assessment.
export function isSpuriousAbortAfterSuccessResponse(errorText, hadSuccessResponse) {
  return errorText === "net::ERR_ABORTED" && hadSuccessResponse === true;
}
