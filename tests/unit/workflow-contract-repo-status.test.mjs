import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";
import { controlPolicy, root, workflow } from "./workflow-contract.helpers.mjs";

const dispatcherSource = workflow("repo-status.md");
const workerSource = workflow("repo-status-report.md");
const config = (source) => parse(/^---\n([\s\S]*?)\n---/.exec(source)[1]);
const dispatcher = config(dispatcherSource);
const worker = config(workerSource);

function executeStep(name, { github, files = new Map(), environment = {} }) {
  const step = worker.steps.find(entry => entry.name === name);
  assert.ok(step, name);
  const fs = {
    mkdirSync() {},
    readFileSync(path) {
      assert.ok(files.has(path), `unexpected file read: ${path}`);
      return files.get(path);
    },
    writeFileSync(path, body) { files.set(path, body); },
  };
  return runInNewContext(`(async () => { ${step.with.script}\n })()`, {
    require(name) { assert.equal(name, "node:fs"); return fs; },
    github,
    context: { repo: { owner: "acme", repo: "control" }, runId: 123 },
    process: { env: environment },
  }).then(() => files);
}

test("Repo Status is a public optional package, registered without activation or scope expansion", () => {
  const manifest = parse(readFileSync(join(root, "repo-status/aw.yml"), "utf8"));
  const declaration = JSON.parse(readFileSync(join(root, "repo-status/cao.json"), "utf8"));
  assert.equal(manifest.name, "Repo Status");
  assert.equal(manifest["min-version"], controlPolicy["gh-aw-version"]);
  assert.equal(manifest.private ?? false, false);
  assert.equal(manifest.experimental, true);
  assert.deepEqual(manifest.includes, [
    ".github/workflows/repo-status.md", ".github/workflows/repo-status-report.md", "README.md", "LICENSE",
  ]);
  assert.deepEqual(declaration, {
    campaign: "repo-status", orchestrator: "repo-status", workers: { report: "repo-status-report" },
  });
  const rootManifest = parse(readFileSync(join(root, "aw.yml"), "utf8"));
  assert.equal(rootManifest.includes.includes("repo-status/aw.yml"), false);
  assert.deepEqual(controlPolicy["control-plane"].campaigns["repo-status"], {
    enabled: false, icon: "graph", mode: "review", "max-repositories": 1,
    workers: { report: { workflow: "repo-status-report", "max-mode": "review" } },
  });
});

