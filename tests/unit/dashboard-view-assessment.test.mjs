import assert from "node:assert/strict";
import { test } from "node:test";
import { isExpectedPageCloseAbort } from "../e2e/dashboard-view-assessment.mjs";

test("ignores request aborts caused by closing an assessed page", () => {
  assert.equal(isExpectedPageCloseAbort("net::ERR_ABORTED", true), true);
  assert.equal(isExpectedPageCloseAbort("net::ERR_ABORTED", false), false);
  assert.equal(isExpectedPageCloseAbort("net::ERR_FAILED", true), false);
});
