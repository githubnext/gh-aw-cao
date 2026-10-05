import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";
import { workflow } from "./workflow-contract.helpers.mjs";

const { jobs } = parse(workflow("cao-dashboard.yml"));
const step = (name) => jobs.build.steps.find((candidate) => candidate.name === name);
const resolver = step("Resolve fallback activity run");
const activityCondition = "steps.activity-cache.outputs.cache-matched-key != '' || steps.activity-artifact-run.outputs.run-id != ''";

async function resolveActivity({ runs = [], error } = {}) {
  const outputs = {};
  const notices = [];
  const summaries = [];
  const requests = [];
  const summary = {
    addHeading(text) { summaries.push(text); return this; },
    addRaw(text) { summaries.push(text); return this; },
    async write() { return this; },
  };
  await runInNewContext(`(async () => {\n${resolver.with.script}\n})()`, {
    context: {
      repo: { owner: "acme", repo: "control" },
      payload: { repository: { default_branch: "production" } },
    },
    github: {
      rest: {
        actions: {
          async listWorkflowRuns(request) {
            requests.push(request);
            if (error) throw error;
            return { data: { workflow_runs: runs } };
          },
        },
      },
    },
    core: {
      info() {},
      notice(message) { notices.push(message); },
      setOutput(name, value) { outputs[name] = value; },
      summary,
    },
  });
  return { outputs, notices, summaries, requests };
}

test("dashboard waits successfully when no Activity snapshot has been collected", async () => {
  const { outputs, notices, summaries, requests } = await resolveActivity();
  assert.equal(outputs["run-id"], undefined);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /No successful CAO Activity workflow run/);
  assert.match(summaries.join("\n"), /waiting for.*Activity/i);
  assert.match(summaries.join("\n"), /automatically/);
  assert.match(summaries.join("\n"), /CAO Activity.*manually/);
  assert.equal(requests[0].owner, "acme");
  assert.equal(requests[0].repo, "control");
  assert.equal(requests[0].workflow_id, "cao-activity.yml");
  assert.equal(requests[0].branch, "production");
  assert.equal(requests[0].status, "success");
  assert.equal(requests[0].per_page, 1);
});

test("dashboard still resolves a successful Activity run after a cache miss", async () => {
  const { outputs, notices, summaries } = await resolveActivity({ runs: [{ id: 12345 }] });
  assert.equal(outputs["run-id"], "12345");
  assert.deepEqual(notices, []);
  assert.deepEqual(summaries, []);
});

test("dashboard does not disguise Activity lookup errors as an empty deployment", async () => {
  for (const status of [403, 404, 429, 500]) {
    const error = Object.assign(new Error(`GitHub request failed: ${status}`), { status });
    await assert.rejects(resolveActivity({ error }), (actual) => actual === error);
  }
});

test("dashboard skips every snapshot consumer only when neither cache nor run is available", () => {
  assert.equal(resolver.if, "steps.activity-cache.outputs.cache-matched-key == ''");
  const download = step("Download fallback activity data");
  assert.equal(download.if, "steps.activity-cache.outputs.cache-matched-key == '' && steps.activity-artifact-run.outputs.run-id != ''");
  assert.equal(download.with["run-id"], "${{ steps.activity-artifact-run.outputs.run-id }}");
  assert.equal(download["continue-on-error"], undefined);

  const consumerNames = [
    "Install dashboard build dependencies",
    "Upgrade fallback activity data",
    "Validate restored activity data",
    "Assess activity database health",
    "Assemble Dashboard Language site",
    "Upload dashboard artifact",
  ];
  for (const name of consumerNames) {
    assert.equal(step(name).if, activityCondition, name);
    assert.equal(step(name)["continue-on-error"], undefined, name);
  }
  assert.ok(jobs.build.steps.indexOf(download) < jobs.build.steps.indexOf(step(consumerNames[0])));

  for (const [cacheKey, runId, expected] of [
    ["", "", false],
    ["cao-activity-v5-123", "", true],
    ["", "12345", true],
  ]) {
    const evaluate = (condition) => runInNewContext(condition
      .replaceAll("steps.activity-cache.outputs.cache-matched-key", "cacheKey")
      .replaceAll("steps.activity-artifact-run.outputs.run-id", "runId"), { cacheKey, runId });
    assert.equal(evaluate(resolver.if), cacheKey === "");
    assert.equal(evaluate(download.if), cacheKey === "" && runId !== "");
    assert.equal(evaluate(activityCondition), expected);
  }
});

test("dashboard requires an uploaded artifact before caching or deploying", () => {
  const upload = step("Upload dashboard artifact");
  assert.equal(jobs.build.outputs["artifact-id"], `\${{ steps.${upload.id}.outputs.artifact-id }}`);
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.equal(jobs.cache.if, "needs.build.outputs.artifact-id != ''");
  assert.equal(jobs.deploy.if, "needs.build.outputs.deploy == 'true' && needs.build.outputs.artifact-id != ''");
  for (const [artifactId, deploy, shouldCache, shouldDeploy] of [
    ["", "true", false, false],
    ["12345", "true", true, true],
    ["12345", "false", true, false],
  ]) {
    const evaluate = (condition) => runInNewContext(condition
      .replaceAll("needs.build.outputs.artifact-id", "artifactId")
      .replaceAll("needs.build.outputs.deploy", "deploy"), { artifactId, deploy });
    assert.equal(evaluate(jobs.cache.if), shouldCache);
    assert.equal(evaluate(jobs.deploy.if), shouldDeploy);
  }
  assert.equal(jobs["notify-failure"].if,
    "${{ always() && (needs.build.result == 'failure' || needs.cache.result == 'failure' || needs.deploy.result == 'failure') }}");
});
