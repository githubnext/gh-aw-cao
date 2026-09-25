import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import vm from "node:vm";
import { parse } from "yaml";

const executeFile = promisify(execFile);
const catalog = path.resolve(".");
const installScript = path.join(catalog, "install.sh");
const installerSource = await readFile(installScript, "utf8");
const manifest = parse(await readFile(path.join(catalog, "aw.yml"), "utf8"));
const supportedGhAw = manifest["min-version"];
const [major, minor, patch] = supportedGhAw.slice(1).split(".").map(Number);
const olderGhAw = patch > 0 ? `v${major}.${minor}.${patch - 1}` : `${supportedGhAw}-rc.1`;
const newerGhAw = `v${major}.${minor + 1}.0`;
const manifestGhAw = `v${major}.${minor}.${patch + 1}`;
const revision = "1".repeat(40);
const timeout = 30_000;
const policyPath = path.join(".github", "workflows", "cao.json");
const materializer = path.join(".github", "workflows", "shared", "materialize-cao.mjs");
const manualUpgrade = (version) => new RegExp(`Run \`curl -sL \\S+/install-gh-aw\\.sh \\| bash -s -- ${version.replaceAll(".", "\\.")}\`, then rerun the CAO installer`);
const upgradePrompt = /Upgrade it now with curl -sL \S+\/install-gh-aw\.sh \| bash -s -- v\S+\? \[y\/N\]/;
const addedFiles = [
  ...manifest.resources.map(({ source, destination }) => ({ source, destination })),
  ...[".github/workflows/cao-activity.yml", ".github/workflows/cao-dashboard.yml"]
    .map((file) => ({ source: file, destination: file })),
];

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "cao-install-fixture-"));
const archive = path.join(fixtureRoot, "gh-aw-cao.tar.gz");
const mockFetch = path.join(fixtureRoot, "mock-fetch.mjs");
await executeFile("tar", [
  "-czf", archive,
  "--exclude=node_modules", "--exclude=dist", "--exclude=test-results",
  "-C", path.dirname(catalog),
  ...["activity", "dashboard", "cao.sh", "skills", ".github/actions/setup-cao-runtime", ".github/cao/instructions.md"]
    .map((member) => `${path.basename(catalog)}/${member}`),
]);
await writeFile(mockFetch, `
import { appendFileSync, readFileSync } from "node:fs";

const expected = "https://codeload.github.com/githubnext/gh-aw-cao/tar.gz/${revision}";
const responses = process.env.FAKE_GITHUB_RESPONSES ? JSON.parse(process.env.FAKE_GITHUB_RESPONSES) : {};
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input.url ?? String(input);
  if (process.env.FAKE_GITHUB_REQUESTS) appendFileSync(process.env.FAKE_GITHUB_REQUESTS, url + "\\n");
  if (Object.hasOwn(responses, url)) return Response.json(responses[url]);
  if (url !== expected) throw new Error("unexpected fetch: " + url);
  const status = Number(process.env.FAKE_CAO_ARCHIVE_STATUS || 200);
  if (status !== 200) return new Response("unavailable", { status });
  return new Response(readFileSync(process.env.FAKE_CAO_ARCHIVE));
};
`);
test.after(() => rm(fixtureRoot, { recursive: true, force: true }));

// FAKE_CONTROL_REPOSITORY is gh's answer for the consumer checkout; when it is
// unset the lookup fails as it does outside a GitHub repository checkout.
const fakeGh = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "repo view --json nameWithOwner --jq .nameWithOwner" ]]; then
  if [[ -z "\${FAKE_CONTROL_REPOSITORY+set}" ]]; then
    echo "none of the git remotes configured for this repository point to a known GitHub host" >&2
    exit 1
  fi
  printf '%s\\n' "$FAKE_CONTROL_REPOSITORY"
  exit 0
