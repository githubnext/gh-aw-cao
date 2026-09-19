import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  echo "gh aw version v0.89.17"
  exit 0
fi
if [[ "\${1:-} \${2:-} \${3:-}" == "aw add githubnext/gh-aw-cao" ]]; then
  echo "add" >> "$FAKE_COMMAND_LOG"
  mkdir -p .github/aw/activity .github/workflows/shared
  touch .github/workflows/shared/control.mjs
  cat > .github/aw/activity/cao.mjs <<'EOF'
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
mkdirSync(".github/workflows", { recursive: true });
writeFileSync(".github/workflows/cao.json", '{"version":1,"gh-aw-version":"v0.89.17","control-plane":{"campaigns":{}}}\\n');
appendFileSync(process.env.FAKE_COMMAND_LOG, "init\\n");
EOF
  exit 0
fi
exit 2
`);
  await writeFile(path.join(bin, "curl"), `#!/usr/bin/env bash
echo "curl" >> "$FAKE_COMMAND_LOG"
printf '%s\\n' '#!/usr/bin/env bash' 'touch "$FAKE_GH_AW_INSTALLED"'
`);
  await chmod(path.join(bin, "gh"), 0o755);
  await chmod(path.join(bin, "curl"), 0o755);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_COMMAND_LOG: log,
    FAKE_GH_AW_INSTALLED: ghAwInstalled,
  };
  try {
    await executeFile("bash", [installScript], { cwd: root, env });
    assert.match(await readFile(path.join(root, ".github", "workflows", "cao.json"), "utf8"), /"campaigns":\{\}/);
    assert.equal(await readFile(log, "utf8"), "curl\nadd\ninit\n");

    await executeFile("bash", [installScript], { cwd: root, env });
    assert.equal(await readFile(log, "utf8"), "curl\nadd\ninit\n");

    await rm(ghAwInstalled);
    await executeFile("bash", [installScript], { cwd: root, env });
    assert.equal(await readFile(log, "utf8"), "curl\nadd\ninit\ncurl\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
