import assert from "node:assert/strict";
import test from "node:test";
import config from "../playwright/configs/dashboard-deployed.config.mjs";

test("deployed dashboard test has enough time for sequential refresh checks", () => {
  assert.equal(config.timeout, 600_000);
});
