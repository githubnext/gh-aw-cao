import assert from "node:assert/strict";
import { posix } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { workflow } from "./workflow-contract.helpers.mjs";

const mainOnlyWorkflows = [
  "actions.yml",
  "azure-local-integration.yml",
  "dashboard-deployed-integration.yml",
  "dashboard-query-parity.yml",
  "dashboard-views.yml",
  "mcp-parity.yml",
];
const fastWorkflows = [
  "action-lint.yml",
  "cao-validate.yml",
  "cgo.yml",
  "cid.yml",
  "csh.yml",
  "install-windows.yml",
  "svg-contrast-check.yml",
  "workflow-contracts.yml",
];

function matchesPaths(file, patterns) {
  let matched = false;
  for (const pattern of patterns) {
    const excluded = pattern.startsWith("!");
    if (posix.matchesGlob(file, excluded ? pattern.slice(1) : pattern)) {
      matched = !excluded;
    }
  }
  return matched;
}

function runsForFile(name, event, file) {
  const triggers = parse(workflow(name)).on;
  if (!Object.hasOwn(triggers, event)) return false;
  const trigger = triggers[event];
  if (trigger?.paths) return matchesPaths(file, trigger.paths);
  if (trigger?.["paths-ignore"]) {
    return !trigger["paths-ignore"].some((pattern) => posix.matchesGlob(file, pattern));
  }
  return true;
}

test("slow integration workflows run on relevant main pushes, not pull requests", () => {
  for (const name of mainOnlyWorkflows) {
    const triggers = parse(workflow(name)).on;
    assert.equal(triggers.pull_request, undefined, name);
    assert.deepEqual(triggers.push.branches, ["main"], name);
    assert.ok(triggers.push.paths.length > 0, name);
    assert.ok(runsForFile(name, "push", `.github/workflows/${name}`), name);
    assert.equal(runsForFile(name, "push", "docs/glossary.md"), false, name);
    assert.equal(runsForFile(name, "push", "server/README.md"), false, name);
    assert.ok(Object.hasOwn(triggers, "workflow_dispatch"), name);
  }
  for (const name of ["actions.yml", "dashboard-deployed-integration.yml", "dashboard-views.yml"]) {
    assert.ok(parse(workflow(name)).on.schedule.length > 0, name);
  }
});

test("pull request triggers route frontend, control, server, and test changes selectively", () => {
  const cases = [
    ["dashboard/site/src/dashboard-app.js", ["cid.yml"]],
    ["dashboard/site/dashboard-fragments/overview.json", ["cid.yml"]],
    ["dashboard/site/README.md", []],
    ["docs/glossary.md", ["workflow-contracts.yml"]],
    ["docs/assets/logo-day.svg", ["cid.yml", "svg-contrast-check.yml", "workflow-contracts.yml"]],
    ["public/favicon.svg", ["cid.yml", "workflow-contracts.yml"]],
    ["activity/dashboard-complexity.mjs", ["workflow-contracts.yml"]],
    ["tests/e2e/dashboard-ingestion-scale.spec.mjs", ["workflow-contracts.yml"]],
    ["server/internal/query/query.go", ["cgo.yml", "workflow-contracts.yml"]],
    ["server/spec/main.tsp", ["cgo.yml", "workflow-contracts.yml"]],
    ["server/README.md", ["workflow-contracts.yml"]],
    [".github/workflows/shared/control.md", ["cao-validate.yml", "workflow-contracts.yml"]],
    [".github/workflows/cid.yml", ["action-lint.yml", "cid.yml"]],
    [".github/workflows/shared/ci.yml", ["action-lint.yml", "cao-validate.yml", "workflow-contracts.yml"]],
    [".github/workflows/actions.yml", ["action-lint.yml", "workflow-contracts.yml"]],
    [".github/workflows/cao-evolution.lock.yml", ["cao-validate.yml", "workflow-contracts.yml"]],
  ];
  for (const [file, expected] of cases) {
    const actual = [...fastWorkflows, ...mainOnlyWorkflows]
      .filter((name) => runsForFile(name, "pull_request", file))
      .sort();
    assert.deepEqual(actual, expected, file);
  }
});

