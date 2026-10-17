import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import vm from "node:vm";
import { parse } from "yaml";
import { materializeCaoFromSource } from "../../.github/workflows/shared/materialize-cao.mjs";
import { buildCaoRuntime } from "../../scripts/build-cao-runtime.mjs";
import { runTerminal } from "../helpers/terminal.mjs";

const executeFile = promisify(execFile);
const catalog = path.resolve(".");
const installScript = path.join(catalog, "install.sh");
const installerSource = await readFile(installScript, "utf8");
const manifest = parse(await readFile(path.join(catalog, "aw.yml"), "utf8"));
const supportedGh = "v2.68.0";
const olderGh = "v2.67.0";
const supportedGhAw = manifest["min-version"];
const [major, minor, patch] = supportedGhAw.slice(1).split(".").map(Number);
const olderGhAw = patch > 0 ? `v${major}.${minor}.${patch - 1}` : `${supportedGhAw}-rc.1`;
const newerGhAw = `v${major}.${minor + 1}.0`;
const manifestGhAw = `v${major}.${minor}.${patch + 1}`;
const revision = "1".repeat(40);
const timeout = 30_000;
const policyPath = path.join(".github", "workflows", "cao.json");
const materializer = path.join(".github", "workflows", "shared", "materialize-cao.mjs");
const curlCommand = "curl --fail --show-error --location";
const manualUpgrade = (version) => new RegExp(`Run \`${curlCommand} \\S+/install-gh-aw\\.sh \\| bash -s -- ${version.replaceAll(".", "\\.")}\`, then rerun the CAO installer`);

