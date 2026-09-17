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
