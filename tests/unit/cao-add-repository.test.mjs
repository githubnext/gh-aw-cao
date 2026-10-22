import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as caoApi from "../../activity/cao.mjs";
import { runAdd } from "../../activity/commands/add.mjs";
import { UsageError } from "../../activity/cli/options.mjs";

const cao = fileURLToPath(new URL("../../activity/cao.mjs", import.meta.url));
const removedArguments = [
  ["--repository", "acme/repo"],
  ["--repository=acme/repo"],
  ["--repository"],
  ["--repository", "acme/repo", "--live"],
  ["catalog/repo/demo", "--repository", "acme/repo"],
  ["catalog/repo/demo", "--repository=acme/repo"],
  ["catalog/repo/demo", "--", "--repository", "acme/repo"],
];

test("Node add preserves campaign installation but rejects repository enrollment before dispatch", () => {
  assert.equal(runAdd({
    arguments_: ["catalog/repo/demo", "--force"],
    addCaoCampaign: (spec, args) => `${spec}:${args}`,
    UsageError,
  }), "catalog/repo/demo:--force");
  for (const arguments_ of removedArguments) {
    assert.throws(() => runAdd({
      arguments_,
      addCaoCampaign: () => assert.fail("removed enrollment must not install a campaign"),
      UsageError,
    }), /Repository enrollment requires gh cao repos add OWNER\/REPO/);
  }
});

test("removed Node enrollment exits clearly without policy writes or campaign installation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cao-removed-enrollment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policyPath = join(root, ".github", "workflows", "cao.json");
  await mkdir(join(root, ".github", "workflows"), { recursive: true });
  const original = '{"version":1}\n';
  await writeFile(policyPath, original);
  for (const arguments_ of removedArguments) {
    assert.throws(() => execFileSync(process.execPath, [cao, "add", ...arguments_], {
      cwd: root, encoding: "utf8", stdio: "pipe",
    }), (error) => {
      assert.equal(error.status, 1);
      assert.equal(error.stdout, "");
      assert.equal(error.stderr, "Error: Repository enrollment requires gh cao repos add OWNER/REPO; Node cao add --repository is no longer supported.\n");
      return true;
    });
    assert.equal(await readFile(policyPath, "utf8"), original);
  }
});

test("Node help and public API no longer expose repository enrollment", async () => {
  assert.doesNotMatch(await caoApi.runCli(["--help"]), /cao add --repository/);
  assert.equal("addCaoRepository" in caoApi, false);
});
