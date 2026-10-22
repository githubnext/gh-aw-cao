import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import {
  downloadCaoRuntimeArtifact, extractCaoArchive, materializeCao, planCaoMaterialization, validateCaoRuntimeArtifact,
  verifyCaoRuntime,
} from "../../.github/workflows/shared/materialize-cao.mjs";
import { buildCaoRuntime } from "../../scripts/build-cao-runtime.mjs";

const catalog = path.resolve(import.meta.dirname, "../..");
const revision = "1".repeat(40);
const retiredLauncher = `#!/bin/sh
set -eu

root="$(CDPATH='' cd -P "$(dirname "$0")" && pwd)"

cli="$root/activity/cao.mjs"
if [ ! -f "$cli" ]; then
  echo "cao CLI is unavailable; install the Central Agentic Ops root campaign." >&2
  exit 1
fi

exec node "$cli" --pipeline "$@"
`;
const temporary = mkdtempSync(path.join(tmpdir(), "cao-runtime-artifact-"));
const artifact = buildCaoRuntime(catalog, path.join(temporary, "built"), revision);
test.after(() => rmSync(temporary, { recursive: true, force: true }));

function unpack(t) {
  const destination = mkdtempSync(path.join(temporary, "unpacked-"));
  t.after(() => rmSync(destination, { recursive: true, force: true }));
  extractCaoArchive(artifact.archive, destination, true);
  return path.join(destination, "package");
}

function fakeGithub(t, {
  expired = false,
  missing = false,
  pendingBeforeSuccess = 0,
  rejection = false,
} = {}) {
  const root = mkdtempSync(path.join(temporary, "github-"));
  const log = path.join(root, "commands.jsonl");
  const fake = path.join(root, "gh");
  const script = `import { appendFileSync, cpSync, existsSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const previous = existsSync(${JSON.stringify(log)}) ? readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse) : [];
const workflowQueries = previous.filter((entry) => entry[0] === "api" && entry.at(-1).includes("/actions/workflows/")).length;
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "api" && args.at(-1).includes("/actions/workflows/")) {
  const pending = workflowQueries < ${pendingBeforeSuccess};
  console.log(JSON.stringify([{ workflow_runs: ${missing ? "[]" : `pending ? ${JSON.stringify([
    { id: 9, head_sha: revision, conclusion: null, event: "push", status: "in_progress" },
  ])} : ${JSON.stringify([
    { id: 7, head_sha: "2".repeat(40), conclusion: "success", event: "push", status: "completed" },
    { id: 8, head_sha: revision, conclusion: "success", event: "pull_request", status: "completed" },
    { id: 9, head_sha: revision, conclusion: "success", event: "push", status: "completed" },
  ])}`} }]));
} else if (args[0] === "api") {
  console.log(JSON.stringify([{ artifacts: [{ name: "cao-runtime-${revision}", expired: ${expired} }] }]));
} else if (args[0] === "run" || args[0] === "release") {
  cpSync(${JSON.stringify(artifact.archive)}, args[args.indexOf("--dir") + 1] + "/cao-runtime-${revision}.tgz");
} else if (args[0] === "attestation") {
  if (${rejection}) { console.error("invalid signature or source digest"); process.exit(1); }
} else { process.exit(2); }
`;
  writeFileSync(fake, `#!${process.execPath}\n${script}`);
  chmodSync(fake, 0o755);
  if (process.platform === "win32") {
    const module = path.join(root, "fake-gh.mjs");
    writeFileSync(module, script);
    writeFileSync(path.join(root, "gh.cmd"), `@"${process.execPath}" "${module}" %*\r\n`);
    cpSync(process.execPath, path.join(root, "gh.exe"));
    writeFileSync(path.join(root, "preload.mjs"), `${script.replace("process.argv.slice(2)", "process.argv.slice(1)")}\nprocess.exit(0);\n`);
  }
  const previousPath = process.env.PATH;
  const previousOptions = process.env.NODE_OPTIONS;
  process.env.PATH = `${root}${path.delimiter}${previousPath}`;
  if (process.platform === "win32") {
    process.env.NODE_OPTIONS = `${previousOptions ?? ""} --import=${pathToFileURL(path.join(root, "preload.mjs")).href}`;
  }
  t.after(() => {
    process.env.PATH = previousPath;
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousOptions;
  });
  return { root, commands: () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) };
}

