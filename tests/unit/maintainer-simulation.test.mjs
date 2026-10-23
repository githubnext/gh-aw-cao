import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { simulationRun, validateResults } from "../../scripts/maintainer-simulation.mjs";

function report() {
  return {
    simulation: true,
    scenarios: Array.from({ length: 10 }, (_, index) => ({
      id: `S${String(index + 1).padStart(2, "0")}`, persona: "Maintainer",
      goal: "Inspect a run", preconditions: "Synthetic history exists",
      acceptance: "Run identity is visible", steps: ["Click Runs", "Open the run"],
      status: "passed", actual: "Run identity is visible", evidence: ["S01.png"],
    })),
  };
}

test("maintainer simulation requires ten distinct complete outcomes", () => {
  assert.deepEqual(validateResults(report()), { simulation: true, scenarios: 10, passed: 10, failed: 0, blocked: 0 });
  for (const change of [
    value => { value.simulation = false; },
    value => { value.scenarios.pop(); },
    value => { value.scenarios.push(value.scenarios[0]); },
    value => { value.scenarios[1].id = "S01"; },
    value => { value.scenarios[0].acceptance = ""; },
    value => { value.scenarios[0].steps = []; },
    value => { value.scenarios[0].evidence = []; },
    value => { value.scenarios[0].status = "skipped"; },
    value => { value.scenarios[0].status = "failed"; },
    value => { value.scenarios[0].status = "blocked"; },
  ]) {
    const value = report();
    change(value);
    assert.throws(() => validateResults(value));
  }
});

test("maintainer simulation preserves failures and incomplete coverage", () => {
  const value = report();
  Object.assign(value.scenarios[0], {
    status: "failed", reproduction: "Repeat in a new browser context",
    potentialFix: "Check the documented declarative navigation target",
  });
  Object.assign(value.scenarios[1], { status: "blocked", blocker: "Fixture has no failed runs" });
  assert.deepEqual(validateResults(value), { simulation: true, scenarios: 10, passed: 8, failed: 1, blocked: 1 });
});

test("simulation outcomes must preserve the frozen goals and acceptance criteria", () => {
  const plan = report();
  assert.equal(validateResults(report(), plan).passed, 10);
  const changed = report();
  changed.scenarios[0].acceptance = "A weaker condition";
  assert.throws(() => validateResults(changed, plan), /differs from the frozen plan/);
  plan.scenarios.pop();
  assert.throws(() => validateResults(report(), plan), /frozen plan/);
});

test("simulated GitHub identity and timestamps survive explicit fixture decoration", () => {
  const run = { id: 17, run_attempt: 2, status: "completed", conclusion: "success", created_at: "2026-10-01T12:00:00Z" };
  const value = simulationRun("simulator/repo-00002", run, 0);
  assert.equal(value.run_id, run.id);
  assert.equal(value.run_attempt, "2");
  assert.equal(value.created_at, run.created_at);
  assert.equal(value.conclusion, run.conclusion);
  assert.equal(value.repository, "simulator/repo-00002");
  assert.match(value.display_title, /^SIMULATION:/);
  assert.notEqual(value.workflow_path, simulationRun(value.repository, run, 1).workflow_path);
});

test("daily maintainer workflow confines findings to bounded issue safe outputs", () => {
  const source = readFileSync(".github/workflows/dashboard-maintainer-simulation.md", "utf8");
  const configuration = parse(source.split("---")[1]);
  assert.equal(configuration.private, true);
  assert.equal(configuration.on.schedule, "daily");
  assert.ok(Object.hasOwn(configuration.on, "workflow_dispatch"));
  assert.equal(configuration.permissions.issues, "read");
  assert.equal(configuration.permissions.contents, "read");
  assert.equal(configuration["safe-outputs"]["create-issue"].max, 3);
  assert.equal(configuration["safe-outputs"]["create-issue"]["deduplicate-by-title"], true);
  assert.equal(configuration["safe-outputs"]["create-pull-request"], undefined);
  assert.equal(configuration["safe-outputs"]["dispatch-workflow"], undefined);
  assert.match(source, /exactly ten/);
  assert.match(source, /validate \/tmp\/gh-aw\/agent\/maintainer-simulation\/results.json/);
  assert.match(source, /Never substitute the deployed dashboard, Pages mode/);
  assert.match(source, /Do not close older findings/);
});