fi
if [[ "\${1:-} \${2:-}" == "aw version" ]]; then
  [[ -f "$FAKE_GH_AW_INSTALLED" ]] || exit 1
  echo "gh aw version $(cat "$FAKE_GH_AW_INSTALLED")" >&2
  exit 0
fi
if [[ "\${1:-} \${2:-}" == "aw add" && "\${3:-}" == githubnext/gh-aw-cao* ]]; then
  stdin_bytes="$(wc -c | tr -d ' ')"
  entry=add
  [[ "\${4:-}" != "--force" ]] || entry=add-force
  [[ "$stdin_bytes" == 0 ]] || entry="$entry stdin=$stdin_bytes"
  echo "$entry" >> "$FAKE_COMMAND_LOG"
  if [[ -n "\${FAKE_ADD_FAILURE:-}" ]]; then
    echo "campaign add failed" >&2
    exit 1
  fi
  current="$(cat "$FAKE_GH_AW_INSTALLED")"
  if [[ -n "\${FAKE_MANIFEST_MIN_VERSION:-}" && "$current" != "$FAKE_MANIFEST_MIN_VERSION" ]]; then
    echo "✗ invalid Agentic Workflow manifest \\"aw.yml\\": min-version \\"$FAKE_MANIFEST_MIN_VERSION\\" requires gh-aw $FAKE_MANIFEST_MIN_VERSION or newer (current: $current)." >&2
    exit 1
  fi
${addedFiles.map(({ source, destination }) => `  mkdir -p "$(dirname '${destination}')"
  cp "$FAKE_CATALOG/${source}" '${destination}'`).join("\n")}
  mkdir -p .github/aw/packages
  cat > .github/aw/packages/githubnext-gh-aw-cao-c6b3479204cc.json <<'EOF'
{"package":"githubnext/gh-aw-cao","source":"githubnext/gh-aw-cao@${revision}","resolvedCommit":"${revision}"}
EOF
  exit 0
fi
exit 2
`;

// Serves gh-aw's install script, which records the requested version as installed.
const fakeCurl = `#!/usr/bin/env bash
echo "curl" >> "$FAKE_COMMAND_LOG"
if [[ -n "\${FAKE_INSTALL_FAILURE:-}" ]]; then
  echo "curl: (22) The requested URL returned error: 503" >&2
  exit 22
fi
[[ -z "\${FAKE_INSTALL_NOOP:-}" ]] || exit 0
cat <<'EOF'
printf '%s\\n' "$1" > "$FAKE_GH_AW_INSTALLED"
EOF
`;

async function createConsumer(t, ghAwVersion, { repository = "alpha-org/control" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const consumer = path.join(root, "consumer");
  const log = path.join(root, "commands.log");
  const ghAwInstalled = path.join(root, "gh-aw-installed");
  await mkdir(bin);
  await mkdir(consumer);
  await writeFile(log, "");
  for (const [name, source] of [["gh", fakeGh], ["curl", fakeCurl], ["curl.exe", fakeCurl]]) {
    await writeFile(path.join(bin, name), source);
    await chmod(path.join(bin, name), 0o755);
  }
  if (ghAwVersion) await writeFile(ghAwInstalled, `${ghAwVersion}\n`);
  const env = {
    ...process.env,
    PATH: `${bin.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replaceAll("\\", "/")}:${process.env.PATH}`,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(mockFetch).href}`].filter(Boolean).join(" "),
    FAKE_CATALOG: catalog,
    FAKE_CAO_ARCHIVE: archive,
    FAKE_COMMAND_LOG: log,
    FAKE_GH_AW_INSTALLED: ghAwInstalled,
    FAKE_CONTROL_REPOSITORY: repository,
  };
  return {
    root,
    consumer,
    repository,
    env,
    log: () => readFile(log, "utf8"),
    installedGhAw: () => readFile(ghAwInstalled, "utf8"),
  };
}

function collect(child, resolve, reject) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.stdin.on("error", reject);
  child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
}