test("quickstart keeps terminal presentation and filters Node experimental warnings", () => {
  assert.match(installerSource, /run_cao_quickstart\(\)[\s\S]*?terminal_available[\s\S]*?< \/dev\/tty/);
  assert.match(installerSource, /--disable-warning=ExperimentalWarning/);
  assert.match(installerSource, /quickstart_arguments=\(quickstart\)/);
  assert.match(installerSource, /quickstart_arguments\+=\(--target "\$target_repository"\)/);
  assert.doesNotMatch(installerSource, /default_quickstart_control_repository|default_repository_name/);
  assert.match(installerSource, /Quickstart requires a clean control-repository checkout before installation/);
  assert.match(installerSource, /Quickstart selected stable CAO release \$quickstart_release/);
});
const upgradePrompt = new RegExp(`Upgrade it now with ${curlCommand} \\S+/install-gh-aw\\.sh \\| bash -s -- v\\S+\\? \\[y/N\\]`);
const addedFiles = [
  ...manifest.resources.map(({ source, destination }) => ({
    source: path.normalize(source),
    destination,
  })),
  {
    source: ".github/workflows/aw.json",
    destination: ".github/workflows/aw.json",
  },
  ...[".github/workflows/cao-activity.yml", ".github/workflows/cao-dashboard.yml", ".github/workflows/cao-validate.yml"]
    .map((file) => ({ source: file, destination: file })),
];

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "cao-install-fixture-"));
const archive = path.join(fixtureRoot, "gh-aw-cao.tar.gz");
const archiveName = path.basename(archive);
const runtimeArchive = buildCaoRuntime(catalog, fixtureRoot, revision).archive;
const mockFetch = path.join(fixtureRoot, "mock-fetch.mjs");
const archiveResources = [
  "activity",
  "dashboard",
  "runtime/package.json",
  "cao.sh",
  "skills",
  "plugin.json",
  "com.github.copilot/extensions/cao-dashboard",
  "specs/dashboard-data.md",
  "docs/dashboard-language-specification.md",
  ".github/skills/generate-dashboard-ir",
  ".github/skills/dashboard-authoring/SKILL.md",
  ".github/skills/author-dashboard-intent/SKILL.md",
  ".github/actions/setup-cao-runtime",
  ".github/actions/setup-gh-aw",
  ".github/cao/instructions.md",
  ".github/workflows/shared/activity-cache.md",
  ".github/workflows/shared/control.md",
  ".github/workflows/shared/review-bundle.md",
];
const { stdout: trackedArchiveFiles } = await executeFile("git", ["ls-files", "-z", "--", ...archiveResources], { cwd: catalog });
const archiveMembers = [...new Set([
  ...trackedArchiveFiles.split("\0").filter(Boolean),
  "runtime/package.json",
])].map((member) => `${path.basename(catalog)}/${member}`);
// Keep the tracked inventory out of Windows' bounded process command line.
const archiveMembersName = "archive-members.txt";
await writeFile(path.join(fixtureRoot, archiveMembersName), `${archiveMembers.join("\0")}\0`);
await executeFile("tar", [
  "-czf", archiveName,
  "-C", path.dirname(catalog),
  "--null", "-T", archiveMembersName,
], { cwd: fixtureRoot });
await writeFile(mockFetch, `
import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";

if (process.env.FAKE_GH_SCRIPT && [process.execPath, process.argv0].some((executable) => basename(executable).toLowerCase() === "gh.exe")) {
 const result = spawnSync("bash", [process.env.FAKE_GH_SCRIPT, basename(process.argv[1]), ...process.argv.slice(2)], { stdio: "inherit" });
 process.exit(result.status ?? 1);
}

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

test("installer fixture archive contains every tracked runtime source and no generated files", async () => {
  const { stdout } = await executeFile("tar", ["-tzf", archiveName], { cwd: fixtureRoot });
  assert.deepEqual(stdout.trimEnd().split(/\r?\n/).sort(), [...archiveMembers].sort());
});

// FAKE_CONTROL_REPOSITORY is gh's answer for the consumer checkout; when it is
// unset the lookup fails as it does outside a GitHub repository checkout.
const fakeGh = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "--version" ]]; then
  echo "gh version \${FAKE_GH_VERSION:-${supportedGh}} (fake)"
  exit 0
fi
if [[ "$*" == "auth status" ]]; then
  [[ -z "\${FAKE_AUTH_DELAY:-}" ]] || sleep "$FAKE_AUTH_DELAY"
  [[ -z "\${FAKE_AUTH_FAILURE:-}" ]] || { echo "not signed in" >&2; exit 1; }
  exit 0
fi
if [[ "\${1:-} \${2:-}" == "release view" ]]; then
  printf '%s\\n' "\${FAKE_EXTENSION_RELEASE:-v1.2.3}"
  exit 0
fi
if [[ "\${1:-} \${2:-}" == "release download" ]]; then
  echo "$*" >> "$FAKE_COMMAND_LOG"
  [[ -z "\${FAKE_EXTENSION_FAILURE:-}" ]] || exit 1
  asset=""
  destination=""
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == --pattern && "$2" != checksums.txt ]]; then asset="$2"; fi
    if [[ "$1" == --dir ]]; then destination="$2"; fi
    shift
  done
  printf '#!/usr/bin/env bash\\necho "gh-cao v1.2.3"\\n' > "$destination/$asset"
  if command -v sha256sum >/dev/null 2>&1; then
    checksum="$(sha256sum "$destination/$asset")"
  else
    checksum="$(shasum -a 256 "$destination/$asset")"
  fi
  printf '%s  %s\\n' "\${checksum%% *}" "$asset" > "$destination/checksums.txt"
  [[ -z "\${FAKE_EXTENSION_BAD_CHECKSUM:-}" ]] || echo corrupt >> "$destination/$asset"
  exit 0
fi
if [[ "$*" == "cao version" ]]; then
  echo "$*" >> "$FAKE_COMMAND_LOG"
  [[ -z "\${FAKE_EXTENSION_VERIFY_FAILURE:-}" ]] || exit 1
  echo "gh-cao v1.2.3"
  exit 0
fi
if [[ "$*" == "api --hostname github.com --paginate repos/githubnext/gh-aw-cao/releases?per_page=100 --jq .[] | [.draft, .prerelease, .tag_name] | @tsv" ]]; then
  [[ -z "\${FAKE_LATEST_CAO_RELEASE_FAILURE:-}" ]] || { echo "release lookup failed" >&2; exit 1; }
  printf '%b\\n' "\${FAKE_CAO_RELEASE_LIST:-false\\\\tfalse\\\\t\${FAKE_LATEST_CAO_RELEASE:-v1.2.3}}"
  exit 0
fi
if [[ "\${1:-} \${2:-}" == "api graphql" ]]; then
  [[ "$*" == *"viewerCanCreateRepositories"* ]] || exit 2
  [[ -z "\${FAKE_OWNER_DISCOVERY_FAILURE:-}" ]] || { echo "owner lookup failed" >&2; exit 1; }
  echo "owners-query" >> "$FAKE_COMMAND_LOG"
  printf '%b\\n' "\${FAKE_REPOSITORY_OWNERS:-alpha-user\\\\nalpha-org}"
  exit 0
fi
if [[ "\${1:-}" == api && "\${2:-}" == repos/*/pages ]]; then
  printf '{"build_type":"workflow","public":true,"html_url":"https://example.invalid/cao/"}\\n'
  exit 0
fi
if [[ "\${1:-}" == api && "\${2:-}" == repos/* && "$#" -eq 2 ]]; then
  if [[ "\${2#repos/}" == "\${FAKE_REPOSITORY_CHECK_FAILURE:-}" ]]; then
    echo "gh: service unavailable (HTTP 503)" >&2
    exit 1
  fi
  if [[ ",\${FAKE_EXISTING_REPOSITORIES:-}," == *",\${2#repos/},"* ]]; then
    exit 0
  fi
  echo "gh: Not Found (HTTP 404)" >&2
  exit 1
fi
if [[ "\${1:-} \${2:-}" == "repo create" ]]; then
  [[ -z "\${FAKE_CREATE_REPOSITORY_FAILURE:-}" ]] || { echo "Repository already exists" >&2; exit 1; }
  if [[ "$*" == "repo create $FAKE_CONTROL_REPOSITORY --private --clone" ]]; then
    echo "create-private" >> "$FAKE_COMMAND_LOG"
    mkdir "\${3#*/}"
    git -C "\${3#*/}" init --quiet
    git -C "\${3#*/}" remote add origin "https://github.com/\${3}.git"
    printf 'Created repository %s on github.com\\n  https://github.com/%s\\n' "\${3}" "\${3}"
  elif [[ "$*" == "repo create $FAKE_CONTROL_REPOSITORY --private --source=. --remote=origin" ]]; then
    echo "create-private-current" >> "$FAKE_COMMAND_LOG"
    git remote add origin "https://github.com/$FAKE_CONTROL_REPOSITORY.git"
    printf 'Created repository %s on github.com\\n  https://github.com/%s\\n' "$FAKE_CONTROL_REPOSITORY" "$FAKE_CONTROL_REPOSITORY"
  else
    exit 2
  fi
  exit 0
fi
if [[ "\${1:-}" == api && "$*" == *"/actions/workflows/cao-runtime.yml/runs?"* ]]; then
  printf '%s\\n' '[{"workflow_runs":[{"id":42,"head_sha":"${revision}","conclusion":"success","event":"push"}]}]'
  exit 0
fi
if [[ "\${1:-}" == api && "$*" == *"/actions/runs/42/artifacts?"* ]]; then
  printf '%s\\n' '[{"artifacts":[{"name":"cao-runtime-${revision}","expired":false}]}]'
  exit 0
fi
if [[ "\${1:-} \${2:-}" == "run download" ]]; then
  [[ "\${FAKE_CAO_ARCHIVE_STATUS:-200}" == 200 ]] || { echo "HTTP 503" >&2; exit 1; }
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == --dir ]]; then destination="$2"; break; fi
    shift
  done
  cp "$FAKE_CAO_RUNTIME_ARCHIVE" "$destination/cao-runtime-${revision}.tgz"
  exit 0
fi
if [[ "\${1:-} \${2:-}" == "attestation verify" ]]; then
  [[ -z "\${FAKE_CAO_ATTESTATION_FAILURE:-}" ]] || { echo "attestation rejected" >&2; exit 1; }
  exit 0
fi
if [[ "$*" == "repo view --json nameWithOwner --jq .nameWithOwner" ]]; then
  if { [[ -n "\${FAKE_REPOSITORY_LOOKUP_FAILURE:-}" ]] && ! git remote get-url origin >/dev/null 2>&1; } ||
    [[ -z "\${FAKE_CONTROL_REPOSITORY+set}" ]]; then
    echo "none of the git remotes configured for this repository point to a known GitHub host" >&2
    exit 1
  fi
  printf '%s\\n' "$FAKE_CONTROL_REPOSITORY"
  exit 0
fi
if [[ "\${1:-} \${2:-}" == "repo view" && "\${3:-}" == "$FAKE_CONTROL_REPOSITORY" ]]; then
  printf '{"nameWithOwner":"%s","visibility":"%s"}\\n' "$3" "\${FAKE_CONTROL_VISIBILITY:-PRIVATE}"
  exit 0
fi
if [[ "$*" == "variable set GH_AW_GITHUB_AUTH_MODE --repo \${FAKE_CONTROL_REPOSITORY:-} --body workflow-token" ]]; then
  echo "setup-workflow-token" >> "$FAKE_COMMAND_LOG"
  exit 0
fi
if [[ "\${1:-} \${2:-}" == "aw version" ]]; then
  [[ -f "$FAKE_GH_AW_INSTALLED" ]] || exit 1
  echo "gh aw version $(cat "$FAKE_GH_AW_INSTALLED")" >&2
  exit 0
fi
if [[ "\${1:-} \${2:-}" == "aw add" && "\${3:-}" == githubnext/gh-aw-cao* ]]; then
  [[ "\${3:-}" == githubnext/gh-aw-cao || "\${3:-}" == githubnext/gh-aw-cao@* ]] || { echo "unexpected CAO package: \${3:-}" >&2; exit 2; }
  [[ -z "\${FAKE_EXPECT_CAO_SOURCE:-}" || "\${3:-}" == "$FAKE_EXPECT_CAO_SOURCE" ]] ||
    { echo "expected CAO package $FAKE_EXPECT_CAO_SOURCE, got \${3:-}" >&2; exit 2; }
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
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const bin = path.join(root, "bin");
  const consumer = path.join(root, "consumer");
  const log = path.join(root, "commands.log");
  const ghAwInstalled = path.join(root, "gh-aw-installed");
  await mkdir(bin);
  await mkdir(consumer);
  await executeFile("git", ["init", "--quiet", consumer]);
  await executeFile("git", ["-C", consumer, "remote", "add", "origin", `https://github.com/${repository}.git`]);
  await writeFile(log, "");
  for (const [name, source] of [
    ["gh", fakeGh],
    ["gh.cmd", "@echo off\r\nbash \"%~dp0gh\" %*\r\n"],
    ["curl", fakeCurl],
    ["curl.exe", fakeCurl],
    ["npm", "#!/usr/bin/env bash\necho 'npm must not run during installation' >&2\nexit 1\n"],
  ]) {
    await writeFile(path.join(bin, name), source);
    await chmod(path.join(bin, name), 0o755);
  }
  if (process.platform === "win32") await copyFile(process.execPath, path.join(bin, "gh.exe"));
  if (ghAwVersion) await writeFile(ghAwInstalled, `${ghAwVersion}\n`);
  const inheritedEnv = { ...process.env };
  const inheritedPath = inheritedEnv.PATH ?? inheritedEnv.Path ?? "";
  if (process.platform === "win32") delete inheritedEnv.Path;
  const systemPath = process.platform === "win32"
    ? inheritedPath.split(path.delimiter).filter((directory) => path.basename(directory).toLowerCase() !== "github cli").join(path.delimiter)
    : inheritedPath;
  const env = {
    ...inheritedEnv,
    PATH: `${bin}${path.delimiter}${systemPath}`,
    CI: "",
    ...(process.platform === "win32" ? { PATHEXT: ".CMD;.COM;.EXE;.BAT" } : {}),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(mockFetch).href}`].filter(Boolean).join(" "),
    FAKE_CATALOG: catalog,
    FAKE_GH_SCRIPT: path.join(bin, "gh"),
    FAKE_CAO_ARCHIVE: archive,
    FAKE_CAO_RUNTIME_ARCHIVE: runtimeArchive,
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
  return runTerminal("bash", ["-c", `cat ${quoted} | bash`], { cwd, env, timeout, input: `${answer}\nn\n` });
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

async function assertCompleteInstall(consumer, env, ghAwVersion, repository, { activity = false } = {}) {
  const policy = JSON.parse(await readFile(path.join(consumer, policyPath), "utf8"));
  assert.equal(policy.version, 1);
  assert.equal(policy["gh-aw-version"], ghAwVersion);
  assert.deepEqual(policy["control-plane"], {
    scope: { "allowed-owners": [repository.split("/")[0]], "allowed-repositories": [repository] },
    ...(activity ? { activity: { repositories: [repository] } } : {}),
    marketplace: {
      registries: [{
        id: "official",
        name: "Official CAO catalog",
        repository: "githubnext/gh-aw-cao",
        ref: "main",
        auth: { type: "none" },
      }, {
        id: "agentics",
        name: "Agentics workflows",
        repository: "githubnext/agentics",
        path: "workflows",
        format: "workflows",
        ref: "main",
        auth: { type: "none" },
      }],
    },
    campaigns: {},
  });
  await assertExecutable(path.join(consumer, "cao.sh"));
  const launcher = process.platform === "win32" ? ["bash", ["./cao.sh", "--help"]] : ["./cao.sh", ["--help"]];
  await executeFile(...launcher, { cwd: consumer, env, timeout });
  for (const bundle of ["activity", "dashboard"]) {
    await executeFile(process.execPath, [materializer, "verify", bundle], { cwd: consumer, env, timeout });
  }
  for (const file of [
    "plugin.json",
    "com.github.copilot/extensions/cao-dashboard/extension.mjs",
    "specs/dashboard-data.md",
    "skills",
    "dashboard/site/test",
    "dashboard/site/screenshots",
  ]) {
    assert.equal(await exists(path.join(consumer, file)), false, `${file} is not runtime`);
  }
}

async function assertNothingInstalled(consumer) {
  assert.equal(await exists(path.join(consumer, policyPath)), false);
  assert.equal(await exists(path.join(consumer, "cao.sh")), false);
}

for (const version of ["", "v1.2.3"]) {
  test(`streamed extension-only installation ${version || "latest"} works outside a checkout`, async (t) => {
    const fixture = await createConsumer(t, supportedGhAw);
    fixture.env.XDG_DATA_HOME = path.join(fixture.root, "data");
    const args = ["--extension", ...(version ? ["--version", version] : [])];
    const result = await streamInstaller(fixture.root, fixture.env, args);
    assert.match(result.stdout, /GitHub CLI extension installed/);
    assert.match(await fixture.log(), /release download v1\.2\.3 --repo githubnext\/gh-aw-cao --pattern (linux|darwin|windows)-(amd64|arm64)(\.exe)? --pattern checksums.txt --dir /);
    const binary = path.join(fixture.env.XDG_DATA_HOME, "gh", "extensions", "gh-cao", process.platform === "win32" ? "gh-cao.exe" : "gh-cao");
    assert.match(await readFile(binary, "utf8"), /gh-cao v1\.2\.3/);
    if (process.platform !== "win32") {
      const registered = await executeFile("gh", ["cao", "version"], {
        cwd: fixture.root,
        env: { ...process.env, XDG_DATA_HOME: fixture.env.XDG_DATA_HOME },
        timeout,
      });
      assert.match(registered.stdout, /gh-cao v1\.2\.3/);
    }
    await assertNothingInstalled(fixture.root);
    await assertNothingInstalled(fixture.consumer);
  });
}

for (const failure of ["FAKE_EXTENSION_FAILURE", "FAKE_EXTENSION_VERIFY_FAILURE", "FAKE_EXTENSION_BAD_CHECKSUM"]) {
  test(`extension-only installation fails closed on ${failure}`, async (t) => {
    const fixture = await createConsumer(t, supportedGhAw);
    const result = await runStreamed(fixture.root, {
      ...fixture.env, XDG_DATA_HOME: path.join(fixture.root, "data"), [failure]: "1",
    }, ["--extension"]);
    assert.notEqual(result.code, 0);
    assert.doesNotMatch(result.stdout, /GitHub CLI extension installed/);
    await assertNothingInstalled(fixture.root);
  });
}

test("checksum failure preserves the previously installed extension", async (t) => {
  const fixture = await createConsumer(t, supportedGhAw);
  const dataHome = path.join(fixture.root, "data");
  const directory = path.join(dataHome, "gh", "extensions", "gh-cao");
  const binary = path.join(directory, process.platform === "win32" ? "gh-cao.exe" : "gh-cao");
  await mkdir(directory, { recursive: true });
  await writeFile(binary, "previous extension");
  const result = await runStreamed(fixture.root, {
    ...fixture.env, XDG_DATA_HOME: dataHome, FAKE_EXTENSION_BAD_CHECKSUM: "1",
  }, ["--extension"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /checksum verification failed/);
  assert.equal(await readFile(binary, "utf8"), "previous extension");
});

for (const args of [
  ["--version", "v1.2.3"],
  ["--extension", "--version"],
  ["--extension", "--version", "../main"],
  ["--extension", "--setup"],
  ["--extension", "--quickstart"],
  ["--extension", "--create-repo", "alpha-org/control"],
  ["--extension", "--target", "alpha-org/target"],
  ["--extension", "githubnext/gh-aw-cao@main"],
]) {
  test(`extension installer rejects invalid arguments: ${args.join(" ")}`, async (t) => {
    const fixture = await createConsumer(t, supportedGhAw);
    const result = await runStreamed(fixture.root, fixture.env, args);
    assert.notEqual(result.code, 0);
    assert.equal(await fixture.log(), "");
    await assertNothingInstalled(fixture.root);
  });
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

test("documented staging preserves the complete curated runtime in a fresh checkout", async (t) => {
  const { root, consumer, repository, env } = await createConsumer(t, supportedGhAw);
  await streamInstaller(consumer, env);
  await executeFile("git", ["init", "--quiet"], { cwd: consumer });
  await executeFile("git", ["add", ".github", "activity", "dashboard", "cao.sh"], { cwd: consumer });
  const { stdout: untracked } = await executeFile("git", ["ls-files", "--others", "--exclude-standard"], { cwd: consumer });
  assert.equal(untracked, "", "the documented commit must include every installed resource");
  await executeFile("git", [
    "-c", "user.name=CAO installation test",
    "-c", "user.email=cao-test@example.invalid",
    "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=/dev/null",
    "commit", "--quiet", "-m", "Install curated CAO runtime",
  ], { cwd: consumer });
  const checkout = path.join(root, "fresh-checkout");
  await executeFile("git", ["clone", "--quiet", "--no-local", consumer, checkout]);
  await assertCompleteInstall(checkout, env, supportedGhAw, repository);
  await executeFile(process.execPath, [
    ".github/workflows/shared/control.mjs", "validate-policy", policyPath,
  ], { cwd: checkout, env, timeout });
  const { stdout: status } = await executeFile("git", ["status", "--porcelain"], { cwd: checkout });
  assert.equal(status, "", "using the installed CLI must not modify the checkout");
});

test("install.sh reports useful progress and does not silence curl", async (t) => {
  const { consumer, env } = await createConsumer(t);
  const result = await streamInstaller(consumer, env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Installing gh-aw ${supportedGhAw.replaceAll(".", "\\.")}`));
  assert.match(result.stdout, /Installs 3 workflows, 5 shared control plane resources, and project settings\./);
  assert.match(result.stdout, /Installing control plane components/);
  assert.match(result.stdout, /A newly published catalog revision may wait for its exact verified runtime build/);
  assert.match(result.stdout, /Verifying exact CAO runtime/);
  assert.doesNotMatch(result.stdout, /Making the CAO launcher executable/);
  assert.match(result.stdout, /Initializing the CAO policy/);
  assert.match(result.stdout, /CAO installed and verified/);
  assert.match(result.stdout, /Next: \.\/cao\.sh setup/);
  assert.doesNotMatch(result.stdout, /Continue to guided setup/);
  assert.doesNotMatch(installerSource, /--silent|curl -s/);
});

