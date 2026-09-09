import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("activity cache reuses and rewrites only the gh-aw logs JSON across runs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "activity-cache-e2e-"));
  const repository = path.join(root, "repository");
  const bin = path.join(root, "bin");
  const savedCache = path.join(root, "saved-cache");
  await mkdir(path.join(repository, ".github", "workflows"), { recursive: true });
  await mkdir(bin);
  await writeFile(
    path.join(repository, ".github", "workflows", "sample.lock.yml"),
    "name: Sample\n",
  );
  const ghPath = path.join(bin, "gh");
  await writeFile(ghPath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "aw") {
  const cachedJson = args[args.indexOf("--cached-json") + 1];
  const output = args[args.indexOf("--output") + 1];
  const cached = JSON.parse(fs.readFileSync(cachedJson, "utf8"));
  fs.writeFileSync(process.env.CACHED_RUNS_PATH, JSON.stringify(cached.runs.map((run) => run.database_id)));
  fs.mkdirSync(path.join(output, \`run-\${process.env.FAKE_RUN_ID}\`, "agent"), { recursive: true });
  fs.writeFileSync(path.join(output, \`run-\${process.env.FAKE_RUN_ID}\`, "agent", "events.jsonl"), "{}\\n");
  cached.runs.push({
    database_id: Number(process.env.FAKE_RUN_ID),
    repository: process.env.GITHUB_REPOSITORY,
    workflow_path: ".github/workflows/sample.lock.yml",
    status: "completed"
  });
  fs.writeFileSync(cachedJson, JSON.stringify(cached));
} else {
  process.stdout.write('{"jobs":[]}');
}
`);
  await chmod(ghPath, 0o755);

  async function runActivity(runNumber) {
    const runnerTemp = path.join(root, `runner-${runNumber}`);
    const activityCache = path.join(runnerTemp, "cao-activity");
    if (runNumber > 1) await cp(savedCache, activityCache, { recursive: true });
    else {
      await mkdir(activityCache, { recursive: true });
      await writeFile(path.join(activityCache, "gh-aw-logs.json"), '{"runs":[]}\n');
    }
    const artifacts = path.join(runnerTemp, "cao-gh-aw-logs");
    const cachedRunsPath = path.join(runnerTemp, "cached-runs.json");
    await execFileAsync(process.execPath, [path.resolve("activity/logs.mjs")], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "githubnext/gh-aw-cao",
        REPORT_ROOT: repository,
        REPORT_GH_AW_LOGS: path.join(activityCache, "gh-aw-logs.json"),
        REPORT_GH_AW_LOGS_STATE: path.join(activityCache, "gh-aw-logs-state.json"),
        REPORT_AIC_CACHE: artifacts,
        FAKE_RUN_ID: String(40 + runNumber),
        CACHED_RUNS_PATH: cachedRunsPath,
      },
    });
    await rm(savedCache, { recursive: true, force: true });
    await cp(activityCache, savedCache, { recursive: true });
    return { activityCache, artifacts, cachedRunsPath };
  }

  try {
    const first = await runActivity(1);
    assert.deepEqual(JSON.parse(await readFile(first.cachedRunsPath, "utf8")), []);
    assert.deepEqual((await readdir(savedCache)).sort(), [
      "gh-aw-logs-state.json",
      "gh-aw-logs.json",
    ]);
    assert.equal(
      await readFile(path.join(first.artifacts, "run-41", "agent", "events.jsonl"), "utf8"),
      "{}\n",
    );

    const second = await runActivity(2);
    assert.deepEqual(JSON.parse(await readFile(second.cachedRunsPath, "utf8")), [41]);
    const refreshed = JSON.parse(await readFile(path.join(savedCache, "gh-aw-logs.json"), "utf8"));
    assert.deepEqual(refreshed.runs.map((run) => run.database_id), [41, 42]);
    assert.deepEqual((await readdir(savedCache)).sort(), [
      "gh-aw-logs-state.json",
      "gh-aw-logs.json",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
