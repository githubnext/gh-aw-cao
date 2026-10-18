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

test("Go extension quality checks cover root-module sources and lint configuration", () => {
  for (const event of ["pull_request", "push"]) {
    for (const file of [
      ".github/workflows/go-extension.yml",
      ".github/workflows/cao.json",
      ".github/actions/setup-gh-aw/action.yml",
      ".golangci.yml",
      "cmd/gh-cao/main.go",
      "internal/cli/doctor.go",
      "internal/cli/doctor_test.go",
      "internal/cli/doctor_auth_test.go",
      "internal/ghcli/gh.go",
      "internal/cli/native_queries.go",
      "dashboard/catalog.go",
      "dashboard/site/src/data/queries/database.json",
      "dashboard/site/src/data/queries/declarative.js",
      "dashboard/site/src/data/storage/sqlite-indexeddb.js",
      "dashboard/site/src/semantic-view-prompt.js",
      "go.mod",
      "go.sum",
      "package.json",
      "package-lock.json",
    ]) {
      assert.ok(runsForFile("go-extension.yml", event, file), `${event}: ${file}`);
    }
    assert.equal(runsForFile("go-extension.yml", event, "server/internal/server/server.go"), false);
  }

  const { jobs, defaults } = parse(workflow("go-extension.yml"));
  const job = jobs["extension-quality"];
  const steps = job.steps;
  const go = steps.find((step) => step.uses?.startsWith("actions/setup-go@"));
  const install = steps.find((step) => step.name === "Install golangci-lint");
  const format = steps.find((step) => step.name === "Check formatting");
  const lint = steps.find((step) => step.name === "Lint");
  const serverSteps = parse(workflow("cgo.yml")).jobs["server-quality"].steps;
  assert.equal(job.if, undefined);
  assert.equal(defaults?.run?.["working-directory"] ?? ".", ".");
  assert.equal(job.defaults?.run?.["working-directory"] ?? ".", ".");
  assert.equal(go.with["go-version-file"], "go.mod");
  assert.equal(install.run, serverSteps.find((step) => step.name === "Install golangci-lint").run);
  assert.ok(steps.indexOf(go) < steps.indexOf(install));
  assert.ok(steps.indexOf(install) < steps.indexOf(format));
  assert.ok(steps.indexOf(install) < steps.indexOf(lint));
  assert.equal(format["working-directory"] ?? ".", ".");
  assert.equal(lint["working-directory"] ?? ".", ".");
  assert.equal(format.shell, "bash");
  assert.equal(format.run, [
    'golangci-lint fmt --diff ./cmd/... ./internal/... ./dashboard | tee "$RUNNER_TEMP/go-extension-fmt.diff"',
    'test ! -s "$RUNNER_TEMP/go-extension-fmt.diff"',
    "",
  ].join("\n"));
  assert.equal(lint.run, "golangci-lint run ./cmd/... ./internal/... ./dashboard");
  const standalone = steps.find((step) => step.name === "Check standalone execution without Node.js");
  assert.match(standalone.run, /PATH="" "\$binary" pages --json/);
  assert.match(standalone.run, /PATH="" "\$binary" query --database explicit.sqlite --collection runs/);
  const parity = steps.find((step) => step.name === "Install JavaScript parity-oracle dependencies");
  const check = steps.find((step) => step.run === "make check");
  assert.equal(parity.run, "npm ci --ignore-scripts --no-audit --no-fund");
  assert.ok(steps.indexOf(parity) < steps.indexOf(check));
});

test("Go extension keeps authenticated doctor integration separate from unit and smoke tests", () => {
  const { jobs, permissions } = parse(workflow("go-extension.yml"));
  const quality = jobs["extension-quality"];
  assert.ok(quality.steps.some((step) => step.run === "make check"));
  assert.equal(quality.steps.some((step) => step.uses === "./.github/actions/setup-gh-aw"), false);
  assert.equal(quality.env?.GH_TOKEN, undefined);
  const smoke = quality.steps.find((step) => step.name === "Smoke test extension");
  assert.equal(smoke.env, undefined);
  assert.ok(smoke.run.split("\n").includes("./gh-cao doctor --help"));
  assert.equal(smoke.run.split("\n").includes("./gh-cao doctor"), false);

  const job = jobs["extension-authtests"];
  const steps = job.steps;
  const go = steps.find((step) => step.uses?.startsWith("actions/setup-go@"));
  const node = steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
  const install = steps.find((step) => step.uses === "./.github/actions/setup-gh-aw");
  const auth = steps.find((step) => step.name === "Run authenticated doctor integration tests");
  assert.ok(install, "doctor requires the policy-pinned gh-aw installation");
  assert.equal(go.with["go-version-file"], "go.mod");
  assert.ok(steps.indexOf(node) < steps.indexOf(install));
  assert.ok(steps.indexOf(install) < steps.indexOf(auth));
  assert.deepEqual(auth.env, { GH_TOKEN: "${{ github.token }}" });
  assert.deepEqual(permissions, { contents: "read" });
  assert.equal(job.permissions, undefined);
  assert.equal(job.env?.GH_TOKEN, undefined);
  assert.equal(job.if, undefined);
  assert.equal(job.needs, undefined);
  assert.equal(quality.needs, undefined);
  assert.equal(install.if, undefined);
  assert.equal(install["continue-on-error"], undefined);
  assert.equal(auth.if, undefined);
  assert.equal(auth["continue-on-error"], undefined);
  assert.equal(auth.run, "make authtests");
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
