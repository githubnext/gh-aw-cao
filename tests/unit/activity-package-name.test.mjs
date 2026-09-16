import assert from "node:assert/strict";
import test from "node:test";
import { packageName } from "../../activity/package-name.mjs";

test("formats package identifiers as display names", () => {
  assert.equal(packageName("repo-assist"), "Repo Assist");
  assert.equal(packageName("a-b"), "A B");
  assert.equal(packageName(""), "");
  assert.equal(packageName(null), "");
  assert.equal(packageName(undefined), "");
});