test("streamed install.sh scopes policy to gh's current repository, not the ambient GITHUB_REPOSITORY", async (t) => {
  const { consumer, repository, env, log } = await createConsumer(t, supportedGhAw, { repository: "beta-org/ops.tools" });
  await streamInstaller(consumer, { ...env, GITHUB_REPOSITORY: "catalog-org/ambient" });
  assert.equal(await log(), "add\n");
  await assertCompleteInstall(consumer, env, supportedGhAw, repository);
});

test(`streamed install.sh with gh-aw ${olderGhAw} and no terminal fails with upgrade guidance`, async (t) => {
  const { consumer, env, log, installedGhAw } = await createConsumer(t, olderGhAw);
  const result = await runStreamed(consumer, env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, manualUpgrade(supportedGhAw));
  assert.doesNotMatch(result.stdout, /CAO installed and verified/);
  assert.equal(await log(), "");
  assert.equal(await installedGhAw(), `${olderGhAw}\n`);
  await assertNothingInstalled(consumer);
});

test(`streamed install.sh requires the local aw.yml min-version ${manifestGhAw} before adding`, async (t) => {
  const { consumer, env, log, installedGhAw } = await createConsumer(t, supportedGhAw);
  await writeFile(path.join(consumer, "aw.yml"), `min-version: ${manifestGhAw}\n`);
  const result = await runStreamed(consumer, env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, manualUpgrade(manifestGhAw));
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
  const { root, consumer, repository, env, log } = await createConsumer(t, supportedGhAw);
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
  ["runtime provenance verification fails", { FAKE_CAO_ATTESTATION_FAILURE: "1" }, "add\n"],
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
    assert.match(result.stderr, /Open an existing GitHub repository checkout, or rerun with --create-repo OWNER\/NAME/);
    assert.equal(await log(), "");
    await assertNothingInstalled(consumer);
  });
}

