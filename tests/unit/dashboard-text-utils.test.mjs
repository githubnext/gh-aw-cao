import assert from "node:assert/strict";
import test from "node:test";
import { parseRolloutMode } from "../../dashboard/report/text-utils.mjs";

test("normalizes explicit rollout modes and collected run-title suffixes", () => {
  for (const value of ["review", "REVIEW", "Worker · review", "Worker (review", "Worker/review"]) {
    assert.equal(parseRolloutMode(value), "review");
  }
  for (const value of ["live", " LIVE ", "Worker: live", "Worker-live"]) {
    assert.equal(parseRolloutMode(value), "live");
  }
  for (const value of [null, undefined, "", "preview", "alive", "review pending", "unknown"]) {
    assert.equal(parseRolloutMode(value), "unknown");
  }
});
