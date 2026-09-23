import assert from "node:assert/strict";
import { test } from "node:test";
import dashboardViewsConfig from "../playwright/configs/dashboard-views.config.mjs";
import {
  dashboardAssessmentPageBudgetMs,
  dashboardAssessmentStartupBudgetMs,
  dashboardAssessmentTimeout,
  dashboardPageRendersBeforeSources,
  declaredDashboardViewIds,
  ignoredDashboardPageIds,
  isExpectedPageCloseAbort,
  isIgnoredDashboardPageId,
  isSpuriousAbortAfterSuccessResponse,
  maximumDashboardAssessmentTimeoutMs,
  renderAssessedDashboardQueryUsageGraph,
  visibleBusyViewSelector,
  visibleLoadingViewSelector,
  visibleViewSelector,
  withoutIgnoredDashboardPageIds,
} from "../e2e/dashboard-view-assessment.mjs";

test("assesses only the views a reader can see", () => {
  assert.equal(visibleViewSelector, "[data-view-id]:visible");
  assert.equal(visibleBusyViewSelector, '[aria-busy="true"]:visible');
  assert.equal(
    visibleLoadingViewSelector,
    ".dashboard-view-skeleton:visible, .dashboard-lazy-view-skeleton:visible",
  );
});

test("finds declared views in loaded custom and built-in page definitions", () => {
  assert.deepEqual(declaredDashboardViewIds({
    kind: "custom",
    views: [{ id: "summary" }, { mark: "table" }, "shared-view"],
  }, [{ id: "shared-view" }]), ["summary", "view-2", "shared-view"]);
  assert.deepEqual(declaredDashboardViewIds({
    kind: "built-in",
    definition: { views: [{ id: "details" }] },
  }), ["details"]);
  assert.deepEqual(declaredDashboardViewIds({ kind: "custom" }), []);
});

test("identifies pages that render before companion sources resolve", () => {
  assert.equal(dashboardPageRendersBeforeSources({
    kind: "custom",
    views: [{ element: "factory-header" }],
  }), true);
  assert.equal(dashboardPageRendersBeforeSources({
    kind: "custom",
    views: ["shared-table"],
  }, [{ id: "shared-table", mark: "table" }]), false);
  assert.equal(dashboardPageRendersBeforeSources({
    kind: "built-in",
    definition: { views: [{ mark: "table" }] },
  }), false);
});

test("renders the assessed page chunks as a view-query graph", () => {
  const dashboard = {
    "language-version": "0.1.0",
    dashboard: {
      queries: [],
      pages: [
        { id: "overview", kind: "custom", chunk: "dashboard-pages/overview.json" },
        { id: "cost", kind: "custom", chunk: "dashboard-pages/cost.json" },
      ],
    },
  };
  const graph = renderAssessedDashboardQueryUsageGraph(dashboard, [{
    page: {
      id: "overview",
      kind: "custom",
      views: [{ id: "run-count", data: { source: "used" } }],
    },
    queries: [{ name: "used", from: "runs" }],
  }]);

  assert.equal(graph, `flowchart LR
  n0["Query: used"]
  n1["View: overview / run-count"]
  n1 --> n0`);
  assert.doesNotMatch(graph, /cost/);
});

test("grows the assessment timeout with the number of selected views", () => {
  assert.equal(
    dashboardAssessmentTimeout(1),
    dashboardAssessmentStartupBudgetMs + dashboardAssessmentPageBudgetMs,
  );
  assert.equal(
    dashboardAssessmentTimeout(10),
    dashboardAssessmentStartupBudgetMs + 10 * dashboardAssessmentPageBudgetMs,
  );
  assert.equal(dashboardAssessmentTimeout(0), dashboardAssessmentStartupBudgetMs);
  assert.equal(dashboardAssessmentTimeout(undefined), dashboardAssessmentStartupBudgetMs);
  assert.equal(
    dashboardAssessmentTimeout(49),
    dashboardAssessmentStartupBudgetMs + 49 * dashboardAssessmentPageBudgetMs,
  );
  assert.equal(dashboardAssessmentTimeout(50), maximumDashboardAssessmentTimeoutMs);
  assert.equal(
    dashboardAssessmentTimeout(69),
    maximumDashboardAssessmentTimeoutMs,
  );
  assert.equal(dashboardAssessmentTimeout(75), maximumDashboardAssessmentTimeoutMs);
  assert.equal(dashboardAssessmentTimeout(10_000), maximumDashboardAssessmentTimeoutMs);
});

test("configures Playwright with the bounded assessment timeout", () => {
  assert.equal(dashboardViewsConfig.timeout, maximumDashboardAssessmentTimeoutMs);
});

test("ignores request aborts caused by closing an assessed page", () => {
  assert.equal(isExpectedPageCloseAbort("net::ERR_ABORTED", true), true);
  assert.equal(isExpectedPageCloseAbort("net::ERR_ABORTED", false), false);
  assert.equal(isExpectedPageCloseAbort("net::ERR_FAILED", true), false);
});

test("ignores request aborts reported after a successful response", () => {
  assert.equal(isSpuriousAbortAfterSuccessResponse("net::ERR_ABORTED", true), true);
  assert.equal(isSpuriousAbortAfterSuccessResponse("net::ERR_ABORTED", false), false);
  assert.equal(isSpuriousAbortAfterSuccessResponse("net::ERR_FAILED", true), false);
});

test("ignores the operations and readiness pages", () => {
  assert.deepEqual(ignoredDashboardPageIds, ["operations", "readiness"]);
  assert.equal(isIgnoredDashboardPageId("operations"), true);
  assert.equal(isIgnoredDashboardPageId("readiness"), true);
  assert.equal(isIgnoredDashboardPageId("cost"), false);
  assert.deepEqual(
    withoutIgnoredDashboardPageIds(["operations", "cost", "readiness"]),
    ["cost"],
  );
});