test("producer artifact binds its production inventory to an immutable revision", (t) => {
  const root = unpack(t);
  validateCaoRuntimeArtifact(root, revision);
  const metadata = JSON.parse(readFileSync(path.join(root, "cao-runtime.json"), "utf8"));
  assert.equal(metadata.revision, revision);
  assert.ok(metadata.files["dashboard/site/src/vendor/yaml.js"]);
  assert.ok(metadata.files["dashboard/site/src/vendor/yaml.LICENSE"]);
  assert.equal(metadata.files["activity/setup-prompt.mjs"], undefined);
  for (const file of [
    "activity/setup.mjs", "activity/upgrade-gh-aw.mjs",
    ...["authentication", "campaigns", "gh-aw", "packages", "policy"].map(name => `activity/cli/${name}.mjs`),
    ...["init", "setup", "setup-auth", "add", "mode", "enable", "disable", "update", "upgrade-gh-aw"]
      .map(name => `activity/commands/${name}.mjs`),
  ]) {
    assert.equal(metadata.files[file], undefined, file);
    assert.equal(existsSync(path.join(root, file)), false, file);
  }
  assert.ok(metadata.files["activity/jsonl.mjs"]);
  assert.ok(metadata.files["activity/collect-workflow-logs.mjs"]);
  assert.equal(metadata.files["activity/cli/repositories.mjs"], undefined);
  assert.equal(existsSync(path.join(root, "activity/cli/repositories.mjs")), false);
  for (const file of [
    "jsonl_helpers.cjs", "json_schema_validation.cjs", "mcp_scripts_validation.cjs",
    "memory_schema_contract.cjs", "LICENSE", "source.json",
  ]) assert.ok(metadata.files[`activity/vendor/gh-aw/${file}`]);
  assert.ok(metadata.files["dashboard/local-github-service.mjs"]);
  for (const file of [
    "dashboard/cli-terminal-process.mjs",
    "dashboard/cli-terminal-child.mjs",
    "dashboard/site/scripts/prepare-terminal.mjs",
  ]) assert.ok(metadata.files[file], `missing terminal runtime file: ${file}`);
  for (const file of [
    "dashboard/environment-defaults.mjs",
    "dashboard/site/src/environment-defaults.js",
  ]) assert.ok(metadata.files[file], `missing Governance runtime file: ${file}`);
  const dashboardManifest = JSON.parse(readFileSync(path.join(root, "dashboard/site/package.json"), "utf8"));
  const dashboardLock = JSON.parse(readFileSync(path.join(root, "dashboard/site/package-lock.json"), "utf8"));
  assert.ok(dashboardManifest.dependencies["node-pty"]);
  assert.equal(dashboardManifest.scripts.postinstall, "node scripts/prepare-terminal.mjs");
  assert.equal(dashboardLock.packages[""].dependencies["node-pty"], dashboardManifest.dependencies["node-pty"]);
  assert.ok(dashboardLock.packages["node_modules/node-pty"].hasInstallScript);
  assert.equal(existsSync(path.join(root, "node_modules")), false);
  assert.match(readFileSync(path.join(root, "dashboard/site/src/validator-dashboard.js"), "utf8"), /from '\.\/vendor\/yaml\.js'/);
  assert.doesNotMatch(readFileSync(path.join(root, "dashboard/site/src/environment-defaults.js"), "utf8"), /from ['"].*yaml/);
  assert.equal(existsSync(path.join(root, "dashboard/site/node_modules")), false);
  assert.throws(() => validateCaoRuntimeArtifact(root, "2".repeat(40)), /provenance does not match/);
});

test("the prebuilt archive loads the Governance CLI transport with dependency-free defaults parsing", async (t) => {
  const root = unpack(t);
  const { executeDashboardCommand } = await import(pathToFileURL(path.join(root, "dashboard/cli-actions.mjs")));
  const yaml = 'default_max_turns: "20"\n';
  const result = await executeDashboardCommand({
    command: "gh aw env get cao-governance.yml --scope org --org acme",
    workingDirectory: root,
    githubToken: "test-fixture",
    execute: async (_executable, args, options) => {
      if (!args.includes("--help")) writeFileSync(path.join(options.cwd, "cao-governance.yml"), yaml);
      return { stdout: "", stderr: "" };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, yaml);
});

test("the installed runtime retains executable workflow-agent evidence APIs without npm or gh cao", async (t) => {
  const root = unpack(t);
  const manifest = parse(readFileSync(path.join(catalog, "aw.yml"), "utf8"));
  for (const { source, destination } of manifest.resources) {
    const target = path.join(root, destination);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(catalog, source), target);
  }
  const { commandHandlers } = await import(pathToFileURL(path.join(root, "activity/commands/index.mjs")));
  const run = (args) => execFileSync(process.execPath, ["activity/cao.mjs", ...args], {
    cwd: root,
    env: { PATH: "", NODE_NO_WARNINGS: "1" },
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  for (const command of [
    "queries", "query-info", "prompt", "query", "gh", "computation", "mcp", "download",
  ]) assert.equal(typeof commandHandlers.get(command), "function", `${command} must ship registered`);
  assert.equal(existsSync(path.join(root, "node_modules")), false);
  assert.match(run(["--help"]), /supported evidence APIs for agents inside agentic workflows/);
  const discovery = JSON.parse(run(["queries", "--json"]));
  assert.ok(discovery.queries.some((query) => query.id === "campaign-runs"));
  const info = JSON.parse(run(["query-info", "campaign-runs", "--json"]));
  assert.equal(info.query.execution.backend, "sqlite");
  assert.match(run(["prompt", "campaign-runs"]), /No data preview was supplied/);

  const database = path.join(root, "evidence.sqlite");
  const query = JSON.parse(run([
    "query", "campaign-runs", "--database", database, "--param", "campaign=maintenance", "--limit", "5",
  ]));
  assert.deepEqual(query.rows, []);
  assert.equal(query.metadata.availability, "empty");
  assert.equal(query.metadata.limit, 5);
  assert.deepEqual(query.metadata.parameters, { campaign: "maintenance" });
  for (const resource of ["runs", "issues", "prs"]) {
    assert.deepEqual(JSON.parse(run([
      "gh", resource, "--database", database, "--repo", "octo/control", "--limit", "5",
    ])), []);
  }
  writeFileSync(path.join(root, "inventory-sources.json"), JSON.stringify({
    campaigns: { rows: [{ campaign: "maintenance", "observed-at": "2026-10-22T10:00:00Z" }] },
    repositories: { rows: [{ organization: "octo", repository: "control", "observed-at": "2026-10-22T10:00:00Z" }] },
    workflows: { rows: [] },
  }));
  for (const computation of ["runtime-health", "intelligence"]) {
    const payload = JSON.parse(run(["computation", computation, "--database", database]));
    assert.equal(payload.command, "computation");
    assert.equal(payload.computation, computation);
    assert.ok(payload.result);
  }
  assert.throws(() => run(["download", "--url", "file:///evidence.json"]), (error) => {
    assert.equal(error.status, 1);
    assert.match(String(error.stderr), /Dashboard data URL must use HTTP or HTTPS/);
    return true;
  });

  const { createDatabase } = await import(pathToFileURL(path.join(root, "activity/cli/ingestion.mjs")));
  const { MCP_PROTOCOL_VERSION, startMcpServer } = await import(pathToFileURL(path.join(root, "activity/mcp-server.mjs")));
  const server = await startMcpServer({ indexedDB: await createDatabase(database), port: 0 });
  t.after(() => server.stop());
  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      "Mcp-Method": "tools/call",
      "Mcp-Name": "cao_query",
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "cao_query", arguments: { id: "campaign-runs", limit: 5 } },
    }),
  });
  assert.equal(response.status, 200);
  const payload = (await response.json()).result.structuredContent;
  assert.equal(payload.query, query.query);
  assert.deepEqual(payload.rows, query.rows);
  assert.equal(payload.metadata.availability, query.metadata.availability);
});

