import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import "fake-indexeddb/auto";
import { parse } from "yaml";
import { bootstrapActivity } from "../../dashboard/bootstrap-activity.mjs";
import { processDataRequest } from "../../dashboard/site/src/data-worker.js";
import { deleteCanonicalDatabase } from "../../dashboard/site/src/data/storage/indexeddb.js";
import { root, workflow } from "../unit/workflow-contract.helpers.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const steps = parse(workflow("cao-dashboard.yml")).jobs.build.steps;
const repository = "acme/control";
const commitSha = "0123456789abcdef0123456789abcdef01234567";

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "cao-dashboard-bootstrap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function runBuildStep(name, temporaryRoot) {
  const step = steps.find((candidate) => candidate.name === name);
  const env = {
    ...process.env,
    GITHUB_WORKSPACE: root,
    GITHUB_REPOSITORY: repository,
    GITHUB_SERVER_URL: "https://github.com",
    RUNNER_TEMP: temporaryRoot,
    ...Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => [
      key,
      value.replaceAll("${{ runner.temp }}", temporaryRoot)
        .replaceAll("${{ github.workflow_sha }}", commitSha),
    ])),
  };
  const results = [];
  await runInNewContext(`(async () => {\n${step.with.script}\n})()`, {
    require,
    process: { env, execPath: process.execPath },
    core: { info() {} },
    exec: {
      async exec(command, args) {
        results.push(await execFileAsync(command, Array.from(args), {
          cwd: root,
          env,
          maxBuffer: 8 * 1024 * 1024,
        }));
        return 0;
      },
    },
  });
  return results;
}

test("first deployment builds a publishable dashboard with campaigns and no activity", async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const directory = path.join(temporaryRoot, "cao-activity");
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Bootstrap must not collect remote inventory or activity");
  });
  await bootstrapActivity({ root, directory, repository });
  const inventory = JSON.parse(await readFile(path.join(directory, "inventory-sources.json"), "utf8"));
  assert.ok(inventory.campaigns.rows.some((row) => row.campaign === "dependabot"));
  assert.ok(inventory.workflows.rows.length > 0);
  assert.ok(inventory.workflows.rows.every((row) => row["workflow-active"] === "unknown"));
  assert.equal(inventory.campaigns.metadata.completeness, "partial");
  assert.equal(inventory["marketplace-packages"], undefined);
  assert.equal(inventory["marketplace-registries"], undefined);
  assert.equal(inventory["configuration-policy"].rows[0].diagnostics[0].severity, "valid");

  await runBuildStep("Upgrade fallback activity data", temporaryRoot);
  await runBuildStep("Validate restored activity data", temporaryRoot);
  const [health] = await runBuildStep("Assess activity database health", temporaryRoot);
  assert.equal(JSON.parse(health.stdout).healthy, true);
  await runBuildStep("Assemble Dashboard Language site", temporaryRoot);

  const published = path.join(temporaryRoot, "central-agentic-ops-dashboard");
  assert.match(await readFile(path.join(published, "index.html"), "utf8"), new RegExp(commitSha));
  const { dashboard } = JSON.parse(await readFile(path.join(published, "dashboard.json"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(published, "payload-hashes.json"), "utf8"));
  assert.ok(manifest["gh-aw-logs.sqlite"]);
  for (const phase of ["runs", "records"]) {
    const names = Object.keys(manifest).filter((name) => name.startsWith(`gh-aw-logs-${phase}/`));
    assert.equal(names.length, 1);
    const lines = (await readFile(path.join(published, names[0]), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].kind, "metadata");
    assert.equal(lines[0].records, 0);
    assert.equal(lines[0].phase, phase);
  }
  for (const [name, digest] of Object.entries(manifest)) {
    assert.equal(createHash("sha256").update(await readFile(path.join(published, name))).digest("hex"), digest, name);
  }

  await deleteCanonicalDatabase(indexedDB);
  t.after(() => deleteCanonicalDatabase(indexedDB));
  const previousSelf = globalThis.self;
  globalThis.self = { postMessage() {} };
  t.after(() => {
    if (previousSelf === undefined) delete globalThis.self;
    else globalThis.self = previousSelf;
  });
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://bootstrap.test");
    return new Response(await readFile(path.join(published, url.pathname)), { status: 200 });
  });
  const sources = await processDataRequest({
    operation: "load-canonical-dashboard",
    sourceUrl: "https://bootstrap.test/payload-hashes.json",
    sourceNames: ["campaigns", "workflows", "runs", "configuration-policy"],
    context: { ...dashboard, dashboardRepository: repository },
  });
  assert.ok(sources.campaigns.rows.some((row) => row.campaign === "dependabot"));
  assert.ok(sources.workflows.rows.length > 0);
  assert.equal(sources.runs.rows.length, 0);
  assert.equal(sources["configuration-policy"].rows[0].diagnostics[0].severity, "valid");
});

test("bootstrap rejects invalid policy and never replaces existing activity", async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const invalidRoot = path.join(temporaryRoot, "invalid");
  await mkdir(path.join(invalidRoot, ".github/workflows"), { recursive: true });
  await writeFile(path.join(invalidRoot, ".github/workflows/cao.json"), "{}\n");
  await assert.rejects(bootstrapActivity({
    root: invalidRoot,
    directory: path.join(temporaryRoot, "invalid-output"),
    repository,
  }), /Cannot bootstrap dashboard/);

  const directory = path.join(temporaryRoot, "existing");
  await mkdir(directory);
  const existing = path.join(directory, "inventory-sources.json");
  await writeFile(existing, "existing snapshot");
  await assert.rejects(bootstrapActivity({ root, directory, repository }), /existing activity data/);
  assert.equal(await readFile(existing, "utf8"), "existing snapshot");
});
