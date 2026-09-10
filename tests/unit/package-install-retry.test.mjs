import assert from "node:assert/strict";
import test from "node:test";
import {
  isTransientPackageInstallError,
  retryTransientPackageInstall,
} from "../helpers/package-install-retry.mjs";

test("retries a transient GitHub package download failure", async () => {
  let attempts = 0;
  const delays = [];
  const result = await retryTransientPackageInstall(() => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("gh aw add failed");
      error.stderr = "Get https://api.github.com/contents/file: context deadline exceeded";
      throw error;
    }
    return "installed";
  }, (milliseconds) => delays.push(milliseconds));

  assert.equal(result, "installed");
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [1_000]);
});

test("does not retry a deterministic package install failure", async () => {
  let attempts = 0;
  await assert.rejects(() => retryTransientPackageInstall(() => {
    attempts += 1;
    throw new Error("package manifest is invalid");
  }), /package manifest is invalid/);
  assert.equal(attempts, 1);
});

test("recognizes transient GitHub HTTP failures", () => {
  assert.equal(isTransientPackageInstallError(new Error("HTTP 503 from GitHub")), true);
  assert.equal(isTransientPackageInstallError({ stderr: "TLS handshake timeout" }), true);
});
