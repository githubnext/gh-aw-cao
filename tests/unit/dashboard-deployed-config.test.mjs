import assert from "node:assert/strict";
import test from "node:test";
import config from "../playwright/configs/dashboard-deployed.config.mjs";
import {
  deployedDashboardUrl,
  scrollRenderedViewsIntoView,
  shouldIgnoreRequestFailure,
} from "../e2e/dashboard-deployed-refresh-helpers.mjs";

test("deployed dashboard test has enough time for sequential refresh checks", () => {
  assert.equal(config.timeout, 600_000);
});

test("deployed dashboard scrolling uses a stable view snapshot", async () => {
  const scrollCalls = [];
  const disposed = [];
  const elements = [
    { scrollIntoView: (options) => scrollCalls.push(options) },
    { scrollIntoView: (options) => scrollCalls.push(options) },
  ];
  let locatorSelector;
  const activePage = {
    locator(selector) {
      locatorSelector = selector;
      return {
        async elementHandles() {
          return elements.map((element, index) => ({
            async evaluate(callback) {
              callback(element);
            },
            async dispose() {
              disposed.push(index);
            },
          }));
        },
      };
    },
  };

  await scrollRenderedViewsIntoView(activePage);

  assert.equal(locatorSelector, "[data-view-id]");
  assert.deepEqual(scrollCalls, [
    { block: "center", inline: "nearest" },
    { block: "center", inline: "nearest" },
  ]);
  assert.deepEqual(disposed, [0, 1]);
});

test("deployed dashboard failure tracking ignores only benign aborted probes", () => {
  assert.equal(shouldIgnoreRequestFailure({
    method: "HEAD",
    url: `${deployedDashboardUrl}gh-aw-logs-runs/shard.json`,
    errorText: "net::ERR_ABORTED",
  }), true);
  assert.equal(shouldIgnoreRequestFailure({
    method: "GET",
    url: `${deployedDashboardUrl}gh-aw-logs-runs/shard.json`,
    errorText: "net::ERR_ABORTED",
    reloading: true,
  }), true);
  assert.equal(shouldIgnoreRequestFailure({
    method: "GET",
    url: `${deployedDashboardUrl}gh-aw-logs-runs/shard.json`,
    errorText: "net::ERR_ABORTED",
  }), false);
  assert.equal(shouldIgnoreRequestFailure({
    method: "HEAD",
    url: `${deployedDashboardUrl}gh-aw-logs-runs/shard.json`,
    errorText: "net::ERR_NAME_NOT_RESOLVED",
  }), false);
  assert.equal(shouldIgnoreRequestFailure({
    method: "HEAD",
    url: "https://example.com/shard.json",
    errorText: "net::ERR_ABORTED",
  }), false);
  assert.equal(shouldIgnoreRequestFailure({
    method: "HEAD",
    url: `${deployedDashboardUrl}assets/app.js`,
    errorText: "net::ERR_ABORTED",
  }), false);
});