test("Repo Status preserves one-target workers, explicit modes and the shared credential/admission boundary", () => {
  for (const [source, frontmatter] of [[dispatcherSource, dispatcher], [workerSource, worker]]) {
    assert.match(source, /^if: needs\.pre_activation\.outputs\.cao_authorized == 'true'$/m);
    assert.match(source, /cao_precompute\.outputs\.authorized != 'false'/);
    assert.equal(frontmatter.strict, true);
    assert.equal(frontmatter.engine, "copilot");
    assert.equal(frontmatter.permissions["copilot-requests"], "write");
    const control = frontmatter.imports.find(entry => entry.uses === "shared/control.md");
    assert.equal(control.with.campaign, "repo-status");
    for (const [permission, access] of Object.entries(frontmatter.permissions)) {
      if (access !== "read") continue;
      assert.equal(control.with[`read_${permission.replaceAll("-", "_")}`], "read", permission);
    }
    assert.match(source.trim(), /\{\{#runtime-import\? \.github\/cao\/repo-status\.md\}\}$/);
    assert.equal(frontmatter["safe-outputs"].noop, undefined);
  }
  assert.equal(dispatcher.on.schedule, "hourly");
  assert.equal(dispatcher.on.workflow_dispatch.inputs.safe_output_mode.default, "review");
  assert.deepEqual(dispatcher.tools["repo-memory"], { "branch-name": "memory/repo-status" });
  assert.match(dispatcherSource, /\$GH_AW_MEMORY_DIR/);
  assert.match(dispatcherSource, /Deduplicate every[\s\S]*\(worker, target_repo, safe_output_mode\)/);
  assert.equal(dispatcher["safe-outputs"]["threat-detection"], false);
  assert.deepEqual(dispatcher["safe-outputs"]["dispatch-workflow"], { workflows: ["repo-status-report"], max: 10 });
  const mode = worker.on.workflow_dispatch.inputs.safe_output_mode;
  assert.deepEqual(mode, { required: true, type: "string" });
  assert.equal(worker.imports[0].with.worker, "report");
  assert.equal(worker.imports[0].with.read_repository, "${{ inputs.target_repo }}");
  assert.equal(worker.checkout, false);
  assert.equal(worker.tools.github["min-integrity"], "none");
  assert.equal(worker.tools.github.lockdown, false);
  assert.deepEqual(worker.tools.bash, ["cat"]);
  assert.equal(worker.evals, undefined);
  assert.equal(worker["safe-outputs"]["dispatch-workflow"], undefined);
});

test("compiled status outputs enforce destination routing, deduplication and guarded body-only refresh", () => {
  const compiled = parse(workflow("repo-status-report.lock.yml"));
  const handler = compiled.jobs.safe_outputs.steps.find(step => step.env?.GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG);
  assert.ok(handler);
  const outputs = JSON.parse(handler.env.GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG);
  const create = worker["safe-outputs"]["create-issue"];
  const update = worker["safe-outputs"]["update-issue"];
  assert.equal(create["deduplicate-by-title"], true);
  assert.equal(create.expires, "3d");
  assert.equal(create.max, 1);
  assert.equal(create["close-older-issues"], undefined);
  assert.equal(update.max, 1);
  assert.equal(update.body, true);
  assert.equal(update.title, undefined);
  assert.equal(update.status, undefined);
  assert.deepEqual(update["required-labels"], ["repo-status", "repo-status:report"]);
  assert.equal(create["target-repo"], update["target-repo"]);
  assert.match(create["target-repo"], /== 'review' && \(inputs\.safe_output_repo \|\| github\.repository\) \|\| inputs\.target_repo/);
  assert.equal(outputs.create_issue.deduplicate_by_title, true);
  assert.deepEqual(outputs.update_issue.required_labels, update["required-labels"]);
  assert.equal(outputs.update_issue.allow_body, true);
  assert.equal(outputs.update_issue.allow_title, undefined);
  assert.equal(outputs.update_issue.allow_status, undefined);
  assert.equal(outputs.noop["report-as-issue"], "false");
  assert.equal(worker["safe-outputs"]["close-issue"], undefined);
  assert.match(workerSource, /Emit exactly one of those operations, never both/);
  assert.match(workerSource, /render target item references as inline code, not links/);
  assert.match(workerSource, /fully read quiet day|every category was completely read/);
  assert.match(workerSource, /Missing required API access or failed[\s\S]*`report_incomplete`/);
});

test("report windows use the original run time across midnight, leap days and year boundaries", async () => {
  for (const [createdAt, start, end] of [
    ["2026-10-21T00:00:00Z", "2026-10-20T00:00:00.000Z", "2026-10-21T00:00:00.000Z"],
    ["2026-01-01T23:59:59Z", "2025-12-31T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    ["2024-03-01T15:15:15Z", "2024-02-29T00:00:00.000Z", "2024-03-01T00:00:00.000Z"],
  ]) {
    const github = { rest: { actions: { async getWorkflowRun(parameters) {
      assert.deepEqual(JSON.parse(JSON.stringify(parameters)), { owner: "acme", repo: "control", run_id: 123 });
      return { data: { created_at: createdAt } };
    } } } };
    const files = await executeStep("Fix the daily reporting window", { github });
    const window = JSON.parse(files.get("/tmp/gh-aw/agent/repo-status/window.json"));
    assert.deepEqual(window, { date: start.slice(0, 10), start, end, observed_at: createdAt });
  }
  await assert.rejects(executeStep("Fix the daily reporting window", {
    github: { rest: { actions: { async getWorkflowRun() { return { data: {} }; } } } },
  }), /Missing workflow creation time/);
});

test("report lookups are destination-bound, include closed duplicates and fail closed on missing access or truncation", async () => {
  const windowPath = "/tmp/gh-aw/agent/repo-status/window.json";
  const reportPath = "/tmp/gh-aw/agent/repo-status/reports.json";
  const files = () => new Map([[windowPath, JSON.stringify({ start: "2026-10-20T00:00:00.000Z" })]]);
  const calls = [];
  const result = await executeStep("Read existing owned reports", {
    files: files(), environment: { OUTPUT_REPOSITORY: "acme/control" },
    github: { rest: { issues: { async listForRepo(parameters) {
      calls.push(JSON.parse(JSON.stringify(parameters)));
      return { data: [
        { number: 1, title: "acme/a repository status", body: "owned a", state: parameters.state, labels: ["repo-status"] },
        { number: 2, title: "acme/b repository status", body: "owned b", state: parameters.state, labels: [{ name: "repo-status" }] },
        { number: 3, pull_request: {}, labels: [] },
      ] };
    } } } },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].owner, "acme");
  assert.equal(calls[0].repo, "control");
  assert.equal(calls[0].labels, "repo-status,repo-status:report");
  assert.equal(calls[0].state, "open");
  assert.equal(calls[1].state, "closed");
  assert.equal(calls[1].since, "2026-10-20T00:00:00.000Z");
  const reports = JSON.parse(result.get(reportPath));
  assert.equal(reports.complete, true);
  assert.equal(reports.repository, "acme/control");
  assert.equal(reports.reports.length, 4);
  assert.equal(reports.reports.some(report => report.number === 3), false);

  for (const failure of ["access", "truncation"]) {
    const output = files();
    let requests = 0;
    await assert.rejects(executeStep("Read existing owned reports", {
      files: output, environment: { OUTPUT_REPOSITORY: "acme/control" },
      github: { rest: { issues: { async listForRepo() {
        requests += 1;
        if (failure === "access") throw new Error("403 forbidden");
        return { data: Array.from({ length: 100 }, (_, number) => ({ number, labels: [] })) };
      } } } },
    }), failure === "access" ? /403 forbidden/ : /exceeded its open issue bound/);
    assert.equal(requests, failure === "access" ? 1 : 2);
    assert.equal(output.has(reportPath), false, "failure must not publish success-shaped evidence");
  }
  const lookup = worker.steps.find(step => step.name === "Read existing owned reports");
  assert.match(lookup.with["github-token"], /== github\.repository && github\.token \|\| steps\.cao_target_read_credential\.outputs\.token/);
});

test("Setup quickstart is discoverable, review-first and honest about the missing recording and operational value", () => {
  const guide = readFileSync(join(root, "docs/setup/quickstart.md"), "utf8");
  const readme = readFileSync(join(root, "repo-status/README.md"), "utf8");
  assert.match(readFileSync(join(root, "astro.config.mjs"), "utf8"), /label: "Setup"[\s\S]*label: "Quickstart", link: "\/setup\/quickstart\/"/);
  assert.match(guide, /CAO recording not yet available/);
  assert.doesNotMatch(guide, /<video|<iframe|youtube\.com|youtu\.be|\.mp4/);
  assert.match(guide, /gh cao campaigns add githubnext\/gh-cao\/repo-status/);
  assert.match(guide, /gh cao campaigns mode preview repo-status/);
  assert.match(guide, /"enabled": false/);
  assert.match(guide, /"max-mode": "review"/);
  assert.match(guide, /trap 'gh workflow disable repo-status\.lock\.yml' EXIT/);
  assert.match(guide, /--raw-field safe_output_mode="review"/);
  assert.match(guide, /--raw-field max_repos="1"/);
  assert.match(guide, /gh issue list --repo CONTROL_OWNER\/CONTROL_REPOSITORY/);
  assert.match(readme, /Operational value is not measurable yet/);
  assert.match(readme, /ae8d551f07c7ed7619f8c58c7bb4c3ac89395d38\/workflows\/repo-status\.md/);
  assert.match(readFileSync(join(root, "repo-status/LICENSE"), "utf8"), /Copyright \(c\) 2025 GitHub/);
});
