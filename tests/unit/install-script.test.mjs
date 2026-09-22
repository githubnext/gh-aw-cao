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
printf '%s\\n' '#!/usr/bin/env bash' 'printf "v0.89.17\\n" > "$FAKE_GH_AW_INSTALLED"'
`;
  await writeFile(path.join(bin, "curl"), fakeCurl);
  await writeFile(path.join(bin, "curl.exe"), fakeCurl);
  await chmod(path.join(bin, "gh"), 0o755);
  await chmod(path.join(bin, "curl"), 0o755);
  await chmod(path.join(bin, "curl.exe"), 0o755);
  await writeFile(ghAwInstalled, "v0.89.17\n");

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
      await executeFile("bash", [installScript], { cwd: root, env });
      assert.equal(await readFile(log, "utf8"), "add\ninit\nadd-force\ncurl\n");

      await rm(ghAwInstalled);
      await executeFile("bash", [installScript], { cwd: root, env });
      assert.equal(await readFile(log, "utf8"), "add\ninit\nadd-force\ncurl\ncurl\n");
    }
    assert.doesNotMatch(await readFile(installScript, "utf8"), /sort -V/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
