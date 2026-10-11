const workflow = "cao-dashboard.yml";
const freshnessMs = 4 * 60 * 60 * 1000;
const stalledMs = 2 * 60 * 60 * 1000;

export async function checkDashboardBuild(github, repo, branch, now = Date.now()) {
  try {
    let latest = null;
    const findActiveBuild = async (status) => {
      const { data } = await github.rest.actions.listWorkflowRuns({
        ...repo,
        workflow_id: workflow,
        branch,
        status,
        per_page: 10,
      });
      for (const run of data.workflow_runs) {
        if (run.head_branch !== branch) continue;
        const { data: jobs } = await github.rest.actions.listJobsForWorkflowRun({
          ...repo,
          run_id: run.id,
          per_page: 100,
        });
        const build = jobs.jobs.find((job) => job.name === "build");
        if (build?.conclusion === "success") {
          const completed = Date.parse(build.completed_at || run.updated_at);
          if (!Number.isFinite(completed)) throw new Error("invalid_run_timestamp");
          if (!latest || completed > latest.completed) latest = { run, completed };
        }
        if (build && ["in_progress", "queued", "pending"].includes(build.status)) {
          return { run, build };
        }
      }
      if (data.total_count > data.workflow_runs.length) {
        throw new Error("run_history_truncated");
      }
      return null;
    };

    for (const status of ["in_progress", "queued", "pending"]) {
      const match = await findActiveBuild(status);
      if (!match) continue;
      const started = Date.parse(match.build.started_at || match.run.created_at);
      if (!Number.isFinite(started)) throw new Error("invalid_run_timestamp");
      return {
        status: now - started > stalledMs ? "failed" : "passed",
        reason: now - started > stalledMs ? "build_stalled" : "build_active",
        run_id: match.run.id,
        observed_at: new Date(started).toISOString(),
      };
    }

    if (latest && now - latest.completed <= freshnessMs) {
      return {
        status: "passed",
        reason: "recent_build",
        run_id: latest.run.id,
        observed_at: new Date(latest.completed).toISOString(),
      };
    }
    for (let page = 1; page <= 10; page += 1) {
      const { data } = await github.rest.actions.listWorkflowRuns({
        ...repo,
        workflow_id: workflow,
        branch,
        status: "completed",
        per_page: 100,
        page,
      });
      for (const run of data.workflow_runs) {
        if (run.head_branch !== branch || run.conclusion === "skipped") continue;
        const { data: jobs } = await github.rest.actions.listJobsForWorkflowRun({
          ...repo,
          run_id: run.id,
          per_page: 100,
        });
        const build = jobs.jobs.find((job) => job.name === "build" && job.conclusion === "success");
        if (build) {
          const completed = Date.parse(build.completed_at || run.updated_at);
          if (!Number.isFinite(completed)) throw new Error("invalid_run_timestamp");
          if (now - completed <= freshnessMs) {
            return {
              status: "passed",
              reason: "recent_build",
              run_id: run.id,
              observed_at: new Date(completed).toISOString(),
            };
          }
          if (!latest || completed > latest.completed) latest = { run, completed };
        }
      }
      if (page * 100 >= data.total_count) break;
      if (page === 10) throw new Error("run_history_truncated");
    }
    if (!latest) return { status: "failed", reason: "no_successful_build" };
    const { run, completed } = latest;
    return {
      status: now - completed > freshnessMs ? "failed" : "passed",
      reason: now - completed > freshnessMs ? "no_recent_build" : "recent_build",
      run_id: run.id,
      observed_at: new Date(completed).toISOString(),
    };
  } catch {
    return { status: "unavailable", reason: "actions_evidence_unavailable" };
  }
}
