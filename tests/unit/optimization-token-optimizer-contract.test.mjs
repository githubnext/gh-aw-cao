import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { root, workflow } from "./workflow-contract.helpers.mjs";

const graderName = "optimization-token-optimizer-operational-value.sh";
const grader = join(root, "optimization", ".github", "graders", graderName);

function evaluate(input) {
  return JSON.parse(execFileSync(grader, {
    encoding: "utf8",
    input: JSON.stringify(input),
  }));
}

test("token optimizer uses the one-shot operational-value contract", { skip: process.platform === "win32" }, () => {
  const fixtures = JSON.parse(readFileSync(
    join(root, ".github", "workflows", "graders", graderName.replace(/\.sh$/, ".fixtures.json")),
    "utf8",
  ));
  for (const fixture of fixtures) {
    assert.deepEqual(evaluate(fixture.request), fixture.expected, fixture.name);
    assert.deepEqual(evaluate(fixture.request), fixture.expected, `${fixture.name}: deterministic rerun`);
  }
});

test("optimization campaign installs the token optimizer contract", () => {
  const manifest = readFileSync(join(root, "optimization", "aw.yml"), "utf8");

  assert.doesNotMatch(manifest, /^resources:/m);
  assert.match(readFileSync(grader, "utf8"), /^#!\/usr\/bin\/env bash/m);
  assert.match(
    readFileSync(join(root, "optimization", "collect-token-efficiency.sh"), "utf8"),
    /^#!\/usr\/bin\/env bash/m,
  );
});

test("token optimizer is review-only, assignment-scoped, and gated before inference", () => {
  const source = workflow("optimization-token-optimizer.md");
  const compiled = workflow("optimization-token-optimizer.lock.yml");
  const policy = JSON.parse(readFileSync(join(root, ".github", "workflows", "cao.json"), "utf8"));
  const campaignPolicy = JSON.parse(readFileSync(join(root, "optimization", "cao.json"), "utf8"));

  assert.match(source, /^name: "AW Optimization \/ Token Optimizer"$/m);
  assert.match(source, /worker: token-optimizer/);
  assert.match(source, /uses: shared\/activity-cache\.md/);
  assert.match(source, /mode: gh-proxy/);
  assert.match(source, /GH_AW_SAFE_OUTPUT_MODE: \$\{\{ inputs\.safe_output_mode \|\| 'review' \}\}/);
  assert.match(source, /target-repo: \$\{\{ inputs\.safe_output_repo \|\| github\.repository \}\}/);
  assert.doesNotMatch(source, /dispatch-workflow:/);
  assert.match(source, /token_eligible: \$\{\{ steps\.token_eligibility\.outputs\.eligible \}\}/);
  assert.match(source, /needs\.activation\.outputs\.token_eligible == 'true'/);
  assert.match(source, /duplicate-active-intervention/);
  assert.match(source, /intervention-history-unavailable/);
  assert.match(source, /--where type=token_efficiency\.intervention/);
  assert.match(source, /invalid-supersession-lineage/);
  assert.match(source, /activity-cache-unavailable/);
  assert.match(source, /assigned-runs-unavailable/);
  assert.match(source, /targetRepo \| @uri/);
  assert.match(source, /experimentId \| @uri/);
  assert.doesNotMatch(source, /supersedesInterventionId: \(\$supersedesInterventionId \| select/);
  assert.match(source, /token-efficiency-observation\.json/);
  assert.match(source, /recommendationDisposition: "unapplied"/);
  assert.match(source, /interventionState: "proposed"/);
  assert.match(source, /^      assignment_json:$/m);
  assert.doesNotMatch(source, /^      assignment_run_id:$/m);
  assert.match(source, /attributableRunIds: \(\$assignment\.attributableRunIds \+ \[\$optimizerRunId\] \| unique\)/);
  assert.match(compiled, /cao_script=activity\/cao\.mjs/);
  assert.doesNotMatch(compiled, /\.github\/aw\/activity\/cao\.mjs/);
  assert.equal(
    policy["control-plane"].campaigns.optimization.workers["token-optimizer"]["max-mode"],
    "review",
  );
  assert.equal(campaignPolicy.workers["token-optimizer"], "optimization-token-optimizer");
});

test("token optimizer observations use the Activity JSONL boundary, not issue text", () => {
  const collector = readFileSync(join(root, "optimization", "collect-token-efficiency.sh"), "utf8");
  const adapter = readFileSync(
    join(root, "dashboard", "site", "src", "data", "adapters", "gh-aw-logs.js"),
    "utf8",
  );
  const sources = readFileSync(
    join(root, "dashboard", "site", "src", "data", "queries", "database.js"),
    "utf8",
  );
  const tokenEfficiencyQueries = readFileSync(
    join(root, "optimization", "token-efficiency-queries.json"),
    "utf8",
  );

  assert.match(collector, /name == "token-efficiency-observation"/);
  assert.match(collector, /kind: "token_efficiency_observation"/);
  assert.match(adapter, /envelope\.kind === 'token_efficiency_observation'/);
  assert.match(adapter, /'token_efficiency\.opportunity'/);
  assert.match(adapter, /'token_efficiency\.intervention'/);
  assert.doesNotMatch(sources, /tokenEfficiencySources/);
  assert.doesNotMatch(tokenEfficiencyQueries, /"name": "token-efficiency-opportunities"/);
  assert.match(tokenEfficiencyQueries, /"name": "token-efficiency-portfolio-candidates"[\s\S]*?"from": "token-efficiency-portfolio-candidate-evaluation"/);
  assert.match(tokenEfficiencyQueries, /"name": "token-efficiency-optimizer-assignments"[\s\S]*?"from": "token-efficiency-portfolio-candidates"/);
  assert.match(tokenEfficiencyQueries, /"name": "token-efficiency-interventions"[\s\S]*?"from": "audits"/);
  assert.doesNotMatch(adapter, /token_efficiency[\s\S]{0,1000}(title|body)/i);
});

test("token intervention tracking is deterministic, read-only, and campaign-owned", () => {
  const tracker = readFileSync(
    join(root, ".github", "workflows", "optimization-token-intervention-tracker.yml"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const manifest = readFileSync(join(root, "optimization", "aw.yml"), "utf8");
  const activityManifest = readFileSync(join(root, "activity", "aw.yml"), "utf8");

  assert.match(tracker, /workflow_dispatch:/);
  assert.match(tracker, /decision:/);
  assert.match(tracker, /token-efficiency-lifecycle-claim/);
  assert.match(tracker, /permissions:\n  actions: read\n  contents: read/);
  assert.doesNotMatch(tracker, /\bwrite\b|safe-outputs:|create-issue:|create-pull-request:/);
  assert.match(manifest, /optimization-token-intervention-tracker\.yml/);
  assert.doesNotMatch(activityManifest, /^resources:/m);
  assert.match(
    readFileSync(join(root, "activity", "token-intervention-lifecycle.mjs"), "utf8"),
    /token_efficiency_lifecycle_observation/,
  );
});