// Detached children start a new session without a controlling terminal, so
// /dev/tty is unavailable regardless of how the test runner was launched.
function runStreamed(cwd, env, installerArguments = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-s", "--", ...installerArguments], { cwd, env, timeout, detached: true });
    collect(child, resolve, reject);
    child.stdin.end(installerSource);
  });
}

async function streamInstaller(cwd, env, installerArguments) {
  const result = await runStreamed(cwd, env, installerArguments);
  assert.equal(result.code, 0, `installer failed (${result.signal ?? "no signal"}):\n${result.stdout}\n${result.stderr}`);
  return result;
}

// script(1) gives the streamed installer a controlling terminal that receives the answer.
function runWithTerminal(cwd, env, answer) {
  const quoted = `'${installScript.replaceAll("'", "'\\''")}'`;
  return new Promise((resolve, reject) => {
    const child = spawn("script", ["-q", "-e", "-c", `cat ${quoted} | bash`, "/dev/null"], {
      cwd, env, timeout, detached: true,
    });
    collect(child, resolve, reject);
    child.stdin.end(`${answer}\n`);
  });
}

function runFile(cwd, env, installerArguments = []) {
  return executeFile("bash", [installScript, ...installerArguments], { cwd, env, timeout, detached: true });
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function assertExecutable(file) {
  if (process.platform !== "win32") assert.notEqual((await stat(file)).mode & 0o111, 0);
}

async function assertCompleteInstall(consumer, env, ghAwVersion, repository) {
  const policy = JSON.parse(await readFile(path.join(consumer, policyPath), "utf8"));
  assert.equal(policy.version, 1);
  assert.equal(policy["gh-aw-version"], ghAwVersion);
  assert.deepEqual(policy["control-plane"], {
    scope: { "allowed-owners": [repository.split("/")[0]], "allowed-repositories": [repository] },
    campaigns: {},
  });
  await assertExecutable(path.join(consumer, "cao.sh"));
  const launcher = process.platform === "win32" ? ["bash", ["./cao.sh", "--help"]] : ["./cao.sh", ["--help"]];
  await executeFile(...launcher, { cwd: consumer, env, timeout });
  for (const bundle of ["activity", "dashboard"]) {
    await executeFile(process.execPath, [materializer, "verify", bundle], { cwd: consumer, env, timeout });
  }
}

async function assertNothingInstalled(consumer) {
  assert.equal(await exists(path.join(consumer, policyPath)), false);
  assert.equal(await exists(path.join(consumer, "cao.sh")), false);
}

const githubApi = "https://api.example.invalid";
const deterministicWorkflows = [".github/workflows/cao-activity.yml", ".github/workflows/cao-dashboard.yml"];

function githubFixture(repository) {
  const [owner, name] = repository.split("/");
  return {
    [`${githubApi}/repos/${repository}`]: {
      id: 101,
      name,
      full_name: repository,
      owner: { login: owner },
      private: true,
      visibility: "private",
      archived: false,
      default_branch: "main",
      html_url: `https://github.com/${repository}`,
    },
    [`${githubApi}/repos/${repository}/actions/workflows?per_page=100&page=1`]: {
      total_count: deterministicWorkflows.length,
      workflows: deterministicWorkflows.map((file, index) => ({
        id: 201 + index,
        name: path.basename(file, ".yml"),
        path: file,
        state: "active",
        html_url: `https://github.com/${repository}/blob/main/${file}`,
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-02T00:00:00Z",
      })),
    },
    [`${githubApi}/repos/github/gh-aw/releases?per_page=100&page=1`]: [
      { tag_name: supportedGhAw, draft: false, prerelease: false },
    ],
  };
}

// Mirrors the Activity job environment when no read-only GitHub App is configured.
function activityEnvironment(root, consumer, env, repository) {
  const work = path.join(consumer, ".cao-activity");
  return {
    ...env,
    GITHUB_REPOSITORY: repository,
    ACTIVITY_APP_TOKEN: "",
    GH_TOKEN: "synthetic-workflow-token",
    GITHUB_API_URL: githubApi,
    REPORT_CONTROL_SETTINGS: path.join(work, "control-settings.json"),
    REPORT_INVENTORY: path.join(work, "control-plane-inventory.json"),
    REPORT_INVENTORY_SOURCES: path.join(work, "inventory-sources.json"),
    FAKE_GITHUB_RESPONSES: JSON.stringify(githubFixture(repository)),
    FAKE_GITHUB_REQUESTS: path.join(root, "github-requests.log"),
  };
}

async function resolveActivitySettings(consumer, activityEnv) {
  await executeFile(process.execPath, [
    path.join("activity", "control-settings.mjs"),
    path.join(".github", "workflows", "shared", "control.mjs"),
    policyPath,
    activityEnv.REPORT_CONTROL_SETTINGS,
  ], { cwd: consumer, env: activityEnv, timeout });
  return JSON.parse(await readFile(activityEnv.REPORT_CONTROL_SETTINGS, "utf8"));
}

// Executes the installed workflow's complete inventory script as github-script
// would, with exec.getExecOutput spawning the installed CLI in the consumer.
async function runInventoryStep(consumer, activityEnv, spawned = []) {
  const workflow = parse(await readFile(path.join(consumer, ".github", "workflows", "cao-activity.yml"), "utf8"));
  const step = Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .find(({ name }) => name === "Collect dashboard inventory");
  assert.ok(step?.with?.script, "installed Activity workflow collects dashboard inventory");
  const logs = [];
  const context = {
    require(specifier) {
      const modules = { fs, path };
      if (!Object.hasOwn(modules, specifier)) throw new Error(`unexpected require: ${specifier}`);
      return modules[specifier];
    },
    process: { env: activityEnv, execPath: process.execPath },
    core: { info: (message) => { logs.push(message); } },
    exec: {
      getExecOutput(command, args, { ignoreReturnCode = false } = {}) {
        spawned.push(args);
        return new Promise((resolve, reject) => {
          const child = spawn(command, args, { cwd: consumer, env: activityEnv, timeout, stdio: ["ignore", "pipe", "pipe"] });
          let stdout = "";
          let stderr = "";
          child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
          child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
          child.on("error", reject);
          child.on("close", (exitCode) => {
            if (exitCode !== 0 && !ignoreReturnCode) reject(new Error(`${command} exited with ${exitCode}: ${stderr}`));
            else resolve({ exitCode, stdout, stderr });
          });
        });
      },
    },
  };
  try {
    await vm.runInNewContext(`(async () => {\n${step.with.script}\n})()`, context);
  } catch (error) {
    throw new Error(`${error.message}\n${logs.join("\n")}`, { cause: error });
  }
  return { spawned, logs };
}

async function githubRequests(activityEnv) {
  if (!await exists(activityEnv.FAKE_GITHUB_REQUESTS)) return [];
  return (await readFile(activityEnv.FAKE_GITHUB_REQUESTS, "utf8")).trim().split("\n").filter(Boolean);
}

for (const [state, initialVersion, expectedVersion, expectedLog] of [
  ["missing gh-aw", undefined, supportedGhAw, "curl\nadd\n"],
  [`gh-aw ${supportedGhAw}`, supportedGhAw, supportedGhAw, "add\n"],
  [`gh-aw ${newerGhAw}`, newerGhAw, newerGhAw, "add\n"],
]) {
  test(`streamed install.sh with ${state} materializes the runtime and initializes policy`, async (t) => {
    const { consumer, repository, env, log } = await createConsumer(t, initialVersion);
    await streamInstaller(consumer, env);
    assert.equal(await log(), expectedLog);
    await assertCompleteInstall(consumer, env, expectedVersion, repository);
  });
}

test("streamed install.sh scopes policy to gh's current repository, not the ambient GITHUB_REPOSITORY", async (t) => {
  const { consumer, repository, env, log } = await createConsumer(t, supportedGhAw, { repository: "beta-org/ops.tools" });
  await streamInstaller(consumer, { ...env, GITHUB_REPOSITORY: "catalog-org/ambient" });
  assert.equal(await log(), "add\n");
  await assertCompleteInstall(consumer, env, supportedGhAw, repository);
});

test(`streamed install.sh with gh-aw ${olderGhAw} and no terminal stops with upgrade guidance`, async (t) => {
  const { consumer, env, log, installedGhAw } = await createConsumer(t, olderGhAw);
  const result = await streamInstaller(consumer, env);
  assert.match(result.stdout, manualUpgrade(supportedGhAw));
  assert.equal(await log(), "");
  assert.equal(await installedGhAw(), `${olderGhAw}\n`);
  await assertNothingInstalled(consumer);
});

test(`streamed install.sh requires the local aw.yml min-version ${manifestGhAw} before adding`, async (t) => {
  const { consumer, env, log, installedGhAw } = await createConsumer(t, supportedGhAw);
  await writeFile(path.join(consumer, "aw.yml"), `min-version: ${manifestGhAw}\n`);
  const result = await streamInstaller(consumer, env);
  assert.match(result.stdout, manualUpgrade(manifestGhAw));
  assert.equal(await log(), "");
  assert.equal(await installedGhAw(), `${supportedGhAw}\n`);
  await assertNothingInstalled(consumer);
});

test("install.sh exits nonzero when a fresh gh-aw install does not provide the required version", async (t) => {
  const { consumer, env, log } = await createConsumer(t);
  const result = await runStreamed(consumer, { ...env, FAKE_INSTALL_NOOP: "1" });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, new RegExp(`Failed to verify gh-aw installation: expected at least ${supportedGhAw.replaceAll(".", "\\.")}, got no version`));
  assert.equal(await log(), "curl\n");
  await assertNothingInstalled(consumer);
});

