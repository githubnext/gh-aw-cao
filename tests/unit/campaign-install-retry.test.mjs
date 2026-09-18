import assert from "node:assert/strict";
import test from "node:test";
import {
  isTransientCampaignInstallError,
  campaignInstallRetryDelayMilliseconds,
  retryTransientCampaignInstall,
} from "../helpers/campaign-install-retry.mjs";

test("retries a transient GitHub campaign download failure", async () => {
  let attempts = 0;
  const delays = [];
  const result = await retryTransientCampaignInstall(() => {
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
  assert.deepEqual(delays, [campaignInstallRetryDelayMilliseconds]);
});

test("does not retry a deterministic campaign install failure", async () => {
  let attempts = 0;
  await assert.rejects(() => retryTransientCampaignInstall(() => {
    attempts += 1;
    throw new Error("campaign manifest is invalid");
  }), /campaign manifest is invalid/);
  assert.equal(attempts, 1);
});

test("recognizes transient GitHub HTTP failures", () => {
  assert.equal(isTransientCampaignInstallError(new Error("HTTP 503 from GitHub")), true);
  assert.equal(isTransientCampaignInstallError({ stderr: "TLS handshake timeout" }), true);
});
