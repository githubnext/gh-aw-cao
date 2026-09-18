import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dashboardAssessmentPageBudgetMs,
  dashboardAssessmentStartupBudgetMs,
  dashboardAssessmentTimeout,
  ignoredDashboardPageIds,
  isExpectedPageCloseAbort,
  isIgnoredDashboardPageId,
  isSpuriousAbortAfterSuccessResponse,
  maximumDashboardAssessmentTimeoutMs,
  visibleBusyViewSelector,
  visibleViewSelector,
  withoutIgnoredDashboardPageIds,
} from "../e2e/dashboard-view-assessment.mjs";

test("assesses only the views a reader can see", () => {
  assert.equal(visibleViewSelector, "[data-view-id]:visible");
  assert.equal(visibleBusyViewSelector, '[aria-busy="true"]:visible');
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
    dashboardAssessmentTimeout(68),
    dashboardAssessmentStartupBudgetMs + 68 * dashboardAssessmentPageBudgetMs,
  );
  assert.equal(
    dashboardAssessmentTimeout(69),
    dashboardAssessmentStartupBudgetMs + 69 * dashboardAssessmentPageBudgetMs,
  );
  assert.equal(dashboardAssessmentTimeout(75), maximumDashboardAssessmentTimeoutMs);
  assert.equal(dashboardAssessmentTimeout(10_000), maximumDashboardAssessmentTimeoutMs);
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