test("main pushes retain browser and integration coverage for representative inputs", () => {
  const cases = [
    ["actions.yml", "tests/e2e/dashboard-mobile-live.spec.mjs"],
    ["actions.yml", "dashboard/local-server.mjs"],
    ["actions.yml", "tests/e2e/dashboard-tree-analysis.mjs"],
    ["actions.yml", "self-care/dashboard-fragments/overview.json"],
    ["azure-local-integration.yml", "scripts/azure-local/azure-local.sh"],
    ["dashboard-deployed-integration.yml", "server/go.mod"],
    ["dashboard-deployed-integration.yml", "dashboard/site/package-lock.json"],
    ["dashboard-query-parity.yml", "server/internal/query/query.go"],
    ["dashboard-views.yml", "self-care/dashboard.json"],
    ["dashboard-views.yml", "tests/e2e/dashboard-views-live.spec.mjs"],
    ["dashboard-views.yml", "tests/e2e/dashboard-deployed-refresh-helpers.mjs"],
    ["dashboard-views.yml", "dashboard/report/bundle-dashboards.mjs"],
    ["mcp-parity.yml", "activity/mcp-server.mjs"],
    ["cgo.yml", "dashboard/site/src/dashboard-app.js"],
    ["cid.yml", "tests/e2e/dashboard-ingestion-scale.spec.mjs"],
  ];
  for (const [name, file] of cases) {
    assert.ok(runsForFile(name, "push", file), `${name}: ${file}`);
  }
  assert.equal(parse(workflow("actions.yml")).jobs.mobile.if, undefined);
});

test("mixed workflows keep fast checks on PRs and gate expensive jobs off PRs", () => {
  const cases = [
    ["workflow-contracts.yml", ["unit", "test", "agent-plugin"], [
      "full-contracts", "github-issue-query",
      "dependabot-operational-value", "campaign-lifecycle-changes",
    ]],
    ["cgo.yml", ["server-quality", "server-spec"], [
      "server-backfill", "server-stress", "redis-dashboard-integration",
    ]],
    ["cid.yml", ["lint-unit", "dead-views"], [
      "playwright-integration", "query-complexity", "lighthouse-performance",
    ]],
  ];
  for (const [name, fastJobs, mainJobs] of cases) {
    const { jobs, concurrency } = parse(workflow(name));
    for (const id of fastJobs) {
      assert.doesNotMatch(jobs[id].if ?? "", /event_name != 'pull_request'/, `${name}: ${id}`);
    }
    for (const id of mainJobs) {
      assert.equal(jobs[id].if, "github.event_name != 'pull_request'", `${name}: ${id}`);
    }
    assert.match(concurrency.group, /github\.event\.pull_request\.number \|\| github\.ref/, name);
    assert.equal(concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}", name);
  }
  const contracts = parse(workflow("workflow-contracts.yml")).jobs;
  assert.match(contracts["campaign-lifecycle"].if, /github\.event_name != 'pull_request'/);
  assert.match(contracts.test.if, /!cancelled\(\)/);
  assert.ok(contracts.test.steps.some((step) => step.name === "Require successful unit areas"));
});

test("PR reporters do not start for skipped main-only producers", () => {
  for (const [name, reports] of [
    ["cid.yml", {
      "query-complexity-comment": "query-complexity",
      "lighthouse-comment": "lighthouse-performance",
    }],
    ["cgo.yml", { "redis-dashboard-comment": "redis-dashboard-integration" }],
  ]) {
    const { jobs } = parse(workflow(name));
    for (const [report, producer] of Object.entries(reports)) {
      assert.ok(jobs[report].if.includes(`needs.${producer}.result != 'skipped'`));
    }
  }
});
