import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("activity index combines local inventory and gh aw logs without GitHub API access", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "activity-index-"));
  const workflowDirectory = path.join(root, ".github", "workflows");
  const inventoryPath = path.join(root, "control-plane-inventory.json");
  const logsPath = path.join(root, "gh-aw-logs.jsonl");
  const statePath = path.join(root, "gh-aw-logs-state.json");
  const outputPath = path.join(root, "deployed-workflows.json");
  await mkdir(workflowDirectory, { recursive: true });
  await writeFile(path.join(workflowDirectory, "sample.md"), `---
name: Sample
graders:
  operational-value:
---
`);
  await writeFile(path.join(workflowDirectory, "sample.lock.yml"), '# gh-aw-metadata: {"compiler_version":"v0.88.4"}\n');
  await writeFile(inventoryPath, JSON.stringify({
    schemaVersion: 1,
    manifests: [],
    bundles: [],
    workflows: [{
      id: "sample",
      name: "Sample",
      role: "standalone",
      sourcePath: ".github/workflows/sample.md",
      lockPath: ".github/workflows/sample.lock.yml",
      compiled: true,
      workers: [],
      package: null,
    }],
  }));
  await writeFile(logsPath, JSON.stringify({
      database_id: 42,
      workflow_path: ".github/workflows/sample.lock.yml",
      run_number: 3,
      runAttempt: 2,
      event: "workflow_dispatch",
      conclusion: "success",
      status: "completed",
      created_at: "2026-09-06T20:00:00Z",
      started_at: "2026-09-06T20:00:01Z",
      updated_at: "2026-09-06T20:01:00Z",
      display_title: "Sample run",
      jobs: [{
        jobId: 84,
        name: "agent",
        status: "completed",
        conclusion: "success",
        startedAt: "2026-09-06T20:00:05Z",
        completedAt: "2026-09-06T20:00:55Z",
        runnerName: "GitHub Actions 2",
        runnerGroupName: "GitHub Actions",
        labels: ["ubuntu-latest"],
      }],
  }) + "\n");
  await writeFile(statePath, JSON.stringify({
    schemaVersion: 1,
    observedAt: "2026-09-06T20:02:00Z",
    available: true,
    complete: true,
    targetCount: 1,
    fallback: false,
  }));
  try {
    await execFileAsync(process.execPath, [path.resolve("activity/index.mjs")], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "githubnext/gh-aw-cao",
        REPORT_ROOT: root,
        REPORT_INVENTORY: inventoryPath,
        REPORT_GH_AW_LOGS: logsPath,
        REPORT_GH_AW_LOGS_STATE: statePath,
        REPORT_DEPLOYED_WORKFLOWS: outputPath,
      },
    });
    const result = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(result.repositoryCount, 1);
    assert.deepEqual(result.allowedRepositories, ["githubnext/gh-aw-cao"]);
    assert.equal(result.workflows[0].ghAwVersion, "v0.88.4");
    assert.equal(result.workflows[0].runHealth.successful, 1);
    assert.equal(result.workflows[0].runHealth.runRecords[0].runId, 42);
    assert.equal(result.workflows[0].runHealth.runRecords[0].runAttempt, 2);
    assert.deepEqual(result.workflows[0].runHealth.runRecords[0].jobs, [{
      jobId: 84,
      name: "agent",
      status: "completed",
      conclusion: "success",
      startedAt: "2026-09-06T20:00:05Z",
      completedAt: "2026-09-06T20:00:55Z",
      runnerName: "GitHub Actions 2",
      runnerGroupName: "GitHub Actions",
      labels: ["ubuntu-latest"],
    }]);
    assert.equal(result.runHealth.usageArtifact.complete, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("activity index reports fields missing from gh aw usage artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "activity-index-"));
  const workflowDirectory = path.join(root, ".github", "workflows");
  const logsPath = path.join(root, "gh-aw-logs.jsonl");
  const statePath = path.join(root, "gh-aw-logs-state.json");
  const outputPath = path.join(root, "deployed-workflows.json");
  await mkdir(workflowDirectory, { recursive: true });
  await writeFile(path.join(workflowDirectory, "sample.md"), "---\nname: Sample\n---\n");
  await writeFile(path.join(workflowDirectory, "sample.lock.yml"), "name: Sample\n");
  await writeFile(logsPath, '{"database_id":42,"workflow_name":"Sample"}\n');
  await writeFile(statePath, '{"available":true,"complete":true,"targetCount":1,"fallback":false}\n');
  try {
    await execFileAsync(process.execPath, [path.resolve("activity/index.mjs")], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "githubnext/gh-aw-cao",
        REPORT_ROOT: root,
        REPORT_INVENTORY: path.join(root, "missing-inventory.json"),
        REPORT_GH_AW_LOGS: logsPath,
        REPORT_GH_AW_LOGS_STATE: statePath,
        REPORT_DEPLOYED_WORKFLOWS: outputPath,
      },
    });

    const result = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(result.runHealth.usageArtifact.complete, false);
    assert.equal(result.runHealth.usageArtifact.missingFields.conclusion, 1);
    assert.deepEqual(result.runHealth.usageArtifact.sampleRunIds.conclusion, ["42"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("activity index accepts null usage fields and discovers block-list workers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "activity-index-"));
  const workflowDirectory = path.join(root, ".github", "workflows");
  const logsPath = path.join(root, "gh-aw-logs.jsonl");
  const statePath = path.join(root, "gh-aw-logs-state.json");
  const outputPath = path.join(root, "deployed-workflows.json");
  await mkdir(workflowDirectory, { recursive: true });
  await writeFile(path.join(workflowDirectory, "orchestrator.md"), `---
name: Orchestrator
safe-outputs:
  dispatch-workflow:
    workflows:
      - worker-one
      - worker-two
---
uses: shared/control.md
role: orchestrator
`);
  await writeFile(path.join(workflowDirectory, "orchestrator.lock.yml"), "name: Orchestrator\n");
  await writeFile(logsPath, JSON.stringify({
    database_id: 42,
    workflow_name: "Orchestrator",
    run_number: 1,
    run_attempt: 1,
    event: null,
    conclusion: null,
    status: "in_progress",
    created_at: "2026-09-06T20:00:00Z",
    started_at: "2026-09-06T20:00:01Z",
    updated_at: "2026-09-06T20:01:00Z",
    display_title: "Pending run",
  }) + "\n");
  await writeFile(statePath, '{"available":true,"complete":true,"targetCount":1,"fallback":false}\n');
  try {
    await execFileAsync(process.execPath, [path.resolve("activity/index.mjs")], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "githubnext/gh-aw-cao",
        REPORT_ROOT: root,
        REPORT_INVENTORY: path.join(root, "missing-inventory.json"),
        REPORT_GH_AW_LOGS: logsPath,
        REPORT_GH_AW_LOGS_STATE: statePath,
        REPORT_DEPLOYED_WORKFLOWS: outputPath,
      },
    });
    const result = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(result.runHealth.usageArtifact.complete, true);
    assert.deepEqual(result.workflows[0].workers, ["worker-one", "worker-two"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
