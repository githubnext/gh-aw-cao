import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { addCaoRepository } from "../../activity/cli/repositories.mjs";
import { runAdd } from "../../activity/commands/add.mjs";
import { UsageError } from "../../activity/cli/options.mjs";
import { minimalPolicy } from "../../activity/cli/policy.mjs";

async function fixture(run, modify = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "cao-enrollment-"));
  const policyPath = join(root, "cao.json");
  const policy = minimalPolicy("v0.91.5", "acme/control");
  policy["control-plane"].defaults = { mode: "live", "max-repositories": 3 };
  policy["control-plane"].campaigns = {
    demo: { enabled: false, mode: "live", targets: { "acme/control": { mode: "live" } }, workers: { worker: { workflow: "demo-worker", "max-mode": "live" } } },
  };
  modify(policy);
  await writeFile(policyPath, JSON.stringify(policy));
  const execute = (command, args) => {
    assert.equal(command, "gh");
    assert.deepEqual(args, ["repo", "view", "elsewhere/new", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
    return { status: 0, stdout: "elsewhere/new\n" };
  };
  try { await run({ policyPath, policy, execute }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("repository enrollment adds only one exact target and caps existing live campaigns at review", async () => {
  await fixture(async ({ policyPath, policy, execute }) => {
    const result = await addCaoRepository("elsewhere/new", { policyPath, execute });
    assert.equal(result.alreadyEnrolled, false);
    const saved = JSON.parse(await readFile(policyPath, "utf8"));
    const control = saved["control-plane"];
    assert.deepEqual(control.scope, { "allowed-owners": ["acme", "elsewhere"], "allowed-repositories": ["acme/control", "elsewhere/new"] });
    assert.deepEqual(control.defaults, policy["control-plane"].defaults);
    assert.equal(control.campaigns.demo.enabled, false);
    assert.equal(control.campaigns.demo.mode, "live");
    assert.deepEqual(control.campaigns.demo.workers, policy["control-plane"].campaigns.demo.workers);
    assert.deepEqual(control.campaigns.demo.targets, { "acme/control": { mode: "live" }, "elsewhere/new": { mode: "review" } });
    const first = await readFile(policyPath, "utf8");
    assert.equal((await addCaoRepository("elsewhere/new", { policyPath, execute })).alreadyEnrolled, true);
    assert.equal(await readFile(policyPath, "utf8"), first);
  });
});

test("enrollment preserves explicitly narrowed Activity scope", async () => {
  await fixture(async ({ policyPath, execute }) => {
    await addCaoRepository("elsewhere/new", { policyPath, execute });
    assert.deepEqual(JSON.parse(await readFile(policyPath, "utf8"))["control-plane"].activity, { repositories: ["acme/control"] });
  }, (policy) => { policy["control-plane"].activity = { repositories: ["acme/control"] }; });
});

test("broad discovery, invalid identity, missing access, and redirected repository lookups fail without policy writes", async () => {
  await fixture(async ({ policyPath, execute }) => {
    const original = await readFile(policyPath, "utf8");
    for (const repository of ["--help", "owner/*", "acme/repo;echo", "acme/repo\n"]) {
      await assert.rejects(addCaoRepository(repository, { policyPath, execute }), /exact OWNER/);
    }
    await assert.rejects(addCaoRepository("elsewhere/new", { policyPath, execute: () => ({ status: 1, stderr: "not found" }) }), /access could not be verified/);
    await assert.rejects(addCaoRepository("elsewhere/new", { policyPath, execute: () => ({ status: 0, stdout: "elsewhere/other" }) }), /exact requested/);
    assert.equal(await readFile(policyPath, "utf8"), original);
  });
  await fixture(async ({ policyPath, execute }) => {
    const original = await readFile(policyPath, "utf8");
    await assert.rejects(addCaoRepository("elsewhere/new", { policyPath, execute }), /explicit allowed-owners/);
    assert.equal(await readFile(policyPath, "utf8"), original);
  }, (policy) => { delete policy["control-plane"].scope["allowed-repositories"]; });
});

test("add dispatch preserves campaign syntax and rejects extra repository options", () => {
  assert.equal(runAdd({ arguments_: ["catalog/repo/demo", "--force"], addCaoCampaign: (spec, args) => `${spec}:${args}`, UsageError }), "catalog/repo/demo:--force");
  assert.equal(runAdd({ arguments_: ["--repository", "acme/repo"], addCaoRepository: (repo) => repo, UsageError }), "acme/repo");
  assert.throws(() => runAdd({ arguments_: ["--repository", "acme/repo", "--live"], UsageError }), /exactly one/);
});
