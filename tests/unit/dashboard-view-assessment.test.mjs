import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ignoredDashboardPageIds,
  isExpectedPageCloseAbort,
  isIgnoredDashboardPageId,
  withoutIgnoredDashboardPageIds,
} from "../e2e/dashboard-view-assessment.mjs";

test("ignores request aborts caused by closing an assessed page", () => {
  assert.equal(isExpectedPageCloseAbort("net::ERR_ABORTED", true), true);
  assert.equal(isExpectedPageCloseAbort("net::ERR_ABORTED", false), false);
  assert.equal(isExpectedPageCloseAbort("net::ERR_FAILED", true), false);
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
