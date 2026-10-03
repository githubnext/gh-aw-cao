import assert from "node:assert/strict";
import test from "node:test";
import { approveDashboardCommand } from "../../com.github.copilot/extensions/cao-dashboard/approval.mjs";

test("native approval shows the exact immutable execution context", async () => {
  const messages = [];
  const session = {
    capabilities: { ui: { elicitation: true } },
    ui: { confirm: async (message) => { messages.push(message); return true; } },
  };
  const request = {
    command: "gh agent-task create --from-file -",
    workingDirectory: "/workspace",
    input: "User input\nincluding \"quotes\" and controls\u0001",
  };
  assert.equal(await approveDashboardCommand(session, request), true);
  assert.match(messages[0], /this invocation only/);
  for (const value of Object.values(request)) assert.ok(messages[0].includes(JSON.stringify(value)));
  await approveDashboardCommand(session, request);
  assert.equal(messages.length, 2);
});

test("native approval honors decline and fails closed on unsupported hosts", async () => {
  const request = { command: "gh aw compile", workingDirectory: "/workspace" };
  const session = { capabilities: { ui: { elicitation: true } }, ui: { confirm: async () => false } };
  assert.equal(await approveDashboardCommand(session, request), false);
  await assert.rejects(approveDashboardCommand(undefined, request), /does not support trusted CLI action approval/);
  await assert.rejects(approveDashboardCommand({ capabilities: {}, ui: session.ui }, request), /does not support trusted CLI action approval/);
});

test("invalid commands do not reach the trusted confirmation surface", async () => {
  let confirmations = 0;
  const session = {
    capabilities: { ui: { elicitation: true } },
    ui: { confirm: async () => { confirmations += 1; return true; } },
  };
  await assert.rejects(approveDashboardCommand(session, {
    command: "node attacker.mjs",
    workingDirectory: "/workspace",
  }), /must be an explicit/);
  assert.equal(confirmations, 0);
});
