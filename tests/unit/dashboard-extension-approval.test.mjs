import assert from "node:assert/strict";
import test from "node:test";
import { approveDashboardCommand } from "../../com.github.copilot/extensions/cao-dashboard/approval.mjs";

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
