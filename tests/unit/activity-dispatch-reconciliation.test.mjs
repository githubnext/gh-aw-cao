import assert from "node:assert/strict";
import test from "node:test";
import { checkDispatches, reconcileDispatchCycles } from "../../activity/dispatch-reconciliation.mjs";

const cycles = [
  { id: 1, created_at: "2026-09-29T04:00:00Z", updated_at: "2026-09-29T04:05:00Z" },
  { id: 2, created_at: "2026-09-29T05:00:00Z", updated_at: "2026-09-29T05:05:00Z" },
];
const artifact = (runId) => ({
  requests: [{ type: "dispatch_workflow", workflow_name: "cao-evolution-reliability", inputs: {
    target_repo: "githubnext/gh-aw-cao",
    correlation_id: `correlation-${runId}`,
  } }],
  manifest: [{ type: "dispatch_workflow", timestamp: `2026-09-29T0${runId + 3}:04:00Z` }],
});

test("two accepted dispatch cycles with no corresponding worker runs flag a dark period", () => {
  const result = reconcileDispatchCycles(cycles, new Map([[1, artifact(1)], [2, artifact(2)]]), new Map([["cao-evolution-reliability", []]]), "githubnext/gh-aw-cao");
  assert.equal(result.status, "missing_data");
  assert.equal(result.workers[0].expected, 2);
  assert.equal(result.workers[0].triggered, 0);
  assert.deepEqual(result.workers[0].correlations, ["correlation-1", "correlation-2"]);
});

test("matching workflow_dispatch runs in each window do not flag a healthy campaign", () => {
  const runs = new Map([["cao-evolution-reliability", [
    { id: 10, event: "workflow_dispatch", created_at: "2026-09-29T04:03:59Z" },
    { id: 11, event: "workflow_dispatch", created_at: "2026-09-29T05:08:00Z" },
    { id: 12, event: "schedule", created_at: "2026-09-29T05:09:00Z" },
  ]]]);
  assert.equal(reconcileDispatchCycles(cycles, new Map([[1, artifact(1)], [2, artifact(2)]]), runs, "githubnext/gh-aw-cao").status, "healthy");
});

test("an isolated missed cycle does not trigger a multi-cycle alarm", () => {
  const runs = new Map([["cao-evolution-reliability", [
    { id: 11, event: "workflow_dispatch", created_at: "2026-09-29T05:08:00Z" },
  ]]]);
  const result = reconcileDispatchCycles(cycles, new Map([[1, artifact(1)], [2, artifact(2)]]), runs, "githubnext/gh-aw-cao");
  assert.equal(result.status, "healthy");
  assert.equal(result.workers[0].triggered, 1);
});

test("absent manifest or request evidence is incomplete, not a healthy zero dispatch cycle", () => {
  const result = reconcileDispatchCycles(cycles, new Map([[1, artifact(1)], [2, { requests: [], manifest: null }]]), new Map(), "githubnext/gh-aw-cao");
  assert.equal(result.status, "incomplete");
});

test("a no-dispatch cycle with an empty manifest is not a missing worker run", () => {
  const result = reconcileDispatchCycles(cycles, new Map([[1, { requests: [], manifest: [] }], [2, { requests: [], manifest: [] }]]), new Map(), "githubnext/gh-aw-cao");
  assert.equal(result.status, "healthy");
  assert.deepEqual(result.workers, []);
});

function skippedCycleFixture({ cycle = {}, jobOverrides = {}, admission = {}, totalCount } = {}) {
  const repository = "githubnext/gh-aw-cao";
  const artifactReads = [];
  const jobs = [
    { name: "pre_activation", conclusion: "success" },
    { name: "activation", conclusion: "skipped" },
    { name: "agent", conclusion: "skipped" },
    { name: "safe_outputs", conclusion: "skipped" },
  ].map((job) => ({ status: "completed", ...job, ...jobOverrides[job.name] }));
  return {
    artifactReads,
    options: {
      repository,
      token: "fixture-token",
      now: Date.parse("2026-09-29T06:00:00Z"),
      request: async (endpoint, token) => {
        assert.equal(token, "fixture-token");
        if (endpoint.includes("/cao-evolution.lock.yml/runs?")) {
          return { json: async () => ({ workflow_runs: cycles.map((run) => ({
            status: "completed", conclusion: "success", run_attempt: 1, event: "schedule", ...run, ...cycle,
          })) }) };
        }
        assert.match(endpoint, /\/runs\/[12]\/jobs\?filter=latest&per_page=100$/);
        return { json: async () => ({ jobs, total_count: totalCount ?? jobs.length }) };
      },
      readArtifact: async (repo, runId, name, filename, token, optional) => {
        assert.equal(repo, repository);
        assert.equal(token, "fixture-token");
        artifactReads.push({ runId, name, filename });
        if (name === "agent-output-fallback") {
          assert.equal(optional, true);
          return "";
        }
        assert.equal(name, "cao-admission");
        assert.equal(filename, "admission.json");
        return JSON.stringify({
          schema_version: 1,
          observed_at: "2026-09-29T05:00:00Z",
          repository,
          run_id: String(runId),
          run_attempt: 1,
          campaign: "cao-evolution",
          role: "orchestrator",
          authorized: false,
          reason: "campaign-not-scheduled",
          checks: [{ check: "Campaign", status: "failed" }],
          ...admission,
        });
      },
    },
  };
}

