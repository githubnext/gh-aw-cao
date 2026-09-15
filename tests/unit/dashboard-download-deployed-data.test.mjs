import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const executeFile = promisify(execFile);
function executeFileWithInput(file, arguments_, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, arguments_, options, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
    child.stdin.end(input);
  });
}

const packageJson = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
);
const cao = path.resolve(packageJson.bin.cao);

test("exposes the dashboard data CLI as cao", async () => {
  assert.equal(packageJson.bin.cao, "activity/cao.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-cli-"));
  const installedCommand = path.join(root, "cao");
  try {
    await symlink(cao, installedCommand);
    const { stdout } = await executeFile(installedCommand, ["help"]);
    assert.match(stdout, /^Usage:\n  cao ingest /);
    assert.match(stdout, /\n  cao download /);
    assert.match(stdout, /cao query .*--stdin/);
    assert.match(stdout, /cao gh runs /);
    assert.match(stdout, /cao gh issues /);
    assert.match(stdout, /cao gh prs /);
    assert.match(stdout, /Download the deployed snapshot before querying/);
    assert.match(stdout, /execution repo for runs, target repo for issues and prs/);
    assert.match(stdout, /-s, --status\s+Runs only/);
    assert.match(stdout, /cao ingest-jsonl --input-dir SHARD_DIRECTORY/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("queries canonical data with the gh-like surface", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-gh-cli-"));
  const inputDirectory = path.join(root, "gh-aw-logs-shards");
  const input = path.join(inputDirectory, "gh-aw-logs.jsonl");
  const database = path.join(root, "gh-aw-logs.sqlite");
  const records = [
    {
      schema_version: 2,
      kind: "workflow_runs",
      request: { host: "github.com", repository: "githubnext/gh-aw-cao", args: ["run", "list"] },
      payload: [{
        databaseId: 404,
        attempt: 1,
        workflowName: "CAO Activity",
        displayTitle: "Collect activity",
        event: "workflow_dispatch",
        status: "completed",
        conclusion: "success",
        createdAt: "2026-09-10T03:59:00Z",
        startedAt: "2026-09-10T04:00:00Z",
        updatedAt: "2026-09-10T04:01:00Z",
      }],
    },
    {
      schema_version: 2,
      kind: "run",
      run: {
        run_id: 404,
        run_attempt: "1",
        organization: "githubnext",
        repository: "githubnext/gh-aw-cao",
        workflow_name: "CAO Activity",
        workflow_path: ".github/workflows/cao-activity.md",
        status: "completed",
        conclusion: "success",
        created_at: "2026-09-10T03:59:00Z",
        started_at: "2026-09-10T04:00:00Z",
        updated_at: "2026-09-10T04:01:00Z",
      },
    },
    {
      schema_version: 2,
      kind: "safe_output_item",
      safe_output: {
        run_id: 404,
        type: "create_issue",
        url: "https://github.com/octo/example/issues/12",
        timestamp: "2026-09-10T04:00:30Z",
      },
    },
    {
      schema_version: 2,
      kind: "safe_output_item",
      safe_output: {
        run_id: 404,
        type: "create_pull_request",
        url: "https://github.com/octo/example/pull/13",
        timestamp: "2026-09-10T04:00:45Z",
      },
    },
    {
      schema_version: 2,
      kind: "safe_output_item",
      safe_output: {
        run_id: 404,
        type: "add_issue_comment",
        url: "https://github.com/octo/example/issues/12",
        timestamp: "2026-09-10T04:00:55Z",
      },
    },
  ];

  try {
    await mkdir(inputDirectory, { recursive: true });
    await writeFile(input, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    await executeFile(cao, ["ingest-jsonl", "--input-dir", inputDirectory, "--database", database]);

    const { stdout: runsOutput } = await executeFile(cao, [
      "gh", "runs",
      "--database", database,
      "-R", "githubnext/gh-aw-cao",
      "-w", "cao-activity",
      "-s", "success",
      "--since", "2026-09-10",
      "--until", "2026-09-10",
      "-L", "1",
    ]);
    const runs = JSON.parse(runsOutput);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].githubRunId, "404");

    const { stdout: failedRunsOutput } = await executeFile(cao, [
      "gh", "runs",
      "--database", database,
      "--status", "failure",
    ]);
    assert.deepEqual(JSON.parse(failedRunsOutput), []);

    const { stdout: issuesOutput } = await executeFile(cao, [
      "gh", "issues",
      "--database", database,
      "--repo", "octo/example",
      "--workflow", "CAO Activity",
      "--since", "2026-09-10T04:00:00Z",
      "--until", "2026-09-10T04:01:00Z",
    ]);
    assert.deepEqual(JSON.parse(issuesOutput).map(({ number, repository }) => ({ number, repository })), [
      { number: 12, repository: "octo/example" },
    ]);

    const { stdout: prsOutput } = await executeFile(cao, [
      "gh", "prs",
      "--database", database,
      "--repo", "octo/example",
      "--workflow", ".github/workflows/cao-activity.md",
    ]);
    assert.deepEqual(JSON.parse(prsOutput).map(({ number, repository }) => ({ number, repository })), [
      { number: 13, repository: "octo/example" },
    ]);

    const { stdout: outsideRangeOutput } = await executeFile(cao, [
      "gh", "runs",
      "--database", database,
      "--since", "2026-09-11",
    ]);
    assert.deepEqual(JSON.parse(outsideRangeOutput), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects combining ingest-jsonl input modes", async () => {
  await assert.rejects(
    executeFile(cao, ["ingest-jsonl", "--input", "input.jsonl", "--input-dir", "shards"]),
    /--input and --input-dir cannot be combined/,
  );
});

test("downloads the deployed activity shards and SQLite file without rebuilding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deployed-dashboard-data-"));
  const output = path.join(root, "activity");
  const logsContent = '{"schema_version":2,"kind":"run","run":{"run_id":303}}\n';
  const manifest = JSON.stringify({
    "gh-aw-logs-shards/fixture.jsonl": createHash("sha256").update(logsContent).digest("hex"),
  });
  const databaseContent = Buffer.from("published sqlite bytes");
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.end(request.url?.endsWith(".sqlite")
      ? databaseContent
      : request.url?.endsWith("payload-hashes.json") ? manifest : logsContent);
  });

  test("uses .cao as the default download location", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deployed-dashboard-default-output-"));
    const logsContent = '{"schema_version":2,"kind":"run","run":{"run_id":404}}\n';
    const manifest = JSON.stringify({
      "gh-aw-logs-shards/fixture.jsonl": createHash("sha256").update(logsContent).digest("hex"),
    });
    const databaseContent = Buffer.from("default sqlite bytes");
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(request.url?.endsWith(".sqlite")
        ? databaseContent
        : request.url?.endsWith("payload-hashes.json") ? manifest : logsContent);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      await executeFile(cao, [
        "download",
        "--url",
        `http://127.0.0.1:${address.port}/cao/payload-hashes.json`,
      ], { cwd: root });
      assert.equal(await readFile(path.join(root, ".cao", "gh-aw-logs-shards", "fixture.jsonl"), "utf8"), logsContent);
      assert.deepEqual(await readFile(path.join(root, ".cao", "gh-aw-logs.sqlite")), databaseContent);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses default .cao input and database when omitted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cao-cli-default-input-database-"));
    const fixture = path.resolve("dashboard/site/test/fixtures/gh-aw-logs/cached-v2.jsonl");
    const caoRoot = path.join(root, ".cao");
    try {
      await mkdir(caoRoot, { recursive: true });
      await mkdir(path.join(caoRoot, "gh-aw-logs-shards"));
      await copyFile(fixture, path.join(caoRoot, "gh-aw-logs-shards", "fixture.jsonl"));
      const { stdout: auditStdout } = await executeFile(cao, ["audit-jsonl"], { cwd: root });
      const audit = JSON.parse(auditStdout);
      assert.equal(audit.command, "audit-jsonl");
      assert.equal(audit.source.records, 3);

      await executeFile(cao, ["ingest-jsonl"], { cwd: root });
      const { stdout: runsStdout } = await executeFile(cao, [
        "query",
        "--collection",
        "runs",
        "--where",
        "conclusion=success",
      ], { cwd: root });
      const runs = JSON.parse(runsStdout);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].id, "github:run:303:attempt:1");

      const { stdout: stdinStdout } = await executeFileWithInput(cao, [
        "query",
        "--stdin",
      ], JSON.stringify({
        name: "successful-runs",
        from: "runs",
        filter: {
          predicates: [{ field: "conclusion", equals: "success" }],
        },
        limit: 1,
      }), { cwd: root });
      const stdinRuns = JSON.parse(stdinStdout);
      assert.deepEqual(stdinRuns, runs);

      await assert.rejects(
        executeFileWithInput(cao, [
          "query",
          "--stdin",
          "--collection",
          "runs",
        ], '{"collection":"runs"}', { cwd: root }),
        /Option --collection cannot be combined with --stdin/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const { stdout } = await executeFile(cao, [
      "download",
      "--url",
      `http://127.0.0.1:${address.port}/cao/payload-hashes.json`,
      "--output",
      output,
    ]);
    const result = JSON.parse(stdout);
    assert.equal(await readFile(path.join(output, "gh-aw-logs-shards", "fixture.jsonl"), "utf8"), logsContent);
    assert.deepEqual(await readFile(path.join(output, "gh-aw-logs.sqlite")), databaseContent);
    assert.deepEqual(requests.toSorted(), [
      "/cao/gh-aw-logs-shards/fixture.jsonl",
      "/cao/gh-aw-logs.sqlite",
      "/cao/payload-hashes.json",
    ]);
    assert.match(result.databaseUrl, /\/cao\/gh-aw-logs\.sqlite$/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
