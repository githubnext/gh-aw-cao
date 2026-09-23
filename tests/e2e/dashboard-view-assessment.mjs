import { elementLoadsSourcesAsync } from "../../dashboard/site/src/components/ui-elements.js";
import { resolveDashboardDocument } from "../../dashboard/site/src/dashboard-chunks.js";
import { renderDashboardQueryUsageGraph } from "../../dashboard/site/src/query-usage.js";

// Pages excluded from the informational dashboard view assessment.
export const ignoredDashboardPageIds = ["operations", "readiness"];

export function isIgnoredDashboardPageId(pageId) {
  return ignoredDashboardPageIds.includes(pageId);
}

export function withoutIgnoredDashboardPageIds(pageIds) {
  return pageIds.filter((pageId) => !isIgnoredDashboardPageId(pageId));
}

// Views hidden by the page's view-mode selection (a declared full-view table is
// hidden while the page shows its charts) keep their lazy-view skeleton, and that
// skeleton stays `aria-busy` until the reader selects it. Only views the reader
// can actually see are assessed, so hidden views neither block hydration nor
// consume the assessment's time budget.
export const visibleViewSelector = "[data-view-id]:visible";
export const visibleBusyViewSelector = '[aria-busy="true"]:visible';
export const visibleLoadingViewSelector =
  ".dashboard-view-skeleton:visible, .dashboard-lazy-view-skeleton:visible";

export function declaredDashboardViewIds(pageDefinition, reusableViews = []) {
  const views = pageDefinition?.kind === "built-in"
    ? pageDefinition.definition?.views
    : pageDefinition?.views;
  const reusableViewIds = new Set(
    reusableViews.flatMap((view) => (
      typeof view === "object" && view !== null && typeof view.id === "string" ? [view.id] : []
    )),
  );
  return (Array.isArray(views) ? views : [])
    .map((view, index) => (
      typeof view === "object" && view !== null && typeof view.id === "string"
        ? view.id
        : typeof view === "string" && reusableViewIds.has(view) ? view : `view-${index + 1}`
    ));
}

export function dashboardPageRendersBeforeSources(pageDefinition, reusableViews = []) {
  const reusableById = new Map(reusableViews.map((view) => [view?.id, view]));
  const views = pageDefinition?.kind === "built-in"
    ? pageDefinition.definition?.views
    : pageDefinition?.views;
  return Array.isArray(views) && views.some((configured) => {
    const view = typeof configured === "string" ? reusableById.get(configured) : configured;
    return typeof view === "object"
      && view !== null
      && typeof view.element === "string"
      && elementLoadsSourcesAsync(view.element);
  });
}

export function renderAssessedDashboardQueryUsageGraph(dashboard, pageChunks) {
  const resolved = resolveDashboardDocument(dashboard, pageChunks);
  return renderDashboardQueryUsageGraph(resolved.dashboard);
}

// The assessment loads every selected page in its own browser page, so the test
// budget has to grow with the number of selected pages. The 26-minute, 40-second
// cap leaves more than three minutes of dashboard-views.yml's 30-minute job
// timeout for setup and summary upload, while allowing a margin beyond 49 views.
export const dashboardAssessmentStartupBudgetMs = 120_000;
export const dashboardAssessmentPageBudgetMs = 30_000;
export const maximumDashboardAssessmentTimeoutMs = 1_600_000;

export function dashboardAssessmentTimeout(pageCount) {
  const pages = Number.isFinite(pageCount) && pageCount > 0 ? Math.floor(pageCount) : 0;
  return Math.min(
    dashboardAssessmentStartupBudgetMs + pages * dashboardAssessmentPageBudgetMs,
    maximumDashboardAssessmentTimeoutMs,
  );
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