test("install.sh does not retry when the campaign manifest rejects the installed gh-aw", async (t) => {
  const { consumer, env, log, installedGhAw } = await createConsumer(t, supportedGhAw);
  const result = await runStreamed(consumer, { ...env, FAKE_MANIFEST_MIN_VERSION: manifestGhAw });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, new RegExp(`min-version "${manifestGhAw}" requires gh-aw`));
  assert.equal(await log(), "add\n");
  assert.equal(await installedGhAw(), `${supportedGhAw}\n`);
  await assertNothingInstalled(consumer);
});

const terminalCases = [
  {
    name: `approved upgrade of gh-aw ${olderGhAw} completes installation`,
    initialVersion: olderGhAw,
    answer: "y",
    expectedLog: "curl\nadd\n",
    expectedVersion: supportedGhAw,
  },
  {
    name: `declined upgrade of gh-aw ${olderGhAw} stops with upgrade guidance`,
    initialVersion: olderGhAw,
    answer: "n",
    expectedLog: "",
  },
  {
    name: `failed approved upgrade of gh-aw ${olderGhAw} exits nonzero`,
    initialVersion: olderGhAw,
    answer: "y",
    environment: { FAKE_INSTALL_FAILURE: "1" },
    expectedLog: "curl\n",
    failure: /Failed to install gh-aw/,
  },
  {
    name: `approved upgrade that does not provide gh-aw ${supportedGhAw} exits nonzero`,
    initialVersion: olderGhAw,
    answer: "y",
    environment: { FAKE_INSTALL_NOOP: "1" },
    expectedLog: "curl\n",
    failure: /Failed to verify gh-aw installation/,
  },
  {
    name: `approved upgrade to the local aw.yml min-version ${manifestGhAw} completes installation`,
    initialVersion: supportedGhAw,
    answer: "y",
    manifest: manifestGhAw,
    expectedLog: "curl\nadd\n",
    expectedVersion: manifestGhAw,
  },
];

