import assert from "node:assert/strict";
import test from "node:test";
import {
  isTransientCampaignInstallError,
  campaignInstallRetryAttempts,
  campaignInstallRetryDelay,
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

test("backs off across repeated GitHub gateway failures before giving up", async () => {
  let attempts = 0;
  const delays = [];
  await assert.rejects(() => retryTransientCampaignInstall(() => {
    attempts += 1;
    const error = new Error("gh aw add failed");
    error.stderr = "HTTP 502: 502 Bad Gateway (https://api.github.com/repos/o/r/contents/activity/agents)";
    throw error;
  }, (milliseconds) => delays.push(milliseconds)), /gh aw add failed/);

  assert.equal(attempts, campaignInstallRetryAttempts);
  assert.deepEqual(
    delays,
    Array.from({ length: campaignInstallRetryAttempts - 1 }, (_unused, index) => campaignInstallRetryDelay(index + 1)),
  );
  assert.ok(delays.at(-1) > delays[0], "expected the retry delay to grow between attempts");
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
