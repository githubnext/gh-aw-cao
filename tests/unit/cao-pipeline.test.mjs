import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { checkPipelineCommand, pipelineCommands, pipelineUsage } from "../../activity/pipeline-cli.mjs";

test("the shell help contains only retained Node tools", () => {
  const help = execFileSync("sh", ["cao.sh", "--help"], { encoding: "utf8" });
  assert.equal(help.trimEnd(), pipelineUsage());
  for (const command of pipelineCommands) assert.ok(help.includes(`./cao.sh ${command}`), command);
  assert.match(help, /setup-auth hosted-cli/);
  assert.doesNotMatch(help, /\.\/cao\.sh (?:init|setup|quickstart|add|update|query|validate|download)(?:\s|$)/);
});

test("migrated operator commands fail without executing or treating arguments as ingestion paths", () => {
  for (const command of [
    "init", "setup", "quickstart", "setup-auth", "add", "update", "upgrade-gh-aw",
    "mode", "enable", "disable", "download", "pages", "queries", "query-info",
    "prompt", "query", "mcp", "gh", "computation", "validate"
  ]) {
    const result = spawnSync("sh", ["cao.sh", command, "example"], { encoding: "utf8" });
    assert.equal(result.status, 1, command);
    assert.equal(result.stdout, "", command);
    assert.match(result.stderr, /use gh cao /, command);
    assert.doesNotMatch(result.stderr, /\n\s+at /, command);
  }
  assert.throws(() => checkPipelineCommand(["add", "--repository"]), /gh cao repos add/);
  assert.throws(() => checkPipelineCommand(["setup-auth", "github-app"]), /gh cao setup auth/);
});

test("pipeline commands preserve the distinct SQLite doctor and hosted App profile", () => {
  for (const command of pipelineCommands) assert.equal(checkPipelineCommand([command]), undefined);
  assert.equal(checkPipelineCommand(["setup-auth", "hosted-cli", "--dry-run"]), undefined);
});