for (const { name, initialVersion, answer, environment = {}, manifest, expectedLog, expectedVersion, failure } of terminalCases) {
  test(`install.sh on a terminal: ${name}`, { skip: process.platform === "win32" }, async (t) => {
    const { consumer, repository, env, log, installedGhAw } = await createConsumer(t, initialVersion);
    if (manifest) await writeFile(path.join(consumer, "aw.yml"), `min-version: ${manifest}\n`);
    const terminalEnv = { ...env, ...environment };
    const result = await runWithTerminal(consumer, terminalEnv, answer);
    assert.match(result.stdout, upgradePrompt);
    assert.equal(await log(), expectedLog);
    if (failure) {
      assert.notEqual(result.code, 0, result.stdout);
      assert.match(result.stdout, failure);
      assert.equal(await installedGhAw(), `${initialVersion}\n`);
      await assertNothingInstalled(consumer);
    } else if (expectedVersion) {
      assert.equal(result.code, 0, result.stdout);
      assert.equal(await installedGhAw(), `${expectedVersion}\n`);
      await assertCompleteInstall(consumer, terminalEnv, expectedVersion, repository);
    } else {
      assert.equal(result.code, 0, result.stdout);
      assert.match(result.stdout, manualUpgrade(supportedGhAw));
      assert.equal(await installedGhAw(), `${initialVersion}\n`);
      await assertNothingInstalled(consumer);
    }
  });
}

