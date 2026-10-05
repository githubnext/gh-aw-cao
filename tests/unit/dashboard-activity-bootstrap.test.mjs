import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";
import { workflow } from "./workflow-contract.helpers.mjs";

const { jobs } = parse(workflow("cao-dashboard.yml"));
const step = (name) => jobs.build.steps.find((candidate) => candidate.name === name);
const resolver = step("Resolve fallback activity run");

async function resolveActivity({ runs = [], jobSets = {}, error, jobError } = {}) {
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
      async paginate(_method, { run_id }) {
        if (jobError) throw jobError;
        return jobSets[run_id] ?? [];
      },
      rest: {
        actions: {
          listJobsForWorkflowRun() {},
          async listWorkflowRuns(request) {
            requests.push(request);
            if (error) throw error;
            return { data: { workflow_runs: runs.slice((request.page - 1) * 100, request.page * 100) } };
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

test("dashboard reports inventory-only bootstrap when no Activity snapshot has been collected", async () => {
  const { outputs, notices, summaries, requests } = await resolveActivity();
  assert.equal(outputs["run-id"], undefined);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /No successful CAO Activity collection run/);
  assert.match(summaries.join("\n"), /installed campaigns and configuration with an empty activity set/);
  assert.match(summaries.join("\n"), /no activity computations/);
  assert.match(summaries.join("\n"), /automatically/);
  assert.match(summaries.join("\n"), /CAO Activity.*manually/);
  assert.equal(requests[0].owner, "acme");
  assert.equal(requests[0].repo, "control");
  assert.equal(requests[0].workflow_id, "cao-activity.yml");
  assert.equal(requests[0].branch, "production");
  assert.equal(requests[0].status, "success");
  assert.equal(requests[0].per_page, 100);
});

test("dashboard still resolves a successful Activity run after a cache miss", async () => {
  const { outputs, notices, summaries } = await resolveActivity({ runs: [{ id: 12345 }] });
  assert.equal(outputs["run-id"], "12345");
  assert.deepEqual(notices, []);
  assert.deepEqual(summaries, []);
});

const skippedJobs = [
  { name: "plan", conclusion: "skipped" },
  { name: "index", conclusion: "skipped" },
];

test("dashboard bootstraps when successful Activity runs skipped snapshot indexing", async () => {
  const { outputs, notices } = await resolveActivity({
    runs: [{ id: 10 }],
    jobSets: { 10: skippedJobs },
  });
  assert.equal(outputs["run-id"], undefined);
  assert.equal(notices.length, 1);
});

test("dashboard finds collected evidence beyond a page of skipped Activity runs", async () => {
  const skippedRuns = Array.from({ length: 100 }, (_, id) => ({ id }));
  const { outputs, requests } = await resolveActivity({
    runs: [...skippedRuns, { id: 12345 }],
    jobSets: Object.fromEntries(skippedRuns.map(({ id }) => [id, skippedJobs])),
  });
  assert.equal(outputs["run-id"], "12345");
  assert.deepEqual(requests.map(({ page }) => page), [1, 2]);
});

test("dashboard does not disguise Activity lookup errors as an empty deployment", async () => {
  for (const status of [403, 404, 429, 500]) {
    const error = Object.assign(new Error(`GitHub request failed: ${status}`), { status });
    await assert.rejects(resolveActivity({ error }), (actual) => actual === error);
    await assert.rejects(resolveActivity({ runs: [{ id: 12345 }], jobError: error }), (actual) => actual === error);
  }
});

test("dashboard bootstraps only when neither cache nor run is available and always builds", () => {
  assert.equal(resolver.if, "steps.activity-cache.outputs.cache-matched-key == ''");
  const download = step("Download fallback activity data");
  assert.equal(download.if, "steps.activity-cache.outputs.cache-matched-key == '' && steps.activity-artifact-run.outputs.run-id != ''");
  assert.equal(download.with["run-id"], "${{ steps.activity-artifact-run.outputs.run-id }}");
  assert.equal(download["continue-on-error"], undefined);
  const bootstrap = step("Bootstrap empty activity data");
  assert.equal(bootstrap.if, "steps.activity-cache.outputs.cache-matched-key == '' && steps.activity-artifact-run.outputs.run-id == ''");
  assert.match(bootstrap.with.script, /dashboard\/bootstrap-activity\.mjs/);
  assert.match(bootstrap.with.script, /root: process\.env\.GITHUB_WORKSPACE/);
  assert.equal(bootstrap["continue-on-error"], undefined);

  const consumerNames = [
    "Install dashboard build dependencies",
    "Upgrade fallback activity data",
    "Validate restored activity data",
    "Assess activity database health",
    "Assemble Dashboard Language site",
    "Upload dashboard artifact",
  ];
  for (const name of consumerNames) {
    assert.equal(step(name).if, undefined, name);
    assert.equal(step(name)["continue-on-error"], undefined, name);
  }
  assert.ok(jobs.build.steps.indexOf(download) < jobs.build.steps.indexOf(step(consumerNames[0])));
  assert.ok(jobs.build.steps.indexOf(bootstrap) < jobs.build.steps.indexOf(step(consumerNames[0])));

  for (const [cacheKey, runId, expected] of [
    ["", "", true],
    ["cao-activity-v5-123", "", false],
    ["", "12345", false],
  ]) {
    const evaluate = (condition) => runInNewContext(condition
      .replaceAll("steps.activity-cache.outputs.cache-matched-key", "cacheKey")
      .replaceAll("steps.activity-artifact-run.outputs.run-id", "runId"), { cacheKey, runId });
    assert.equal(evaluate(resolver.if), cacheKey === "");
    assert.equal(evaluate(download.if), cacheKey === "" && runId !== "");
    assert.equal(evaluate(bootstrap.if), expected);
  }
});

test("dashboard caches successful builds and preserves the Pages deployment policy", () => {
  const upload = step("Upload dashboard artifact");
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.equal(jobs.cache.needs, "build");
  assert.equal(jobs.cache.if, undefined);
  assert.equal(jobs.deploy.needs, "build");
  assert.equal(jobs.deploy.if, "needs.build.outputs.deploy == 'true'");
  assert.equal(jobs["notify-failure"].if,
    "${{ always() && (needs.build.result == 'failure' || needs.cache.result == 'failure' || needs.deploy.result == 'failure') }}");
});
