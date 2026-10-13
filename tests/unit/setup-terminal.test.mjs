import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { SetupCancelled } from "../../activity/setup-prompt.mjs";
import { setupCaoControlPlane } from "../../activity/setup.mjs";
import { setupModule, setupTerminalFixture as fixture, walkSetupTerminal as walk } from "../helpers/setup-terminal.mjs";

const terminal = { skip: process.platform === "win32", timeout: 35_000 };

test("setup keyboard walkthrough validates scope, selects with arrows, and applies only after review", terminal, async (t) => {
  const f = fixture(t);
  const result = await walk(f, [
    ["Repositories CAO should read", "not-a-coordinate\r"],
    ["Use owner/repository names", "\u0015acme/service\r"],
    ["How should CAO authenticate?", "\u001b[B\r"],
    ["Apply this setup?", "\u001b[D\r"],
  ]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1 \/ 3  Repositories/);
  assert.match(result.stdout, /Repositories CAO should read \(comma-separated names or \* wildcards\)/);
  assert.match(result.stdout, /2 \/ 3  Connections/);
  assert.match(result.stdout, /3 \/ 3  Review and apply/);
  assert.match(result.stdout, /Configuration saved/);
  assert.match(result.stdout, /"profile":"token"/);
  assert.deepEqual(f.saved()["control-plane"].scope["allowed-repositories"], ["acme/control", "acme/service"]);
  assert.deepEqual(f.calls().at(-1), ["connect", "token"]);
});

test("setup review defaults to No and performs no external mutations", terminal, async (t) => {
  const f = fixture(t);
  const result = await walk(f, [
    ["Repositories CAO should read", "\r"],
    ["How should CAO authenticate?", "\r"],
    ["Apply this setup?", "\r"],
  ]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Setup cancelled/);
  assert.match(result.stdout, /"cancelled":true/);
  assert.deepEqual(f.saved(), f.policy);
  assert.ok(!f.calls().some(([command]) => command === "connect" || command === "api"));
});

test("setup Ctrl-C cancels cleanly without changing policy or credentials", terminal, async (t) => {
  const f = fixture(t);
  const result = await walk(f, [["Repositories CAO should read", "\u0003"]]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Policy, credentials, and Pages settings are unchanged/);
  assert.deepEqual(f.saved(), f.policy);
  assert.ok(!f.calls().some(([command]) => command === "connect" || command === "api"));
});

test("setup plain terminal rejects partial menu numbers and keeps safe defaults", terminal, async (t) => {
  const f = fixture(t);
  const result = await walk(f, [
    ["Repositories CAO should read", "\r"],
    ["Choose [1]:", "1x\r"],
    ["Enter a number from 1 to 2.", "1\r"],
    ["Apply this setup?", "\r"],
  ], "dumb");
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /"cancelled":true/);
  assert.deepEqual(f.saved(), f.policy);
});

for (const [name, environment] of [
  ["ACCESSIBLE", { ACCESSIBLE: "1" }],
  ["NO_COLOR", { NO_COLOR: "1" }],
  ["CI", { CI: "1" }],
]) {
  test(`setup uses plain non-animated prompts when ${name} is set`, terminal, async (t) => {
    const f = fixture(t);
    const result = await walk(f, [
      ["Repositories CAO should read", "\r"],
      ["Choose [1]:", "\r"],
      ["Apply this setup?", "\r"],
    ], "xterm-256color", environment);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /\u001b\[/);
    assert.match(result.stdout, /Set up Central Agentic Ops/);
    assert.match(result.stdout, /"cancelled":true/);
  });
}

for (const [name, settings, answer, expectedCode, expectedDeletion] of [
  ["accepting public visibility", { publicPages: true }, "\u001b[D\r", 0, false],
  ["declining a new public site", { publicPages: true, newPages: true }, "\r", 0, true],
  ["Ctrl-C at new public site consent", { publicPages: true, newPages: true }, "\u0003", 0, true],
  ["declining an existing public site", { publicPages: true }, "\r", 0, false],
  ["declining with failed deletion", { publicPages: true, newPages: true, deletionFails: true }, "\r", 0, true],
]) {
  test(`setup preserves merged Pages consent: ${name}`, terminal, async (t) => {
    const f = fixture(t, setupModule, settings);
    const result = await walk(f, [
      ["Repositories CAO should read", "\r"],
      ["How should CAO authenticate?", "\r"],
      ["Apply this setup?", "\u001b[D\r"],
      ["Is a public dashboard OK?", answer],
    ]);
    assert.equal(result.code, expectedCode, result.stdout + result.stderr);
    assert.match(result.stdout, /Anyone on the internet/);
    assert.match(result.stdout, /private control repository/);
    assert.equal(f.calls().some((args) => args.includes("DELETE")), expectedDeletion);
    assert.ok(!f.calls().some((args) => args.includes("public=false")));
    if (name === "accepting public visibility") {
      assert.match(result.stdout, /"dashboardPages":"public"/);
      assert.deepEqual(f.calls().at(-1), ["connect", "github-app"]);
    } else {
      assert.match(result.stdout, /"reason":"public-pages-declined"/);
      assert.deepEqual(f.saved(), f.policy);
      assert.ok(!f.calls().some(([command]) => command === "connect"));
      if (settings.deletionFails) assert.match(result.stdout, /Could not remove the Pages site/);
      else if (settings.newPages) assert.match(result.stdout, /Removed the Pages site/);
      else assert.match(result.stdout, /Left the existing Pages site in place/);
    }
  });
}

test("setup credential failures disclose partial effects and preserve local policy", terminal, async (t) => {
  const f = fixture(t, setupModule, { credentialsFail: true });
  const result = await walk(f, [
    ["Repositories CAO should read", "\r"],
    ["How should CAO authenticate?", "\r"],
    ["Apply this setup?", "\u001b[D\r"],
  ]);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Setup stopped during credentials; the local policy was not changed/);
  assert.match(result.stdout, /may already have changed/);
  assert.deepEqual(f.saved(), f.policy);
});

test("setup without a terminal fails with guidance before any GitHub command", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [f.driver], { cwd: f.root, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires an interactive terminal/);
  assert.deepEqual(f.calls(), []);
  assert.deepEqual(f.saved(), f.policy);
});

for (const stage of ["text", "select", "confirm"]) {
  test(`setup cancellation during ${stage} leaves policy and external settings unchanged`, async (t) => {
    const f = fixture(t);
    const result = await setupCaoControlPlane({
      policyPath: f.policyPath,
      execute: (_, args) => ({ status: 0, stdout: args.includes("--jq")
        ? "acme/control" : '{"nameWithOwner":"acme/control","visibility":"PRIVATE"}' }),
      prompt: {
        note() {},
        text: async () => { if (stage === "text") throw new SetupCancelled(); return ""; },
        select: async () => { if (stage === "select") throw new SetupCancelled(); return "github-app"; },
        confirm: async () => { throw new SetupCancelled(); },
      },
      setupAuthentication: () => assert.fail("cancelled setup cannot configure credentials"),
    });
    assert.deepEqual(result, { command: "setup", cancelled: true });
    assert.deepEqual(f.saved(), f.policy);
  });
}