test("install.sh reruns restore missing policy and launcher mode without replacing consumer policy", async (t) => {
  const { consumer, repository, env, log } = await createConsumer(t, supportedGhAw);
  await runFile(consumer, env);
  assert.equal(await log(), "add\n");
  await assertCompleteInstall(consumer, env, supportedGhAw, repository);

  await rm(path.join(consumer, policyPath));
  await runFile(consumer, env);
  assert.equal(await log(), "add\n");
  await assertCompleteInstall(consumer, env, supportedGhAw, repository);

  // Existing policies are consumer-owned: reruns neither look up nor narrow their scope.
  const { FAKE_CONTROL_REPOSITORY: _, ...withoutLookup } = env;
  const customPolicy = '{"version":1,"gh-aw-version":"v9.9.9","control-plane":{"campaigns":{"custom":{}}}}\n';
  await writeFile(path.join(consumer, policyPath), customPolicy);
  await chmod(path.join(consumer, "cao.sh"), 0o644);
  await streamInstaller(consumer, withoutLookup);
  assert.equal(await log(), "add\n");
  assert.equal(await readFile(path.join(consumer, policyPath), "utf8"), customPolicy);
  await assertExecutable(path.join(consumer, "cao.sh"));

  await runFile(consumer, withoutLookup, ["githubnext/gh-aw-cao@v1.2.3"]);
  assert.equal(await log(), "add\nadd-force\n");
  assert.equal(await readFile(path.join(consumer, policyPath), "utf8"), customPolicy);

  const ownerPolicy = `${JSON.stringify({
    version: 1,
    "gh-aw-version": supportedGhAw,
    "control-plane": { scope: { "allowed-owners": ["alpha-org"] }, campaigns: {} },
  })}\n`;
  await writeFile(path.join(consumer, policyPath), ownerPolicy);
  await streamInstaller(consumer, withoutLookup, ["githubnext/gh-aw-cao@v1.2.3"]);
  assert.equal(await log(), "add\nadd-force\nadd-force\n");
  assert.equal(await readFile(path.join(consumer, policyPath), "utf8"), ownerPolicy);
  await executeFile(process.execPath, [path.join(".github", "workflows", "shared", "control.mjs"), "validate-policy", policyPath], {
    cwd: consumer, env: withoutLookup, timeout,
  });
});

for (const [failure, environment, expectedLog] of [
  ["campaign add fails", { FAKE_ADD_FAILURE: "1" }, "add\n"],
  ["the immutable archive download fails", { FAKE_CAO_ARCHIVE_STATUS: "503" }, "add\n"],
]) {
  test(`install.sh exits nonzero without policy when ${failure}`, async (t) => {
    const { consumer, env, log } = await createConsumer(t, supportedGhAw);
    const result = await runStreamed(consumer, { ...env, ...environment });
    assert.notEqual(result.code, 0);
    assert.equal(await log(), expectedLog);
    await assertNothingInstalled(consumer);
  });
}

