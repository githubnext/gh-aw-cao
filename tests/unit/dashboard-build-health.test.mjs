import assert from "node:assert/strict";
import test from "node:test";
import { checkDashboardBuild } from "../../.github/workflows/shared/dashboard-build-health.mjs";

const now = Date.parse("2026-10-11T21:00:00Z");
const repo = { owner: "githubnext", repo: "gh-aw-cao" };

function evidence(runs, jobs = {}) {
  return {
    rest: {
      actions: {
        async listWorkflowRuns({ workflow_id, branch, status, per_page }) {
          assert.equal(workflow_id, "cao-dashboard.yml");
          assert.equal(branch, "main");
          assert.equal(per_page, status === "completed" ? 100 : 10);
          return { data: { workflow_runs: runs[status] || [], total_count: (runs[status] || []).length } };
        },
        async listJobsForWorkflowRun({ run_id }) {
          return { data: { jobs: jobs[run_id] || [] } };
        },
      },
    },
  };
}

test("active build is not mistaken for skipped or completed jobs", async () => {
  const github = evidence({
    in_progress: [
      { id: 1, head_branch: "main", created_at: "2026-10-11T20:50:00Z", updated_at: "2026-10-11T20:52:00Z" },
      { id: 2, head_branch: "main", created_at: "2026-10-11T20:55:00Z" },
    ],
  }, {
    1: [{ name: "build", status: "completed", conclusion: "success" }],
    2: [{ name: "build", status: "in_progress", started_at: "2026-10-11T20:55:00Z" }],
  });
  assert.deepEqual(await checkDashboardBuild(github, repo, "main", now), {
    status: "passed", reason: "build_active", run_id: 2, observed_at: "2026-10-11T20:55:00.000Z",
  });
});

test("skipped runs cannot hide a stale successful build", async () => {
  const github = evidence({
    completed: [
      { id: 1, head_branch: "main", updated_at: "2026-10-11T20:55:00Z" },
      { id: 2, head_branch: "main", updated_at: "2026-10-11T16:00:00Z" },
    ],
  }, {
    1: [{ name: "build", status: "completed", conclusion: "skipped" }],
    2: [{ name: "build", status: "completed", conclusion: "success", completed_at: "2026-10-11T16:00:00Z" }],
  });
  assert.deepEqual(await checkDashboardBuild(github, repo, "main", now), {
    status: "failed", reason: "no_recent_build", run_id: 2, observed_at: "2026-10-11T16:00:00.000Z",
  });
});

test("fresh build, stalled build, and absent build are distinguished", async () => {
  const fresh = evidence({
    completed: [{ id: 3, head_branch: "main", updated_at: "2026-10-11T20:00:00Z" }],
  }, { 3: [{ name: "build", conclusion: "success" }] });
  assert.equal((await checkDashboardBuild(fresh, repo, "main", now)).reason, "recent_build");

  const stalled = evidence({
    queued: [{ id: 4, head_branch: "main", created_at: "2026-10-11T18:00:00Z" }],
  }, { 4: [{ name: "build", status: "queued" }] });
  assert.equal((await checkDashboardBuild(stalled, repo, "main", now)).reason, "build_stalled");
  assert.deepEqual(await checkDashboardBuild(evidence({}), repo, "main", now), {
    status: "failed", reason: "no_successful_build",
  });
});

test("a successful build remains fresh when downstream deployment fails", async () => {
  const github = evidence({
    completed: [{ id: 6, head_branch: "main", conclusion: "failure", updated_at: "2026-10-11T20:00:00Z" }],
  }, { 6: [{ name: "build", conclusion: "success", completed_at: "2026-10-11T19:59:00Z" }] });
  assert.equal((await checkDashboardBuild(github, repo, "main", now)).reason, "recent_build");
});

test("a successful build counts while downstream deployment is still running", async () => {
  const github = evidence({
    in_progress: [{ id: 7, head_branch: "main", updated_at: "2026-10-11T20:30:00Z" }],
  }, { 7: [{ name: "build", status: "completed", conclusion: "success", completed_at: "2026-10-11T20:25:00Z" }] });
  assert.deepEqual(await checkDashboardBuild(github, repo, "main", now), {
    status: "passed", reason: "recent_build", run_id: 7, observed_at: "2026-10-11T20:25:00.000Z",
  });
});

test("paginates through skipped dashboard runs to find the last build", async () => {
  const skipped = Array.from({ length: 100 }, (_, id) => ({
    id: id + 1, head_branch: "main", conclusion: "skipped",
  }));
  const oldBuild = { id: 101, head_branch: "main", updated_at: "2026-10-11T16:00:00Z" };
  const github = evidence({});
  github.rest.actions.listWorkflowRuns = async ({ status, page }) => ({
    data: {
      workflow_runs: status === "completed" ? (page === 1 ? skipped : [oldBuild]) : [],
      total_count: status === "completed" ? 101 : 0,
    },
  });
  github.rest.actions.listJobsForWorkflowRun = async () => ({
    data: { jobs: [{ name: "build", conclusion: "success" }] },
  });
  assert.equal((await checkDashboardBuild(github, repo, "main", now)).reason, "no_recent_build");
});

test("Actions errors and truncated evidence do not assert health", async () => {
  const unavailable = evidence({});
  unavailable.rest.actions.listWorkflowRuns = async () => { throw new Error("API unavailable"); };
  assert.equal((await checkDashboardBuild(unavailable, repo, "main", now)).status, "unavailable");
  const truncated = evidence({ in_progress: [{ id: 5, head_branch: "main" }] });
  truncated.rest.actions.listWorkflowRuns = async ({ status }) => ({
    data: { workflow_runs: status === "in_progress" ? [{ id: 5, head_branch: "main" }] : [], total_count: status === "in_progress" ? 11 : 0 },
  });
  assert.equal((await checkDashboardBuild(truncated, repo, "main", now)).reason, "actions_evidence_unavailable");
});
