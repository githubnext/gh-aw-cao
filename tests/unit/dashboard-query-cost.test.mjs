import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";
import { estimateRetainedBytes, selectCostlyQueries } from "../helpers/dashboard-query-cost.mjs";

const dashboardDocument = JSON.parse(
  await readFile("dashboard/site/dashboard.json", "utf8"),
);

const CANDIDATE_LIMIT = 10;

test("static query cost evaluator picks the highest ranked queries to investigate", () => {
  const { candidates, analysis } = selectCostlyQueries(dashboardDocument, CANDIDATE_LIMIT);
  assert.equal(candidates.length, Math.min(CANDIDATE_LIMIT, analysis.ranking.length));
  assert.deepEqual(
    candidates.map(({ name }) => name),
    analysis.ranking.slice(0, CANDIDATE_LIMIT).map(({ name }) => name),
  );
  assert.deepEqual(
    candidates.map(({ rank }) => rank),
    candidates.map((_, index) => index + 1),
  );
  for (const candidate of candidates) {
    assert.ok(candidate["static-total-row-read-units"] >= candidate["static-direct-row-read-units"]);
  }
});

test("candidate limit must be a positive integer", () => {
  assert.throws(() => selectCostlyQueries(dashboardDocument, 0), TypeError);
  assert.throws(() => selectCostlyQueries(dashboardDocument, 1.5), TypeError);
});

test("retained byte estimate counts shared rows once", () => {
  const row = { name: "run", value: 12 };
  const single = estimateRetainedBytes([row]);
  assert.ok(single > 0);
  assert.equal(estimateRetainedBytes([row, row]), single + 8);
  assert.ok(estimateRetainedBytes([row, { ...row }]) > estimateRetainedBytes([row, row]));
});

test("deployed integration runs the headless query cost benchmark", async () => {
  const workflow = await readFile(".github/workflows/dashboard-deployed-integration.yml", "utf8");
  assert.match(workflow, /tests\/performance\/dashboard-query-cost\.test\.mjs/);
  assert.match(workflow, /tests\/helpers\/dashboard-query-cost\.mjs/);
  assert.match(workflow, /run: npm run dashboard:data:download/);
  assert.match(workflow, /run: npm run test:performance:dashboard-query-cost/);
  assert.match(workflow, /name: dashboard-query-cost\n/);
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(
    manifest.scripts["test:performance:dashboard-query-cost"],
    "node --expose-gc --test tests/performance/dashboard-query-cost.test.mjs",
  );
});

test("deployed integration reports the query cost report in a pull request comment", async () => {
  const workflow = parse(await readFile(".github/workflows/dashboard-deployed-integration.yml", "utf8"));
  const job = workflow.jobs["query-cost-comment"];
  assert.ok(job, "expected a query-cost-comment job");
  assert.deepEqual(job.needs, "query-cost");
  assert.match(job.if, /github\.event_name == 'pull_request'/);
  assert.match(job.if, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.deepEqual(job.permissions, { actions: "read", "pull-requests": "write" });
  const download = job.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  assert.equal(download.with.name, "dashboard-query-cost");
  const comment = job.steps.find((step) => step.uses?.startsWith("actions/github-script@"));
  assert.match(comment.with.script, /<!-- dashboard-query-cost-results -->/);
  assert.match(comment.with.script, /summary\.md/);
  assert.match(comment.with.script, /issues\.createComment/);
  assert.match(comment.with.script, /issues\.updateComment/);
});