test("successful admission-denied cycles with skipped agent jobs need no agent output", async () => {
  const fixture = skippedCycleFixture();
  assert.deepEqual(await checkDispatches(fixture.options), { status: "healthy", workers: [] });
  assert.deepEqual(fixture.artifactReads.map(({ name }) => name), [
    "agent-output-fallback", "cao-admission", "agent-output-fallback", "cao-admission",
  ]);
});

test("capacity-blocked precompute after successful admission is also a no-dispatch cycle", async () => {
  const fixture = skippedCycleFixture({ admission: {
    authorized: true,
    reason: "authorized",
    checks: [{ check: "GitHub API capacity", status: "passed" }],
  } });
  assert.deepEqual(await checkDispatches(fixture.options), { status: "healthy", workers: [] });
});

test("missing agent output remains incomplete when the run or activation jobs did not skip successfully", async () => {
  for (const overrides of [
    { cycle: { conclusion: "failure" } },
    { cycle: { run_attempt: undefined } },
    { jobOverrides: { pre_activation: { conclusion: "failure" } } },
    { jobOverrides: { activation: { conclusion: "success" } } },
    { jobOverrides: { agent: { conclusion: "success" } } },
    { jobOverrides: { safe_outputs: { conclusion: "success" } } },
    { jobOverrides: { agent: { status: "in_progress" } } },
    { jobOverrides: { agent: { name: "other-job" } } },
  ]) {
    const fixture = skippedCycleFixture(overrides);
    await assert.rejects(checkDispatches(fixture.options), /Missing agent-output-fallback/);
    assert.equal(fixture.artifactReads.some(({ name }) => name === "cao-admission"), false);
  }
});

test("skipped-cycle reconciliation rejects malformed or mismatched admission evidence", async () => {
  for (const admission of [
    { authorized: "false" },
    { schema_version: 2 },
    { checks: [] },
    { repository: "other/control" },
    { run_id: "3" },
    { run_attempt: 2 },
    { campaign: "self-care" },
    { role: "worker" },
  ]) {
    const fixture = skippedCycleFixture({ admission });
    await assert.rejects(checkDispatches(fixture.options), /Missing agent-output-fallback/);
  }
});

test("skipped-cycle reconciliation fails closed when admission evidence is unavailable", async () => {
  const fixture = skippedCycleFixture();
  const readArtifact = fixture.options.readArtifact;
  fixture.options.readArtifact = async (...args) => {
    if (args[2] === "cao-admission") throw new Error("Missing cao-admission");
    return readArtifact(...args);
  };
  await assert.rejects(checkDispatches(fixture.options), /Missing cao-admission/);
});

test("skipped-cycle reconciliation rejects incomplete job evidence", async () => {
  const fixture = skippedCycleFixture({ totalCount: 100 });
  await assert.rejects(checkDispatches(fixture.options), /Incomplete job list/);
});

test("admitted cycles still reconcile requested dispatches through their output artifacts", async () => {
  const fixture = skippedCycleFixture();
  fixture.options.readArtifact = async (_repo, runId, name) => {
    const evidence = artifact(runId);
    if (name === "agent-output-fallback") return JSON.stringify({ items: evidence.requests });
    assert.equal(name, "safe-outputs-items");
    return evidence.manifest.map((item) => JSON.stringify(item)).join("\n");
  };
  const request = fixture.options.request;
  fixture.options.request = async (endpoint, token) => {
    if (endpoint.includes("/cao-evolution-reliability.lock.yml/runs?")) {
      return { json: async () => ({ workflow_runs: [] }) };
    }
    return request(endpoint, token);
  };
  const result = await checkDispatches(fixture.options);
  assert.equal(result.status, "missing_data");
  assert.equal(result.workers[0].expected, 2);
});