test("the prebuilt archive runs Activity session enrichment without consumer npm dependencies", (t) => {
  const root = unpack(t);
  const logs = path.join(root, "_activity/logs");
  const shards = path.join(root, "_activity/shards");
  const prefix = path.join(shards, "logs-");
  mkdirSync(logs, { recursive: true });
  mkdirSync(shards, { recursive: true });
  const enrich = () => JSON.parse(execFileSync(process.execPath, [
    "activity/session-evidence.mjs", logs, prefix, "example/control",
  ], { cwd: root, encoding: "utf8", timeout: 30_000 }));

  // Collection calls this entrypoint even when discovery finds no workflows.
  assert.deepEqual(enrich(), { enriched: 0, missingSessions: 0 });
  const usage = path.join(logs, "run-303", "usage");
  mkdirSync(usage, { recursive: true });
  writeFileSync(path.join(usage, "aw_info.json"), JSON.stringify({
    run_id: 303, run_attempt: 1, repository: "example/control",
  }));
  writeFileSync(path.join(usage, "aw_session.jsonl"), [
    { type: "session.format", data: { version: 1 } },
    { type: "tool.execution_complete", timestamp: "2026-10-15T10:00:00Z",
      data: { toolName: "bash", success: true, output: "PRIVATE_OUTPUT" } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  const shard = `${prefix}1.jsonl`;
  writeFileSync(shard, JSON.stringify({
    schema_version: 5, kind: "run",
    run: { run_id: 303, run_attempt: 1, repository: "example/control" },
  }) + "\n");
  assert.deepEqual(enrich(), { enriched: 1, missingSessions: 0 });
  const content = readFileSync(shard, "utf8");
  const evidence = JSON.parse(content).run.cao_unified_session;
  assert.equal(evidence.path, "usage/aw_session.jsonl");
  assert.ok(evidence.events.some((event) => event.type === "tool.execution_complete"));
  assert.doesNotMatch(content, /PRIVATE_OUTPUT/);
  assert.deepEqual(enrich(), { enriched: 0, missingSessions: 0 });
});

test("Activity runtime verification rejects a missing packaged session entrypoint", (t) => {
  const root = unpack(t);
  verifyCaoRuntime("activity", root);
  rmSync(path.join(root, "activity/session-evidence.mjs"));
  assert.throws(() => verifyCaoRuntime("activity", root), /activity\/session-evidence\.mjs/);
});

test("producer archives are reproducible across temporary build directories", () => {
  const rebuilt = buildCaoRuntime(catalog, path.join(temporary, "rebuilt"), revision);
  assert.equal(rebuilt.digest, artifact.digest);
  assert.deepEqual(readFileSync(rebuilt.archive), readFileSync(artifact.archive));
});

test("verified older inventories may include a retired launcher without making it a root resource", (t) => {
  const root = unpack(t);
  const filename = path.join(root, "cao.sh");
  writeFileSync(filename, "#!/bin/sh\nexit 0\n");
  const metadataPath = path.join(root, "cao-runtime.json");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  metadata.files["cao.sh"] = createHash("sha256").update(readFileSync(filename)).digest("hex");
  writeFileSync(metadataPath, JSON.stringify(metadata));
  validateCaoRuntimeArtifact(root, revision);
  const [plan] = planCaoMaterialization([{
    name: "githubnext/gh-cao", record: { resolvedCommit: revision },
  }], "root");
  assert.equal(plan.resources.includes("cao.sh"), false);
  writeFileSync(filename, "tampered");
  assert.throws(() => validateCaoRuntimeArtifact(root, revision), /checksum mismatch: cao\.sh/);
});

test("artifact verification rejects altered, missing and unowned runtime files", (t) => {
  const root = unpack(t);
  const cli = path.join(root, "activity/cao.mjs");
  const source = readFileSync(cli);
  writeFileSync(cli, "altered");
  assert.throws(() => validateCaoRuntimeArtifact(root, revision), /checksum mismatch: activity\/cao.mjs/);
  rmSync(cli);
  assert.throws(() => validateCaoRuntimeArtifact(root, revision), /file inventory does not match/);
  writeFileSync(cli, source);
  writeFileSync(path.join(root, "plugin.json"), "{}");
  const metadataPath = path.join(root, "cao-runtime.json");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  metadata.files["plugin.json"] = "0".repeat(64);
  writeFileSync(metadataPath, JSON.stringify(metadata));
  assert.throws(() => validateCaoRuntimeArtifact(root, revision), /unowned path: plugin.json/);
});

for (const [description, ref, downloadCommand] of [
  ["main/SHA", revision, "run"],
  ["stable release", "v1.2.3", "release"],
]) {
  test(`${description} acquisition verifies the archive, workflow and both exact source digests`, (t) => {
    const { root, commands } = fakeGithub(t);
    const archive = downloadCaoRuntimeArtifact({
      source: `githubnext/gh-cao@${ref}`, resolvedCommit: revision,
    }, path.join(root, "download"));
    assert.deepEqual(readFileSync(archive), readFileSync(artifact.archive));
    const calls = commands();
    assert.ok(calls.some((args) => args[0] === downloadCommand));
    if (downloadCommand === "run") assert.equal(calls.find((args) => args[0] === "run")[2], "9");
    const verification = calls.find((args) => args[0] === "attestation");
    for (const [flag, value] of [
      ["--repo", "githubnext/gh-cao"],
      ["--hostname", "github.com"],
      ["--signer-workflow", "githubnext/gh-cao/.github/workflows/cao-runtime.yml"],
      ["--source-digest", revision], ["--signer-digest", revision],
    ]) assert.equal(verification[verification.indexOf(flag) + 1], value);
    assert.ok(verification.includes("--deny-self-hosted-runners"));
  });
}

test("main/SHA acquisition waits for the active exact runtime build", (t) => {
  const { root, commands } = fakeGithub(t, { pendingBeforeSuccess: 2 });
  const waits = [];
  const archive = downloadCaoRuntimeArtifact({
    source: `githubnext/gh-cao@${revision}`, resolvedCommit: revision,
  }, path.join(root, "download"), {
    attempts: 2,
    intervalMs: 5_000,
    wait: (milliseconds) => waits.push(milliseconds),
  });
  assert.deepEqual(readFileSync(archive), readFileSync(artifact.archive));
  assert.deepEqual(waits, [5_000, 5_000]);
  assert.equal(commands().filter((args) => args[0] === "api" && args.at(-1).includes("/actions/workflows/")).length, 3);
});

for (const [description, options] of [
  ["missing", { missing: true }],
  ["expired", { expired: true }],
  ["unverifiable", { rejection: true }],
]) {
  test(`${description} artifacts fail before any owned runtime is replaced`, async (t) => {
    const { root, commands } = fakeGithub(t, options);
    const consumer = path.join(root, "consumer");
    mkdirSync(path.join(consumer, ".github/aw/packages"), { recursive: true });
    writeFileSync(path.join(consumer, ".github/aw/packages/cao.json"), JSON.stringify({
      package: "githubnext/gh-cao", source: `githubnext/gh-cao@${revision}`, resolvedCommit: revision,
    }));
    mkdirSync(path.join(consumer, "activity"));
    const existing = path.join(consumer, "activity/existing.mjs");
    writeFileSync(existing, "existing");
    writeFileSync(path.join(consumer, "cao.sh"), retiredLauncher);
    await assert.rejects(materializeCao("root", consumer), /No successful, unexpired|invalid signature or source digest/);
    assert.equal(readFileSync(existing, "utf8"), "existing");
    assert.equal(readFileSync(path.join(consumer, "cao.sh"), "utf8"), retiredLauncher);
    assert.equal(commands().some((args) => args[0] === "release"), false);
  });
}

test("a missing focused revision leaves an already validated root runtime untouched", async (t) => {
  const { root } = fakeGithub(t);
  const consumer = path.join(root, "consumer");
  const records = path.join(consumer, ".github/aw/packages");
  mkdirSync(records, { recursive: true });
  for (const [name, sha] of [["root", revision], ["activity", "3".repeat(40)]]) {
    writeFileSync(path.join(records, `${name}.json`), JSON.stringify({
      package: `githubnext/gh-cao${name === "root" ? "" : `/${name}`}`, resolvedCommit: sha,
    }));
  }
  mkdirSync(path.join(consumer, "activity"));
  const existing = path.join(consumer, "activity/existing.mjs");
  writeFileSync(existing, "existing");
  writeFileSync(path.join(consumer, "cao.sh"), retiredLauncher);
  await assert.rejects(materializeCao("root", consumer), /No successful, unexpired/);
  assert.equal(readFileSync(existing, "utf8"), "existing");
  assert.equal(readFileSync(path.join(consumer, "cao.sh"), "utf8"), retiredLauncher);
  assert.equal(existsSync(path.join(consumer, "dashboard")), false);
});

test("remote materialization consumes the prebuilt package and does not invoke npm", async (t) => {
  const { root } = fakeGithub(t);
  const consumer = path.join(root, "consumer");
  mkdirSync(path.join(consumer, ".github/aw/packages"), { recursive: true });
  writeFileSync(path.join(consumer, ".github/aw/packages/cao.json"), JSON.stringify({
    package: "githubnext/gh-cao", resolvedCommit: revision,
  }));
  const npm = path.join(root, "npm");
  writeFileSync(npm, "#!/bin/sh\nexit 99\n");
  chmodSync(npm, 0o755);
  writeFileSync(path.join(consumer, "cao.sh"), retiredLauncher);
  await materializeCao("root", consumer);
  assert.equal(existsSync(path.join(consumer, "cao.sh")), false);
  await materializeCao("root", consumer);
  assert.equal(existsSync(path.join(consumer, "cao.sh")), false);
  assert.deepEqual(readFileSync(path.join(consumer, "activity/cao.mjs")), readFileSync(path.join(catalog, "activity/cao.mjs")));
  assert.equal(existsSync(path.join(consumer, "package.json")), false);
  assert.equal(existsSync(path.join(consumer, "cao-runtime.json")), false);
});

test("the trusted runtime pipeline separates building and attestation from draft asset publication", () => {
  const source = readFileSync(path.join(catalog, ".github/workflows/cao-runtime.yml"), "utf8");
  const workflow = parse(source);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.equal(workflow.on.release, undefined);
  assert.equal(workflow.on.pull_request, undefined);
  assert.equal(workflow.on.workflow_dispatch, undefined);
  assert.equal(workflow.jobs.build.permissions.contents, "read");
  assert.equal(workflow.jobs.build.permissions["id-token"], undefined);
  const setupNode = workflow.jobs.build.steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
  assert.ok(setupNode);
  assert.equal(setupNode.with.cache, undefined);
  assert.equal(setupNode.with["package-manager-cache"], false);
  assert.equal(workflow.jobs.attest.permissions["id-token"], "write");
  assert.equal(workflow.jobs.publish, undefined);
  assert.match(source, /github\.repository == 'githubnext\/gh-cao'/);
  assert.match(source, /retention-days: 90/);
  assert.doesNotMatch(source, /gh release upload|--clobber|npm publish/);
  const attest = workflow.jobs.attest;
  assert.ok(!attest.steps.some((step) => step.uses?.startsWith("actions/checkout")));
  assert.doesNotMatch(attest.steps.map((step) => step.run ?? "").join("\n"), /npm|node |tar |bash .*\.sh/);
  for (const match of source.matchAll(/uses:\s+[^@\s]+@([^\s#]+)/g)) assert.match(match[1], /^[0-9a-f]{40}$/);
});

test("the trusted runtime pipeline seals and attests the Azure deployment assets at the exact SHA", () => {
  const workflow = parse(readFileSync(path.join(catalog, ".github/workflows/cao-runtime.yml"), "utf8"));
  const build = workflow.jobs.build.steps;
  const azureBuild = build.findIndex((step) => step.run === 'npm run build:azure-assets -- "${RUNNER_TEMP}/azure" "${REVISION}"');
  assert.ok(azureBuild > 0);
  assert.equal(build[azureBuild].env.REVISION, "${{ github.sha }}");
  assert.equal(build[azureBuild + 1].with.name, "cao-azure-${{ github.sha }}");
  assert.equal(build[azureBuild + 1].with["if-no-files-found"], "error");
  const attest = workflow.jobs.attest.steps;
  const download = attest.findIndex((step) => step.with?.name === "cao-azure-${{ github.sha }}");
  assert.ok(download > 0);
  assert.equal(attest[download + 1].run, 'sha256sum --check "cao-azure-${REVISION}.tgz.sha256"');
  assert.match(attest[download + 2].uses, /^actions\/attest@[0-9a-f]{40}$/);
  assert.equal(attest[download + 2].with["subject-path"], "${{ runner.temp }}/azure/cao-azure-${{ github.sha }}.tgz");
});