test("install.sh creates only an explicitly requested private repository and installs inside its clone", async (t) => {
  const { consumer, env, repository, log } = await createConsumer(t, supportedGhAw);
  const result = await streamInstaller(consumer, env, ["--create-repo", repository]);
  assert.equal(await log(), "create-private\nadd\n");
  assert.match(result.stdout, new RegExp(`Created private control repository ${repository.replace("/", "\\/")}\\.`));
  assert.doesNotMatch(result.stdout, new RegExp(`https://github\\.com/${repository.replace("/", "\\/")}`));
  assert.match(result.stdout, /Open the new checkout: cd control/);
  await assertNothingInstalled(consumer);
  await assertCompleteInstall(path.join(consumer, "control"), env, supportedGhAw, repository);
});

test("install.sh interactively selects an eligible owner and repository name", { skip: process.platform === "win32" }, async (t) => {
  const { consumer, env, repository, log } = await createConsumer(t, supportedGhAw);
  const quoted = `'${installScript.replaceAll("'", "'\\''")}'`;
  const result = await runTerminal("bash", ["-c", `cat ${quoted} | bash -s -- --create-repo`], {
    cwd: consumer,
    env: { ...env, TERM: "xterm-256color", ACCESSIBLE: "", NO_COLOR: "" },
    timeout,
    input: "alpha-org\ncontrol\nn\n",
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Prerequisites and GitHub sign-in verified/);
  assert.match(result.stdout, /Create a private CAO control repository/);
  assert.match(result.stdout, /Repository owner \(OWNER\):/);
  assert.doesNotMatch(result.stdout, /enter select|Owner \[1-/);
  assert.match(result.stdout, /Repository name\s+control/);
  assert.equal(await log(), "owners-query\ncreate-private\nadd\n");
  await assertNothingInstalled(consumer);
  await assertCompleteInstall(path.join(consumer, "control"), env, supportedGhAw, repository);
});

test("install.sh requires typing both owner and repository name without defaults", { skip: process.platform === "win32" }, async (t) => {
  const repository = "alpha-org/control";
  const { consumer, env, log } = await createConsumer(t, supportedGhAw, { repository });
  const quoted = `'${installScript.replaceAll("'", "'\\''")}'`;
  const result = await runTerminal("bash", ["-c", `cat ${quoted} | bash -s -- --create-repo`], {
    cwd: consumer,
    env: { ...env, TERM: "xterm-256color", ACCESSIBLE: "", NO_COLOR: "" },
    timeout,
    input: "\nalpha-org\n\ncontrol\nn\n",
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /blank input does not choose an owner/);
  assert.doesNotMatch(result.stdout, /Repository name\s+cao|Repository name \[/);
  assert.match(result.stdout, /Repository name\s+control/);
  assert.equal(await log(), "owners-query\ncreate-private\nadd\n");
  await assertCompleteInstall(path.join(consumer, "control"), env, supportedGhAw, repository);
});

test("install.sh rejects an ineligible typed owner before accepting an eligible owner", { skip: process.platform === "win32" }, async (t) => {
  const { consumer, env, repository, log } = await createConsumer(t, supportedGhAw);
  const quoted = `'${installScript.replaceAll("'", "'\\''")}'`;
  const result = await runTerminal("bash", ["-c", `cat ${quoted} | bash -s -- --create-repo`], {
    cwd: consumer,
    env: {
      ...env,
      TERM: "xterm-256color",
      ACCESSIBLE: "",
      NO_COLOR: "",
    },
    timeout,
    input: "unknown-owner\nalpha-org\ncontrol\nn\n",
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /Repository name\s+cao/);
  assert.match(result.stdout, /Repository name\s+control/);
  assert.match(result.stdout, /Type an account where you can create repositories/);
  assert.equal(await log(), "owners-query\ncreate-private\nadd\n");
  await assertCompleteInstall(path.join(consumer, "control"), env, supportedGhAw, repository);
});

test("install.sh reports explicit-name availability failures before creating files", { skip: process.platform === "win32" }, async (t) => {
  const { consumer, env, log } = await createConsumer(t, supportedGhAw);
  const quoted = `'${installScript.replaceAll("'", "'\\''")}'`;
  const result = await runTerminal("bash", ["-c", `cat ${quoted} | bash -s -- --create-repo`], {
    cwd: consumer,
    env: {
      ...env,
      TERM: "xterm-256color",
      ACCESSIBLE: "",
      NO_COLOR: "",
      FAKE_REPOSITORY_CHECK_FAILURE: "alpha-org/control",
    },
    timeout,
    input: "alpha-org\ncontrol\n",
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /Unable to check whether alpha-org\/control is available/);
  assert.equal(await log(), "owners-query\n");
  await assertNothingInstalled(consumer);
});

test("install.sh offers to create a private GitHub repository for a checkout without remotes", { skip: process.platform === "win32" }, async (t) => {
  const { consumer, env, repository, log } = await createConsumer(t, supportedGhAw);
  await executeFile("git", ["remote", "remove", "origin"], { cwd: consumer });
  const quoted = `'${installScript.replaceAll("'", "'\\''")}'`;
  const result = await runTerminal("bash", ["-c", `cat ${quoted} | bash`], {
    cwd: consumer,
    env: {
      ...env,
      TERM: "xterm-256color",
      ACCESSIBLE: "",
      NO_COLOR: "",
      FAKE_REPOSITORY_LOOKUP_FAILURE: "1",
    },
    timeout,
    input: "y\nalpha-org\ncontrol\nn\n",
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /No GitHub control repository found/);
  assert.match(result.stdout, /Create a new private GitHub repository for this checkout/);
  assert.match(result.stdout, /Create a private GitHub control repository/);
  assert.equal(await log(), "owners-query\ncreate-private-current\nadd\n");
  await assertCompleteInstall(consumer, env, supportedGhAw, repository);
});

test("install.sh defaults missing-remote repository creation to no", { skip: process.platform === "win32" }, async (t) => {
  const { consumer, env, log } = await createConsumer(t, supportedGhAw);
  await executeFile("git", ["remote", "remove", "origin"], { cwd: consumer });
  const quoted = `'${installScript.replaceAll("'", "'\\''")}'`;
  const result = await runTerminal("bash", ["-c", `cat ${quoted} | bash`], {
    cwd: consumer,
    env: { ...env, FAKE_REPOSITORY_LOOKUP_FAILURE: "1" },
    timeout,
    input: "\n",
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /Repository creation cancelled/);
  assert.equal(await log(), "");
  await assertNothingInstalled(consumer);
});

for (const [environment, message] of [
  [{ FAKE_EXISTING_REPOSITORIES: "alpha-org/control" }, /Repository alpha-org\/control already exists/],
  [{ FAKE_REPOSITORY_CHECK_FAILURE: "alpha-org/control" }, /Unable to check whether alpha-org\/control is available/],
]) {
  test(`install.sh validates the typed remote name before in-place creation: ${message}`, { skip: process.platform === "win32" }, async (t) => {
    const { consumer, env, log } = await createConsumer(t);
    await executeFile("git", ["remote", "remove", "origin"], { cwd: consumer });
    const result = await runTerminal("bash", [installScript], {
      cwd: consumer,
      env: {
        ...env, ...environment, TERM: "", ACCESSIBLE: "1", NO_COLOR: "1",
        FAKE_REPOSITORY_LOOKUP_FAILURE: "1",
      },
      timeout,
      input: "y\nalpha-org\ncontrol\n",
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stdout + result.stderr, message);
    assert.equal(await log(), "owners-query\n");
    assert.equal((await executeFile("git", ["remote"], { cwd: consumer })).stdout, "");
    await assertNothingInstalled(consumer);
  });
}

test("install.sh offers to create and clone from outside a Git checkout", { skip: process.platform === "win32" }, async (t) => {
  const { root, env, repository, log } = await createConsumer(t, supportedGhAw);
  const start = path.join(root, "start");
  await mkdir(start);
  const quoted = `'${installScript.replaceAll("'", "'\\''")}'`;
  const result = await runTerminal("bash", ["-c", `cat ${quoted} | bash`], {
    cwd: start,
    env: { ...env, TERM: "xterm-256color", ACCESSIBLE: "", NO_COLOR: "" },
    timeout,
    input: "y\nalpha-org\ncontrol\nn\n",
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Create and clone a new private control repository/);
  assert.equal(await log(), "owners-query\ncreate-private\nadd\n");
  await assertCompleteInstall(path.join(start, "control"), env, supportedGhAw, repository);
});

test("install.sh requires typed owner and name in accessible mode", { skip: process.platform === "win32" }, async (t) => {
  const { consumer, env, repository, log } = await createConsumer(t, supportedGhAw);
  const quoted = `'${installScript.replaceAll("'", "'\\''")}'`;
  const result = await runTerminal("bash", ["-c", `cat ${quoted} | bash -s -- --create-repo`], {
    cwd: consumer,
    env: { ...env, TERM: "", ACCESSIBLE: "1", NO_COLOR: "1" },
    timeout,
    input: "2\nalpha-org\n\ncontrol\nn\n",
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Repository owner \(OWNER\):/);
  assert.match(result.stdout, /Repository name \(NAME\):/);
  assert.match(result.stdout, /Type an account where you can create repositories/);
  assert.match(result.stdout, /Use a repository name containing/);
  assert.doesNotMatch(result.stdout, /1\) alpha-user|2\) alpha-org|Repository name \[/);
  assert.doesNotMatch(result.stdout, /enter select/);
  assert.equal(await log(), "owners-query\ncreate-private\nadd\n");
  await assertNothingInstalled(consumer);
  await assertCompleteInstall(path.join(consumer, "control"), env, supportedGhAw, repository);
});

test("install.sh checks sign-in before upgrading gh-aw, creating repositories, or writing files", async (t) => {
  const { consumer, env, log } = await createConsumer(t);
  const result = await runStreamed(consumer, { ...env, FAKE_AUTH_FAILURE: "1" }, ["--create-repo", "alpha-org/control"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /gh auth login/);
  assert.equal(await log(), "");
  assert.equal(await exists(path.join(consumer, "control")), false);
  await assertNothingInstalled(consumer);
});

test("install.sh uses one restrained spinner for a slow sign-in check", { skip: process.platform === "win32" }, async (t) => {
  const { consumer, env, log } = await createConsumer(t);
  const quoted = `'${installScript.replaceAll("'", "'\\''")}'`;
  const result = await runTerminal("bash", ["-c", `cat ${quoted} | bash -s -- --create-repo alpha-org/control`], {
    cwd: consumer,
    env: {
      ...env,
      TERM: "xterm-256color",
      ACCESSIBLE: "",
      NO_COLOR: "",
      FAKE_AUTH_DELAY: "0.35",
      FAKE_AUTH_FAILURE: "1",
    },
    timeout,
  });
  assert.notEqual(result.code, 0);
  const frames = [...result.stdout.matchAll(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏][^\r\n]*?· (\d+)s elapsed/gu)];
  assert.ok(frames.length >= 1);
  assert.equal(frames.length, new Set(frames.map((match) => match[1])).size);
  assert.match(result.stdout, /\d+s elapsed/);
  assert.doesNotMatch(result.stdout, /Prerequisites and GitHub sign-in verified/);
  assert.equal(await log(), "");
  await assertNothingInstalled(consumer);
});

test("install.sh disables spinner animation in CI", { skip: process.platform === "win32" }, async (t) => {
  const { consumer, env, log } = await createConsumer(t);
  const quoted = `'${installScript.replaceAll("'", "'\\''")}'`;
  const result = await runTerminal("bash", ["-c", `cat ${quoted} | bash -s -- --create-repo alpha-org/control`], {
    cwd: consumer,
    env: {
      ...env,
      TERM: "xterm-256color",
      ACCESSIBLE: "",
      NO_COLOR: "",
      CI: "1",
      FAKE_AUTH_DELAY: "0.2",
      FAKE_AUTH_FAILURE: "1",
    },
    timeout,
  });
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.stdout, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|\u001b\[/);
  assert.match(result.stdout, /==> Checking tools and GitHub sign-in/);
  assert.equal(await log(), "");
  await assertNothingInstalled(consumer);
});

test("interactive bare installation stops cleanly with an explicit setup next step", { skip: process.platform === "win32" }, async (t) => {
  const { consumer, env, repository, log } = await createConsumer(t, supportedGhAw);
  const quoted = `'${installScript.replaceAll("'", "'\\''")}'`;
  const result = await runTerminal("bash", ["-c", `cat ${quoted} | bash`], {
    cwd: consumer,
    env: { ...env, TERM: "xterm-256color", FORCE_COLOR: "0", CI: "" },
    timeout,
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /Continue to guided setup|Repositories CAO should read/);
  assert.match(result.stdout, /Next: \.\/cao\.sh setup/);
  assert.equal(await log(), "add\n");
  await assertCompleteInstall(consumer, env, supportedGhAw, repository);
});

test(`install.sh rejects GitHub CLI older than ${supportedGh} before sign-in or writes`, async (t) => {
  const { consumer, env, log } = await createConsumer(t);
  const result = await runStreamed(consumer, {
    ...env,
    FAKE_GH_VERSION: olderGh,
    FAKE_AUTH_FAILURE: "1",
  }, ["--create-repo", "alpha-org/control"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, new RegExp(`requires GitHub CLI ${supportedGh.replaceAll(".", "\\.")} or newer`));
  assert.match(result.stderr, new RegExp(`current: ${olderGh.replaceAll(".", "\\.")}`));
  assert.doesNotMatch(result.stderr, /gh auth login/);
  assert.equal(await log(), "");
  assert.equal(await exists(path.join(consumer, "control")), false);
  await assertNothingInstalled(consumer);
});

test("install.sh rejects an unparseable GitHub CLI version before sign-in or writes", async (t) => {
  const { consumer, env, log } = await createConsumer(t);
  const result = await runStreamed(consumer, {
    ...env,
    FAKE_GH_VERSION: "unknown",
    FAKE_AUTH_FAILURE: "1",
  }, ["--create-repo", "alpha-org/control"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, new RegExp(`requires GitHub CLI ${supportedGh.replaceAll(".", "\\.")} or newer`));
  assert.match(result.stderr, /current: unknown/);
  assert.doesNotMatch(result.stderr, /gh auth login/);
  assert.equal(await log(), "");
  assert.equal(await exists(path.join(consumer, "control")), false);
  await assertNothingInstalled(consumer);
});

test("streamed new-repository installation enters bundled setup without consuming script stdin", { skip: process.platform === "win32" }, async (t) => {
  const { consumer, env, repository, log } = await createConsumer(t, supportedGhAw);
  let step = 0;
  const steps = ["Repositories CAO should read", "How should CAO authenticate?", "Apply this setup?"];
  const quoted = `'${installScript.replaceAll("'", "'\\''")}'`;
  const result = await runTerminal("bash", ["-c", `cat ${quoted} | bash -s -- --create-repo ${repository} --setup`], {
    cwd: consumer, env: { ...env, TERM: "xterm-256color", FORCE_COLOR: "0", CI: "" }, timeout,
    onOutput(output, write) {
      if (steps[step] && output.includes(steps[step])) {
        step += 1;
        write("\r");
      }
    },
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(step, 3);
  assert.match(result.stdout, /Setup cancelled/);
  assert.match(result.stdout, /Open the new checkout: cd control/);
  assert.doesNotMatch(result.stdout, /"command": "setup"/);
  assert.equal(await log(), "create-private\nadd\n");
  await assertCompleteInstall(path.join(consumer, "control"), env, supportedGhAw, repository);
});

test("install.sh refuses non-root checkout directories before installing or upgrading anything", async (t) => {
  const { consumer, env, log } = await createConsumer(t);
  const nested = path.join(consumer, "nested");
  await mkdir(nested);
  const result = await runStreamed(nested, env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /root of a GitHub repository checkout/);
  assert.equal(await log(), "");
  await assertNothingInstalled(nested);
});

test("install.sh refuses to create a repository when its clone directory already exists", async (t) => {
  const { consumer, env, log } = await createConsumer(t, supportedGhAw);
  await mkdir(path.join(consumer, "control"));
  const result = await runStreamed(consumer, env, ["--create-repo", "alpha-org/control"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Cannot clone into existing path/);
  assert.equal(await log(), "");
});

test("install.sh refuses an explicit clone path occupied by a dangling symlink", {
  skip: process.platform === "win32",
}, async (t) => {
  const { consumer, env, log } = await createConsumer(t, supportedGhAw);
  const occupied = path.join(consumer, "control");
  await fs.promises.symlink("missing-clone", occupied);
  const result = await runStreamed(consumer, env, ["--quickstart", "--target", "alpha-org/project", "--create-repo", "alpha-org/control"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Cannot clone into existing path/);
  assert.equal(await log(), "");
  assert.equal(await fs.promises.readlink(occupied), "missing-clone");
});

for (const [name, environment, arguments_] of [
  ["bare installation in CI", { CI: "1" }, []],
  ["guided installation without a terminal", { FAKE_CONTROL_VISIBILITY: "PUBLIC" }, ["--setup"]],
  ["guided installation in CI", { CI: "1", FAKE_CONTROL_VISIBILITY: "PUBLIC" }, ["--setup"]],
]) {
  test(`headless install.sh completes safe ${name}`, async (t) => {
    const { consumer, env, log } = await createConsumer(t, supportedGhAw);
    const creating = arguments_.includes("--create-repo");
    const repository = creating ? "alpha-org/new-control" : env.FAKE_CONTROL_REPOSITORY;
    const installEnv = { ...env, ...environment, FAKE_CONTROL_REPOSITORY: repository };
    const result = await streamInstaller(consumer, installEnv, arguments_);
    const setup = arguments_.includes("--setup");
    assert.equal(await log(), `${creating ? "create-private\n" : ""}add\n${setup ? "setup-workflow-token\n" : ""}`);
    assert.match(result.stdout, /CAO installed and verified/);
    if (setup) {
      assert.match(result.stderr, /Non-interactive setup applied/);
      assert.match(result.stderr, /repository GITHUB_TOKEN \(workflow-token\)/);
      assert.doesNotMatch(result.stdout + result.stderr, /Repositories CAO should read|Apply this setup\?/);
    }
    await assertCompleteInstall(
      creating ? path.join(consumer, "new-control") : consumer,
      installEnv,
      supportedGhAw,
      repository,
      { activity: setup },
    );
  });
}

for (const environment of [{}, { CI: "1" }]) {
  test(`headless setup refuses an explicitly created private repository${environment.CI ? " in CI" : ""}`, async (t) => {
    const { consumer, env, log } = await createConsumer(t, supportedGhAw);
    const result = await runStreamed(consumer, {
      ...env,
      ...environment,
      FAKE_CONTROL_REPOSITORY: "alpha-org/new-control",
    }, [
      "--create-repo", "alpha-org/new-control", "--setup",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /requires a public control repository/);
    assert.equal(await log(), "create-private\nadd\n");
  });
}

test("headless guided reinstallation preserves incompatible operator-owned policy", async (t) => {
  const { consumer, env, log } = await createConsumer(t, supportedGhAw);
  await streamInstaller(consumer, env);
  const customPolicy = '{"version":1,"gh-aw-version":"v9.9.9","control-plane":{"campaigns":{"custom":{}}}}\n';
  await writeFile(path.join(consumer, policyPath), customPolicy);
  const result = await runStreamed(consumer, {
    ...env,
    CI: "1",
    FAKE_CONTROL_VISIBILITY: "PUBLIC",
  }, ["--setup"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /requires a bare control plane with no declared campaigns/);
  assert.equal(await readFile(path.join(consumer, policyPath), "utf8"), customPolicy);
  assert.equal(await log(), "add\n");
});

test("headless quickstart selects the current checkout and validates it before mutation", async (t) => {
  const { consumer, env, log } = await createConsumer(t, supportedGhAw);
  await writeFile(path.join(consumer, "README.md"), "existing change\n");
  const result = await runStreamed(consumer, { ...env, CI: "1" }, ["--quickstart", "--target", "alpha-org/project"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /requires a clean control-repository checkout/);
  assert.doesNotMatch(result.stderr, /Interactive repository creation requires a terminal/);
  assert.equal(await log(), "");
  await assertNothingInstalled(consumer);
});

test("implicit quickstart pins the latest stable CAO release", async (t) => {
  const { consumer, env, log } = await createConsumer(t, supportedGhAw);
  const result = await runStreamed(consumer, {
    ...env,
    CI: "1",
    FAKE_ADD_FAILURE: "1",
    FAKE_EXPECT_CAO_SOURCE: "githubnext/gh-aw-cao@v1.2.3",
  }, ["--quickstart", "--target", "alpha-org/project"]);

  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /Quickstart selected stable CAO release v1\.2\.3/);
  assert.equal(await log(), "add\n");
});

test("quickstart skips malformed tags, drafts, and prereleases when selecting a stable release", async (t) => {
  const { consumer, env, log } = await createConsumer(t, supportedGhAw);
  const result = await runStreamed(consumer, {
    ...env,
    CI: "1",
    FAKE_ADD_FAILURE: "1",
    FAKE_EXPECT_CAO_SOURCE: "githubnext/gh-aw-cao@v1.2.3",
    FAKE_CAO_RELEASE_LIST: [
      "false\tfalse\tuntagged-a58de5448231a0eed5d3",
      "true\tfalse\tv1.3.0",
      "false\ttrue\tv1.2.5",
      "false\tfalse\tv1.2.4-rc.1",
      "false\tfalse\tv1.2.3",
      "false\tfalse\tv1.2.2",
    ].join("\n"),
  }, ["--quickstart", "--target", "alpha-org/project"]);

  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /Quickstart selected stable CAO release v1\.2\.3/);
  assert.equal(await log(), "add\n");
});

for (const releases of [
  "",
  "false\tfalse\tuntagged-a58de5448231a0eed5d3",
  "true\tfalse\tv1.3.0\nfalse\ttrue\tv1.2.5",
]) {
  test(`quickstart fails closed without a published stable version tag: ${JSON.stringify(releases)}`, async (t) => {
    const { consumer, env, log } = await createConsumer(t, supportedGhAw);
    const result = await runStreamed(consumer, {
      ...env,
      CI: "1",
      FAKE_CAO_RELEASE_LIST: releases || "\n",
    }, ["--quickstart", "--target", "alpha-org/project"]);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Unable to resolve the latest stable CAO release with a vX\.Y\.Z tag/);
    assert.match(result.stderr, /No CAO files were written/);
    assert.equal(await log(), "");
    await assertNothingInstalled(consumer);
  });
}

test("implicit quickstart refreshes an existing control plane to the stable release", async (t) => {
  const { consumer, env, log } = await createConsumer(t, supportedGhAw);
  await streamInstaller(consumer, env);
  await executeFile("git", ["add", "."], { cwd: consumer });
  await executeFile("git", [
    "-c", "user.name=CAO installation test",
    "-c", "user.email=cao-test@example.invalid",
    "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=/dev/null",
    "commit", "--quiet", "-m", "Install CAO",
  ], { cwd: consumer });

  const result = await runStreamed(consumer, {
    ...env,
    CI: "1",
    FAKE_ADD_FAILURE: "1",
    FAKE_EXPECT_CAO_SOURCE: "githubnext/gh-aw-cao@v1.2.3",
  }, ["--quickstart", "--target", "alpha-org/project"]);

  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /Refreshing control plane components/);
  assert.equal(await log(), "add\nadd-force\n");
});

test("quickstart preserves an explicit main source", async (t) => {
  const { consumer, env, log } = await createConsumer(t, supportedGhAw);
  const result = await runStreamed(consumer, {
    ...env,
    CI: "1",
    FAKE_ADD_FAILURE: "1",
    FAKE_EXPECT_CAO_SOURCE: "githubnext/gh-aw-cao@main",
    FAKE_LATEST_CAO_RELEASE_FAILURE: "1",
  }, ["githubnext/gh-aw-cao@main", "--quickstart", "--target", "alpha-org/project"]);

  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.stdout + result.stderr, /Unable to resolve the latest stable CAO release/);
  assert.equal(await log(), "add\n");
});

test("quickstart fails closed when no stable CAO release can be resolved", async (t) => {
  const { consumer, env, log } = await createConsumer(t, supportedGhAw);
  const result = await runStreamed(consumer, {
    ...env,
    CI: "1",
    FAKE_LATEST_CAO_RELEASE_FAILURE: "1",
  }, ["--quickstart", "--target", "alpha-org/project"]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Unable to resolve the latest stable CAO release/);
  assert.match(result.stderr, /No CAO files were written/);
  assert.equal(await log(), "");
  await assertNothingInstalled(consumer);
});

test("quickstart rejects a prerelease as the implicit stable source", async (t) => {
  const { consumer, env, log } = await createConsumer(t, supportedGhAw);
  const result = await runStreamed(consumer, {
    ...env,
    CI: "1",
    FAKE_LATEST_CAO_RELEASE: "v1.2.3-rc.1",
  }, ["--quickstart", "--target", "alpha-org/project"]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Unable to resolve the latest stable CAO release/);
  assert.equal(await log(), "");
  await assertNothingInstalled(consumer);
});

for (const location of ["outside", "disconnected", "disconnected-with-policy"]) {
  test(`quickstart requires explicit creation: ${location}`, async (t) => {
    const { root, consumer, env, log } = await createConsumer(t, supportedGhAw);
    const inCheckout = location !== "outside";
    const start = inCheckout ? consumer : path.join(root, "outside-checkout");
    if (inCheckout) {
      await executeFile("git", ["remote", "remove", "origin"], { cwd: consumer });
    } else {
      await mkdir(start);
    }
    if (location === "disconnected-with-policy") {
      await mkdir(path.join(consumer, ".github/workflows"), { recursive: true });
      await writeFile(path.join(consumer, policyPath), '{"operator":"preserve"}\n');
    }
    const result = await runStreamed(start, {
      ...env, CI: "1", FAKE_REPOSITORY_LOOKUP_FAILURE: "1",
    }, ["--quickstart", "--target", "alpha-org/project"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /connected GitHub checkout or explicit --create-repo OWNER\/NAME/);
    assert.equal(await log(), "");
    if (location === "disconnected-with-policy") {
      assert.equal(await readFile(path.join(consumer, policyPath), "utf8"), '{"operator":"preserve"}\n');
      assert.equal(await exists(path.join(consumer, "cao.sh")), false);
    } else {
      await assertNothingInstalled(start);
    }
    if (!inCheckout) assert.deepEqual(await fs.promises.readdir(start), []);
  });
}

for (const arguments_ of [
  ["--quickstart"],
  ["--quickstart", "--create-repo", "alpha-org/control"],
  ["--quickstart", "--create-repo"],
]) {
  test(`quickstart requires target before mutation: ${arguments_.join(" ")}`, async (t) => {
    const { consumer, env, log } = await createConsumer(t);
    const result = await runStreamed(consumer, { ...env, FAKE_AUTH_FAILURE: "1" }, arguments_);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--quickstart requires explicit --target OWNER\/REPO/);
    assert.doesNotMatch(result.stderr, /gh auth login|Interactive repository creation/);
    assert.equal(await log(), "");
    await assertNothingInstalled(consumer);
  });
}

for (const [name, environment, message] of [
  ["the selected name is occupied", { FAKE_EXISTING_REPOSITORIES: "alpha-org/control" }, /Repository alpha-org\/control already exists/],
  ["the availability check fails", { FAKE_REPOSITORY_CHECK_FAILURE: "alpha-org/control" }, /Unable to check whether alpha-org\/control is available/],
]) {
  test(`explicit creation fails before mutation when ${name}`, async (t) => {
    const { consumer, env, log } = await createConsumer(t);
    const result = await runStreamed(consumer, {
      ...env, CI: "1", ...environment,
    }, ["--quickstart", "--target", "alpha-org/project", "--create-repo", "alpha-org/control"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, message);
    assert.equal(await log(), "");
    assert.equal(await exists(path.join(consumer, "control")), false);
    await assertNothingInstalled(consumer);
  });
}

test("quickstart explicitly creates the requested private repository outside a checkout", async (t) => {
  const { root, env, log } = await createConsumer(t, supportedGhAw);
  const start = path.join(root, "outside-checkout");
  await mkdir(start);
  const result = await runStreamed(start, {
    ...env, CI: "1", FAKE_ADD_FAILURE: "1",
  }, ["--quickstart", "--target", "alpha-org/project", "--create-repo", "alpha-org/control"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /Created private control repository alpha-org\/control/);
  assert.equal(await log(), "create-private\nadd\n");
  await assertNothingInstalled(start);
});

test("interactive quickstart requires manually typed owner and name for explicit creation", { skip: process.platform === "win32" }, async (t) => {
  const { root, env, log } = await createConsumer(t, supportedGhAw);
  const start = path.join(root, "outside-checkout");
  await mkdir(start);
  const result = await runTerminal("bash", [installScript, "--quickstart", "--target", "alpha-org/project", "--create-repo"], {
    cwd: start,
    env: { ...env, TERM: "xterm-256color", ACCESSIBLE: "", NO_COLOR: "", FAKE_ADD_FAILURE: "1" },
    timeout,
    input: "\nalpha-org\n\ncontrol\n",
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /blank input does not choose an owner/);
  assert.match(result.stdout, /Repository name\s+control/);
  assert.match(result.stdout, /Repo Assist for alpha-org\/project/);
  assert.equal(await log(), "owners-query\ncreate-private\nadd\n");
});

test("quickstart never changes an explicitly requested repository name on collision", async (t) => {
  const { root, env, log } = await createConsumer(t, supportedGhAw);
  const outsideCheckout = path.join(root, "outside-checkout");
  await mkdir(outsideCheckout);
  const result = await runStreamed(outsideCheckout, {
    ...env,
    CI: "1",
    FAKE_CONTROL_REPOSITORY: "alpha-org/control",
    FAKE_CREATE_REPOSITORY_FAILURE: "1",
  }, ["--quickstart", "--target", "alpha-org/project", "--create-repo", "alpha-org/control"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Repository already exists/);
  assert.doesNotMatch(result.stderr, /UTC timestamp|creating a fresh private control repository/);
  assert.equal(await log(), "");
  await assertNothingInstalled(outsideCheckout);
});

test("install.sh in CI applies public defaults without prompting on an available controlling terminal", { skip: process.platform === "win32" }, async (t) => {
  const { consumer, env, log } = await createConsumer(t, supportedGhAw);
  const result = await runTerminal("bash", [installScript, "--setup"], {
    cwd: consumer,
    env: { ...env, CI: "1", FAKE_CONTROL_VISIBILITY: "PUBLIC" },
    timeout,
    input: "",
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Non-interactive setup applied/);
  assert.equal(await log(), "add\nsetup-workflow-token\n");
});

test("install.sh in CI fails an old gh-aw without reading the controlling terminal", { skip: process.platform === "win32" }, async (t) => {
  const { consumer, env, log } = await createConsumer(t, olderGhAw);
  const result = await runTerminal("bash", [installScript], {
    cwd: consumer, env: { ...env, CI: "1" }, timeout, input: "",
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, manualUpgrade(supportedGhAw));
  assert.doesNotMatch(result.stdout, /Upgrade it now/);
  assert.equal(await log(), "");
  await assertNothingInstalled(consumer);
});

for (const arguments_ of [
  ["--create-repo"],
  ["--create-repo", "not-a-coordinate"],
  ["--create-repo", "owner/../escape"],
  ["--unknown"],
  ["--setup", "--quickstart"],
  ["--target", "alpha-org/project"],
  ["--quickstart", "--target", "not-a-coordinate"],
]) {
  test(`install.sh rejects unusable onboarding arguments before mutations: ${arguments_.join(" ")}`, async (t) => {
    const { consumer, env, log } = await createConsumer(t);
    const result = await runStreamed(consumer, env, arguments_);
    assert.notEqual(result.code, 0);
    assert.equal(await log(), "");
    await assertNothingInstalled(consumer);
  });
}

test("streamed install.sh defaults Activity authentication to the control repository workflow token", async (t) => {
  const { root, consumer, repository, env, log } = await createConsumer(t, supportedGhAw);
  await streamInstaller(consumer, env);
  assert.equal(await log(), "add\n");

  const activityEnv = activityEnvironment(root, consumer, env, repository);
  const settings = await resolveActivitySettings(consumer, activityEnv);
  assert.equal(settings.policy_resolution.status, "available", settings.policy_resolution.reason);
  assert.deepEqual(settings.allowed_owners, [repository.split("/")[0]]);
  assert.deepEqual(settings.allowed_repositories, [repository]);
  assert.deepEqual(settings.campaigns, {});
  const authentication = await import(pathToFileURL(path.join(consumer, "activity", "authentication.mjs")).href);
  assert.deepEqual(
    authentication.activityCollectionPlan(settings, { controlRepository: repository }),
    [{
      owner: repository.split("/")[0],
      repositories: [repository],
      credentialRepository: repository,
      artifact: repository.split("/")[0].toLowerCase(),
    }],
  );
  for (const broaderScope of [
    { ...settings, allowed_repositories: [repository, "alpha-org/service"] },
    { ...settings, allowed_repositories: [] },
  ]) {
    assert.throws(
      () => authentication.activityCollectionPlan(broaderScope, { controlRepository: repository }),
      /GITHUB_TOKEN can collect CAO Activity only for the control repository/,
    );
  }
});

test("installed Activity reserves owner-wide discovery for App mode", async (t) => {
  const { root, consumer, repository, env } = await createConsumer(t, supportedGhAw);
  materializeCaoFromSource("root", catalog, consumer);
  for (const { source, destination } of addedFiles) {
    const target = path.join(consumer, destination);
    await mkdir(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(catalog, source), target, { recursive: true });
  }
  await writeFile(path.join(consumer, policyPath), `${JSON.stringify({
    version: 1,
    "gh-aw-version": supportedGhAw,
    "control-plane": { scope: { "allowed-owners": [repository.split("/")[0]] }, campaigns: {} },
  })}\n`);

  const activityEnv = activityEnvironment(root, consumer, env, repository);
  const settings = await resolveActivitySettings(consumer, activityEnv);
  assert.equal(settings.policy_resolution.status, "available", settings.policy_resolution.reason);
  assert.deepEqual(settings.allowed_repositories, []);
  const authentication = await import(pathToFileURL(path.join(consumer, "activity", "authentication.mjs")).href);
  assert.throws(
    () => authentication.activityCollectionPlan(settings, {
      authMode: "pat",
      controlRepository: repository,
      patRepositoryMap: "{}",
    }),
    /PAT-mode CAO Activity requires an exact allowed-repositories scope/,
  );
  assert.deepEqual(
    authentication.activityCollectionPlan(settings, {
      authMode: "app",
      controlRepository: repository,
    }).map(({ owner, repositories }) => ({ owner, repositories })),
    [{ owner: repository.split("/")[0], repositories: [] }],
  );
});
