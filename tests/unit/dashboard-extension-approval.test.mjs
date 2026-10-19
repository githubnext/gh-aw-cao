import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { approveDashboardCommand } from "../../com.github.copilot/extensions/cao-dashboard/approval.mjs";
import { executeDashboardCommand } from "../../com.github.copilot/extensions/cao-dashboard/operator.mjs";

test("canvas-approved commands need no host session or second confirmation", async () => {
  const request = {
    command: "gh agent-task create --from-file -",
    workingDirectory: "/workspace",
    input: "User input\nincluding \"quotes\" and controls\u0001",
  };
  assert.equal(await approveDashboardCommand(Object.freeze(request)), true);
  assert.equal(await approveDashboardCommand({
    command: "gh aw upgrade --repo github/gh-aw-mcp --create-pull-request",
    workingDirectory: "/workspace",
  }), true);
});

test("canvas command approval still rejects unsupported and malformed commands", async () => {
  for (const command of ["node attacker.mjs", "gh aw compile\necho unexpected", 'gh aw compile "']) {
    await assert.rejects(approveDashboardCommand({
      command,
      workingDirectory: "/workspace",
    }));
  }
});

test("native action transport confines an explicit credential to the child environment", {
  skip: process.platform === "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "cao-native-transport-"));
  const previousExecutable = process.env.CAO_EXECUTABLE;
  const previousToken = process.env.GH_TOKEN;
  try {
    const executable = join(directory, "native-transport-fixture.cjs");
    await writeFile(executable, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:"complete",result:{
  ok:process.env.GH_TOKEN==="child-fixture"&&process.env.GITHUB_TOKEN==="child-fixture"
}})+"\\n");
`, { mode: 0o600 });
    await chmod(executable, 0o700);
    process.env.CAO_EXECUTABLE = executable;
    process.env.GH_TOKEN = "parent-fixture";
    assert.deepEqual(await executeDashboardCommand({
      command: "gh aw status", workingDirectory: directory, githubToken: "child-fixture",
    }), { ok: true });
    assert.equal(process.env.GH_TOKEN, "parent-fixture");
  } finally {
    if (previousExecutable === undefined) delete process.env.CAO_EXECUTABLE;
    else process.env.CAO_EXECUTABLE = previousExecutable;
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
    await rm(directory, { recursive: true, force: true });
  }
});
