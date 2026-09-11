import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("downloads the deployed JSONL and SQLite files without rebuilding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deployed-dashboard-data-"));
  const output = path.join(root, "activity");
  const logsContent = '{"schema_version":2,"kind":"run","run":{"run_id":303}}\n';
  const databaseContent = Buffer.from("published sqlite bytes");
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.end(request.url?.endsWith(".sqlite") ? databaseContent : logsContent);
  });

  test("uses .cao as the default download location", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deployed-dashboard-default-output-"));
    const logsContent = '{"schema_version":2,"kind":"run","run":{"run_id":404}}\n';
    const databaseContent = Buffer.from("default sqlite bytes");
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(request.url?.endsWith(".sqlite") ? databaseContent : logsContent);
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
        `http://127.0.0.1:${address.port}/cao/gh-aw-logs.jsonl`,
      ], { cwd: root });
      assert.equal(await readFile(path.join(root, ".cao", "gh-aw-logs.jsonl"), "utf8"), logsContent);
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
      await copyFile(fixture, path.join(caoRoot, "gh-aw-logs.jsonl"));
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
        collection: "runs",
        where: ["conclusion=success"],
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
      `http://127.0.0.1:${address.port}/cao/gh-aw-logs.jsonl`,
      "--output",
      output,
    ]);
    const result = JSON.parse(stdout);
    assert.equal(await readFile(path.join(output, "gh-aw-logs.jsonl"), "utf8"), logsContent);
    assert.deepEqual(await readFile(path.join(output, "gh-aw-logs.sqlite")), databaseContent);
    assert.deepEqual(requests.toSorted(), [
      "/cao/gh-aw-logs.jsonl",
      "/cao/gh-aw-logs.sqlite",
    ]);
    assert.match(result.databaseUrl, /\/cao\/gh-aw-logs\.sqlite$/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