for (const [description, repository] of [
  ["fails", undefined],
  ["returns no repository", ""],
  ["returns a malformed repository", "not a repository"],
  ["returns multiple repositories", "alpha-org/control\nbeta-org/ops.tools"],
]) {
  test(`install.sh exits nonzero without policy when the repository lookup ${description}`, async (t) => {
    const { consumer, env, log } = await createConsumer(t, supportedGhAw);
    const { FAKE_CONTROL_REPOSITORY: _, ...withoutLookup } = env;
    const lookupEnv = repository === undefined ? withoutLookup : { ...env, FAKE_CONTROL_REPOSITORY: repository };
    const result = await runStreamed(consumer, lookupEnv);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Unable to determine control repository: .*Run cao init from a GitHub repository checkout with a configured remote\./s);
    assert.equal(await log(), "add\n");
    assert.equal(await exists(path.join(consumer, policyPath)), false);
    await executeFile(process.execPath, [materializer, "verify", "activity"], { cwd: consumer, env, timeout });
  });
}

test("streamed install.sh initializes repository-only Activity without an App", async (t) => {
  const { root, consumer, repository, env, log } = await createConsumer(t, supportedGhAw);
  await streamInstaller(consumer, env);
  assert.equal(await log(), "add\n");

  const activityEnv = activityEnvironment(root, consumer, env, repository);
  const settings = await resolveActivitySettings(consumer, activityEnv);
  assert.equal(settings.policy_resolution.status, "available", settings.policy_resolution.reason);
  const { spawned } = await runInventoryStep(consumer, activityEnv);

  assert.deepEqual(settings.allowed_owners, [repository.split("/")[0]]);
  assert.deepEqual(settings.allowed_repositories, [repository]);
  assert.deepEqual(settings.campaigns, {});
  assert.equal(spawned.length, 1);
  const sources = JSON.parse(await readFile(activityEnv.REPORT_INVENTORY_SOURCES, "utf8"));
  const [owner, name] = repository.split("/");
  assert.deepEqual(sources.campaigns.rows, []);
  assert.deepEqual(
    sources.repositories.rows.map((row) => [row.organization, row.repository, row.visibility]),
    [[owner, name, "private"]],
  );
  assert.equal(sources.repositories.metadata.completeness, "complete");
  assert.deepEqual(
    sources.workflows.rows.map((row) => [row.organization, row.repository, row.workflow, row["workflow-registry-state"]]),
    deterministicWorkflows.map((file) => [owner, name, file, "active"]),
  );
  assert.equal(sources.workflows.metadata.completeness, "complete");
  assert.deepEqual((await githubRequests(activityEnv)).sort(), Object.keys(githubFixture(repository)).sort());
});

test("installed Activity still requires the App for an owner-wide policy", async (t) => {
  const { root, consumer, repository, env } = await createConsumer(t, supportedGhAw);
  await streamInstaller(consumer, env);
  await writeFile(path.join(consumer, policyPath), `${JSON.stringify({
    version: 1,
    "gh-aw-version": supportedGhAw,
    "control-plane": { scope: { "allowed-owners": [repository.split("/")[0]] }, campaigns: {} },
  })}\n`);

  const activityEnv = activityEnvironment(root, consumer, env, repository);
  const settings = await resolveActivitySettings(consumer, activityEnv);
  assert.equal(settings.policy_resolution.status, "available", settings.policy_resolution.reason);
  assert.deepEqual(settings.allowed_repositories, []);
  const spawned = [];
  await assert.rejects(runInventoryStep(consumer, activityEnv, spawned), /Owner-wide repository discovery requires the read-only GitHub App/);
  assert.deepEqual(spawned, []);
  assert.deepEqual(await githubRequests(activityEnv), []);
});
