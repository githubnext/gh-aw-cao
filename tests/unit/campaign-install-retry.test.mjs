import assert from "node:assert/strict";
import test from "node:test";
import {
  isTransientCampaignInstallError,
  campaignInstallRetryAttempts,
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

test("backs off exponentially across a persistent gateway failure", async () => {
  let attempts = 0;
  const delays = [];
  await assert.rejects(() => retryTransientCampaignInstall(() => {
    attempts += 1;
    const error = new Error("gh aw add failed");
    error.stderr = "HTTP 502: 502 Bad Gateway (https://api.github.com/repos/o/r/contents/f)";
    throw error;
  }, (milliseconds) => delays.push(milliseconds)), /gh aw add failed/);

  assert.equal(attempts, campaignInstallRetryAttempts);
  assert.deepEqual(delays, [1_000, 2_000, 4_000]);
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

test("recognizes an interrupted package file download during update", () => {
  assert.equal(
    isTransientCampaignInstallError({
      stderr: "unable to download new package agent .github/agents/agentic-workflows.md: failed to fetch file co...",
    }),
    true,
  );
});
