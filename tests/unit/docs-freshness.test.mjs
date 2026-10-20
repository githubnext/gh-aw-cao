import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";
import { workflow } from "./workflow-contract.helpers.mjs";

const documentationWorkflow = parse(workflow("docs.yml"));
const jobs = documentationWorkflow.jobs;
const freshness = jobs["schedule-freshness"];

function jobEnabled(expression, eventName, shouldBuild, {
  conclusion = "success", branch = "main", failed = false, cancelled = false,
  forceDeploy = false, buildResult = "success", skippedAncestor = false,
} = {}) {
  if (!/\b(?:always|cancelled|failure|success)\(\)/.test(expression) && (failed || cancelled || skippedAncestor)) {
    return false;
  }
  return runInNewContext(
    expression.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
      .replaceAll("needs.schedule-freshness.outputs.should-build", "shouldBuild"),
    {
      github: {
        event_name: eventName,
        event: { workflow_run: { conclusion, head_branch: branch }, repository: { default_branch: "main" } },
      },
      inputs: { force_deploy: forceDeploy },
      needs: { build: { result: buildResult } },
      shouldBuild,
      failure: () => failed,
      cancelled: () => cancelled,
    },
  );
}

for (const eventName of ["schedule", "workflow_run", "workflow_dispatch"]) {
  test(`${eventName} uses freshness and only builds when stale`, () => {
    assert.equal(jobEnabled(freshness.if, eventName), true);
    assert.equal(jobEnabled(jobs.build.if, eventName, "false"), false);
    assert.equal(jobEnabled(jobs.build.if, eventName, "true"), true);
    assert.equal(jobEnabled(jobs.build.if, eventName, undefined), false);
    assert.equal(jobEnabled(jobs.build.if, eventName, "true", { failed: true }), false);
    assert.equal(jobEnabled(jobs.build.if, eventName, "true", { cancelled: true }), false);
  });
}

test("manual force deployment is an opt-in boolean", () => {
  const input = documentationWorkflow.on.workflow_dispatch.inputs.force_deploy;
  assert.equal(input.type, "boolean");
  assert.equal(input.default, false);
});

test("push and forced manual runs bypass freshness", () => {
  for (const [eventName, forceDeploy] of [["push", false], ["workflow_dispatch", true]]) {
    const options = { forceDeploy, skippedAncestor: true };
    assert.equal(jobEnabled(freshness.if, eventName, undefined, { forceDeploy }), false);
    assert.equal(jobEnabled(jobs.build.if, eventName, undefined, options), true);
    assert.equal(jobEnabled(jobs.build.if, eventName, "false", options), true);
    assert.equal(jobEnabled(jobs.build.if, eventName, undefined, { ...options, failed: true }), false);
    assert.equal(jobEnabled(jobs.build.if, eventName, undefined, { ...options, cancelled: true }), false);
  }
});

test("Pages deployment runs after a successful build even with skipped ancestors", () => {
  assert.equal(jobs.deploy.needs, "build");
  assert.equal(typeof jobs.deploy.if, "string");
  for (const eventName of ["push", "workflow_dispatch", "schedule", "workflow_run"]) {
    for (const forceDeploy of [false, true]) {
      const options = { forceDeploy, skippedAncestor: true };
      assert.equal(jobEnabled(jobs.deploy.if, eventName, undefined, options), true);
      for (const buildResult of ["failure", "cancelled", "skipped", ""]) {
        assert.equal(jobEnabled(jobs.deploy.if, eventName, undefined, { ...options, buildResult }), false);
      }
      assert.equal(jobEnabled(jobs.deploy.if, eventName, undefined, { ...options, failed: true }), false);
      assert.equal(jobEnabled(jobs.deploy.if, eventName, undefined, { ...options, cancelled: true }), false);
    }
  }
});

test("dashboard completions must succeed on the default branch", () => {
  for (const options of [{ conclusion: "failure" }, { conclusion: "cancelled" }, { branch: "feature" }]) {
    assert.equal(jobEnabled(freshness.if, "workflow_run", undefined, options), false);
    assert.equal(jobEnabled(jobs.build.if, "workflow_run", "true", options), false);
    assert.equal(jobEnabled(jobs.build.if, "workflow_run", "true", { ...options, forceDeploy: true }), false);
  }
});

test("freshness checks actual deployments, branch SHA, and dashboard completion time", async (t) => {
  for (const scenario of [
    { name: "same SHA and older dashboard", expected: "false" },
    { name: "same SHA and equal dashboard time", dashboardTime: "2026-10-04T20:00:00Z", expected: "false" },
    { name: "new branch SHA", deployedSha: "older-sha", expected: "true" },
    { name: "newer dashboard", dashboardTime: "2026-10-04T21:00:00Z", expected: "true" },
    { name: "missing deployment", deployed: false, expected: "true" },
    { name: "missing dashboard", dashboard: false, expected: "true" },
  ]) {
    await t.test(scenario.name, async () => {
      const docsRuns = [
        { id: 2, head_sha: "current-sha", updated_at: "2026-10-04T22:00:00Z" },
        { id: 1, head_sha: scenario.deployedSha ?? "current-sha", updated_at: "2026-10-04T20:00:00Z" },
      ];
      const outputs = {};
      const summary = { addRaw: () => summary, write: async () => {} };
      await runInNewContext(`(async () => { ${freshness.steps[0].with.script} })()`, {
        context: { repo: { owner: "acme", repo: "docs" }, payload: { repository: { default_branch: "main" } } },
        core: { setOutput: (key, value) => { outputs[key] = value; }, summary },
        github: { rest: {
          repos: { getBranch: async () => ({ data: { commit: { sha: "current-sha" } } }) },
          actions: {
            listWorkflowRuns: async ({ workflow_id, branch, status }) => {
              assert.equal(branch, "main");
              assert.equal(status, "success");
              return { data: { workflow_runs: workflow_id === "docs.yml" ? docsRuns : scenario.dashboard === false ? [] : [
                { updated_at: scenario.dashboardTime ?? "2026-10-04T19:00:00Z" },
              ] } };
            },
            listJobsForWorkflowRun: async ({ run_id }) => ({ data: { jobs: [
              { name: "deploy", conclusion: run_id === 1 && scenario.deployed !== false ? "success" : "skipped" },
            ] } }),
          },
        } },
      });
      assert.equal(outputs["should-build"], scenario.expected);
    });
  }
});
