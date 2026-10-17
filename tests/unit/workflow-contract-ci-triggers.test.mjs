import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { workflow } from "./workflow-contract.helpers.mjs";
import { requireGate, scopeApplies } from "../../scripts/ci-release-gates.mjs";

const gatedWorkflows = {
  "workflow-contracts.yml": { scope: "contracts", name: "Contracts gate", producers: ["unit", "test", "agent-plugin"] },
  "cid.yml": { scope: "dashboard", name: "Dashboard gate", producers: ["lint-unit"] },
  "cgo.yml": { scope: "server", name: "Server gate", producers: ["server-quality", "server-spec"] },
};

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
  if (event === "pull_request" && gatedWorkflows[name]) return scopeApplies(gatedWorkflows[name].scope, [file]);
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

test("MCP parity keeps service-backed Go integration tests out of its contract step", () => {
  const job = parse(workflow("mcp-parity.yml")).jobs.parity;
  const steps = job.steps;
  const contract = steps.find((step) => step.name === "Run contract tests");
  const parity = steps.find((step) => step.name === "Compare MCP contracts and behavior");
  assert.match(contract.run, /env -u REDIS_URL -u CAO_POSTGRES_URL go -C server test \.\/internal\/server \.\/cmd\/cao-dashboard/);
  assert.equal(parity.run, "npm run test:e2e:dashboard-query-parity");
  assert.ok(job.env.REDIS_URL);
  assert.ok(job.env.CAO_POSTGRES_URL);
});

test("pull request CI scopes route frontend, control, server, and test changes selectively", () => {
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

test("required gates always emit and depend on every mandatory producer", () => {
  for (const [name, contract] of Object.entries(gatedWorkflows)) {
    const document = parse(workflow(name));
    assert.ok(Object.hasOwn(document.on, "pull_request"), name);
    assert.equal(document.on.pull_request, null, name);
    const { scope, gate } = document.jobs;
    assert.equal(scope.steps.at(-1).with.scope, contract.scope, name);
    assert.equal(gate.name, contract.name);
    assert.equal(gate.if, "always()");
    assert.deepEqual(gate.needs, ["scope", ...contract.producers]);
    assert.equal(gate.steps.at(-1).env.CI_NEEDS, "${{ toJSON(needs) }}");
    assert.equal(gate.steps.at(-1).run, "node scripts/ci-release-gates.mjs gate");
    for (const id of contract.producers) {
      assert.match(document.jobs[id].if, /needs\.scope\.outputs\.applicable == 'true'/);
    }
  }
});

test("CI scope handles mixed and large changes, deletions, and its own implementation", () => {
  const docs = Array.from({ length: 1001 }, (_, i) => `docs/${i}.md`);
  assert.equal(scopeApplies("server", docs), false);
  assert.equal(scopeApplies("server", [...docs, "server/internal/server/deleted.go"]), true);
  assert.equal(scopeApplies("dashboard", ["server/README.md", "dashboard/site/src/a.js"]), true);
  assert.equal(scopeApplies("dashboard", ["dashboard/site/.hidden/file.js"]), true);
  assert.equal(scopeApplies("server", ["server/.hidden/file.go"]), true);
  for (const scope of ["contracts", "dashboard", "server"]) {
    assert.equal(scopeApplies(scope, [".github/actions/ci-scope/action.yml"]), true);
    assert.equal(scopeApplies(scope, ["scripts/ci-release-gates.mjs"]), true);
  }
  assert.throws(() => scopeApplies("unknown", []), /Unknown CI scope/);
});

test("scope CLI reads the full merge diff, treats renamed code as deleted, and rejects non-merge input", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cao-ci-scope-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: directory, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "CI scope test");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(directory, "server"));
  writeFileSync(join(directory, "server", "old.go"), "package server\n");
  git("add", ".");
  git("commit", "-m", "base");
  git("checkout", "-b", "feature");
  git("mv", "server/old.go", "server/old.md");
  git("commit", "-m", "rename");
  git("checkout", "main");
  git("merge", "--no-ff", "--no-edit", "feature");
  const output = join(directory, "output");
  const script = fileURLToPath(new URL("../../scripts/ci-release-gates.mjs", import.meta.url));
  const invoke = (event) => spawnSync(process.execPath, [script, "scope", "server"], {
    cwd: directory, encoding: "utf8", env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: output },
  });
  assert.equal(invoke("pull_request").status, 0);
  assert.equal(readFileSync(output, "utf8"), "applicable=true\n");
  git("checkout", "feature");
  const rejected = invoke("pull_request");
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /requires the pull-request merge commit/);
  writeFileSync(output, "");
  assert.equal(invoke("push").status, 0);
  assert.equal(readFileSync(output, "utf8"), "applicable=true\n");
});

test("gates fail closed on missing scope, failed producers, cancellations, and unexpected skips", () => {
  const needs = (applicable, result) => ({
    scope: { result: "success", outputs: { applicable } }, tests: { result },
  });
  assert.match(requireGate(needs("true", "success")), /succeeded/);
  assert.match(requireGate(needs("false", "skipped")), /intentionally skipped/);
  for (const result of ["failure", "cancelled", "skipped", undefined]) {
    assert.throws(() => requireGate(needs("true", result)), /expected success/);
  }
  assert.throws(() => requireGate(needs("false", "success")), /expected skipped/);
  assert.throws(() => requireGate(needs(undefined, "skipped")), /missing or invalid/);
  for (const result of ["failure", "cancelled", "skipped"]) {
    assert.throws(() => requireGate({ ...needs("false", "skipped"), scope: { result } }), /did not succeed/);
  }
  assert.throws(() => requireGate({}), /did not succeed/);
  assert.throws(() => requireGate({ scope: needs("true", "success").scope }), /No CI producers/);
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
