import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const executeFile = promisify(execFile);
const installScript = path.resolve("install.sh");

test("install.sh installs gh-aw, adds the core campaign, and is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-install-"));
  const bin = path.join(root, "bin");
  const log = path.join(root, "commands.log");
  const ghAwInstalled = path.join(root, "gh-aw-installed");
  await mkdir(bin);
  await writeFile(path.join(bin, "gh"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-} \${2:-}" == "aw version" ]]; then
  [[ -f "$FAKE_GH_AW_INSTALLED" ]] || exit 1
  echo "gh aw version $(cat "$FAKE_GH_AW_INSTALLED")"
  exit 0
fi
if [[ "\${1:-} \${2:-}" == "aw add" && "\${3:-}" == githubnext/gh-aw-cao* ]]; then
  if [[ -n "\${FAKE_MANIFEST_MIN_VERSION:-}" && "$(cat "$FAKE_GH_AW_INSTALLED")" != "$FAKE_MANIFEST_MIN_VERSION" ]]; then
    echo "✗ invalid Agentic Workflow manifest \\"aw.yml\\": min-version \\"$FAKE_MANIFEST_MIN_VERSION\\" requires gh-aw $FAKE_MANIFEST_MIN_VERSION or newer (current: $(cat "$FAKE_GH_AW_INSTALLED"))." >&2
    exit 1
  fi
  if [[ "\${4:-}" == "--force" ]]; then
    echo "add-force" >> "$FAKE_COMMAND_LOG"
  else
    echo "add" >> "$FAKE_COMMAND_LOG"
  fi
  mkdir -p activity .github/workflows/shared .github/actions/setup-cao-runtime
  touch .github/workflows/shared/control.mjs
  cat > .github/workflows/shared/materialize-cao.mjs <<'EOF'
// Test fixture: gh aw add already materialized the canonical runtime files.
EOF
  touch .github/actions/setup-cao-runtime/action.yml
  cat > activity/cao.mjs <<'EOF'
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
mkdirSync(".github/workflows", { recursive: true });
writeFileSync(".github/workflows/cao.json", '{"version":1,"gh-aw-version":"v0.89.17","control-plane":{"campaigns":{}}}\\n');
appendFileSync(process.env.FAKE_COMMAND_LOG, "init\\n");
EOF
  cat > cao.sh <<'EOF'
#!/bin/sh
root="$(CDPATH= cd -P "$(dirname "$0")" && pwd)"
exec node "$root/activity/cao.mjs" "$@"
EOF
  exit 0
fi
exit 2
`);
  const fakeCurl = `#!/usr/bin/env bash
echo "curl" >> "$FAKE_COMMAND_LOG"
printf '%s\\n' '#!/usr/bin/env bash' 'printf "%s\\n" "$1" > "$FAKE_GH_AW_INSTALLED"'
`;
  await writeFile(path.join(bin, "curl"), fakeCurl);
  await writeFile(path.join(bin, "curl.exe"), fakeCurl);
  await chmod(path.join(bin, "gh"), 0o755);
  await chmod(path.join(bin, "curl"), 0o755);
  await chmod(path.join(bin, "curl.exe"), 0o755);
  await writeFile(ghAwInstalled, "v0.89.21\n");

  const env = {
    ...process.env,
    PATH: `${bin.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replaceAll("\\", "/")}:${process.env.PATH}`,
    FAKE_COMMAND_LOG: log,
    FAKE_GH_AW_INSTALLED: ghAwInstalled,
  };
  try {
    await executeFile("bash", [installScript], { cwd: root, env });
    assert.match(await readFile(path.join(root, ".github", "workflows", "cao.json"), "utf8"), /"campaigns":\{\}/);
    const installedCommand = path.join(root, "cao.sh");
    if (process.platform !== "win32") assert.notEqual((await stat(installedCommand)).mode & 0o111, 0);
    assert.equal(await readFile(log, "utf8"), "add\ninit\n");

    await chmod(installedCommand, 0o644);
    await executeFile("bash", [installScript], { cwd: root, env });
    if (process.platform !== "win32") assert.notEqual((await stat(installedCommand)).mode & 0o111, 0);
    assert.equal(await readFile(log, "utf8"), "add\ninit\n");

    await executeFile("bash", [installScript, "githubnext/gh-aw-cao@v1.2.3"], { cwd: root, env });
    assert.equal(await readFile(log, "utf8"), "add\ninit\nadd-force\n");

    await writeFile(ghAwInstalled, "v0.90.0\n");
    await executeFile("bash", [installScript], { cwd: root, env });
    assert.equal(await readFile(log, "utf8"), "add\ninit\nadd-force\n");

    if (process.platform !== "win32") {
      await writeFile(ghAwInstalled, "v0.88.0\n");
      const declined = await executeFile("bash", [installScript, "githubnext/gh-aw-cao@v1.2.3"], { cwd: root, env });
      assert.match(declined.stdout, /install-gh-aw\.sh.*v0\.89\.21.*rerun the CAO installer/);
      assert.equal(await readFile(log, "utf8"), "add\ninit\nadd-force\n");

      await rm(ghAwInstalled);
      await executeFile("bash", [installScript], { cwd: root, env });
      assert.equal(await readFile(log, "utf8"), "add\ninit\nadd-force\ncurl\n");
    }
    assert.doesNotMatch(await readFile(installScript, "utf8"), /sort -V/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install.sh offers a manifest-required upgrade before adding the campaign", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-install-upgrade-"));
  const bin = path.join(root, "bin");
  const log = path.join(root, "commands.log");
  const installed = path.join(root, "gh-aw-installed");
  await mkdir(bin);
  await writeFile(installed, "v0.89.22\n");
  await writeFile(path.join(root, "aw.yml"), "min-version: v0.89.22\n");
  await writeFile(path.join(bin, "gh"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-} \${2:-}" == "aw version" ]]; then
  echo "gh aw version $(cat "$FAKE_GH_AW_INSTALLED")"
elif [[ "\${1:-} \${2:-}" == "aw add" ]]; then
  echo add >> "$FAKE_COMMAND_LOG"
  if [[ -n "\${FAKE_ADD_ERROR:-}" ]]; then
    echo "unrelated installation failure" >&2
    exit 1
  fi
  mkdir -p activity .github/workflows/shared .github/actions/setup-cao-runtime
  touch activity/cao.mjs cao.sh .github/workflows/shared/control.mjs .github/workflows/shared/materialize-cao.mjs .github/actions/setup-cao-runtime/action.yml
else
  exit 2
fi
`);
  await writeFile(path.join(bin, "curl"), `#!/usr/bin/env bash
echo curl >> "$FAKE_COMMAND_LOG"
printf '%s\\n' '#!/usr/bin/env bash' 'printf "%s\\n" "$1" > "$FAKE_GH_AW_INSTALLED"'
`);
  await chmod(path.join(bin, "gh"), 0o755);
  await chmod(path.join(bin, "curl"), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_COMMAND_LOG: log,
    FAKE_GH_AW_INSTALLED: installed,
  };
  try {
    await assert.rejects(
      executeFile("bash", [installScript], { cwd: root, env: { ...env, FAKE_ADD_ERROR: "1" } }),
      /unrelated installation failure/,
    );
    await writeFile(installed, "v0.89.21\n");
    const declined = await executeFile("bash", [installScript], { cwd: root, env });
    assert.match(declined.stdout, /install-gh-aw\.sh.*v0\.89\.22.*rerun the CAO installer/);
    assert.equal(await readFile(log, "utf8"), "add\n");
    assert.equal(await readFile(installed, "utf8"), "v0.89.21\n");

    // script supplies a controlling terminal even when the installer is piped into bash.
    const no = await executeFile("bash", ["-c",
      `printf 'n\\n' | script -q -e -c 'cat "${installScript}" | bash' /dev/null`,
    ], { cwd: root, env, timeout: 10_000 });
    assert.match(no.stdout, /install-gh-aw\.sh.*v0\.89\.22.*rerun the CAO installer/);
    assert.equal(await readFile(log, "utf8"), "add\n");

    const { stdout } = await executeFile("bash", ["-c",
      `printf 'y\\n' | script -q -e -c 'cat "${installScript}" | bash' /dev/null`,
    ], { cwd: root, env, timeout: 10_000 });
    assert.match(stdout, /Upgrade it now with curl .*install-gh-aw\.sh.*v0\.89\.22/);
    assert.equal(await readFile(log, "utf8"), "add\ncurl\nadd\n");
    assert.equal(await readFile(installed, "utf8"), "v0.89.22\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
