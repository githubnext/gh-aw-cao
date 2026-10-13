import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const docs = readFileSync("docs/cao-cli.md", "utf8");
const help = `${readFileSync("activity/cao.mjs", "utf8")}\n${readFileSync("activity/cli-usage.mjs", "utf8")}`;
const quickstart = readFileSync("docs/setup-quickstarts.md", "utf8");

test("CAO command guide covers the operator-facing command surface", () => {
  for (const command of [
    "init",
    "setup",
    "quickstart",
    "setup-auth github-app",
    "setup-auth enterprise-app",
    "setup-auth token",
    "add OWNER/REPO/CAMPAIGN",
    "update",
    "upgrade-gh-aw",
    "mode preview",
    "mode live",
    "enable",
    "disable",
    "download",
    "doctor",
    "computation runtime-health",
    "query",
    "gh runs",
    "gh issues",
    "gh prs",
    "operational-value",
    "cluster-problems",
  ]) {
    assert.match(docs, new RegExp(`cao(?:\\.sh)? ${command.replaceAll("-", "\\-")}`));
    assert.match(help, new RegExp(`cao ${command.split(" ")[0]}`));
  }
});

test("CAO command guide explains the workflow execution boundary", () => {
  assert.match(docs, /There is intentionally no `cao run` command/);
  assert.match(docs, /gh-aw owns workflow execution/);
  assert.match(docs, /`cao mode preview` writes `mode: review`/);
  assert.match(docs, /different from `gh aw doctor`/);
});

test("quickstart documents the complete bounded first-success journey", () => {
  const installer = quickstart.indexOf("https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh");
  const command = quickstart.indexOf("bash -s -- --quickstart");
  const campaign = quickstart.indexOf("Install Bug Bash");
  const activity = quickstart.indexOf("Collect a CAO Activity snapshot");
  const dashboard = quickstart.indexOf("Wait for the data-bearing dashboard deployment");

  assert.ok(installer > 0);
  assert.ok(command > installer);
  assert.ok(campaign > command);
  assert.ok(activity > campaign);
  assert.ok(dashboard > activity);
  assert.doesNotMatch(quickstart, /setup-auth (?:workflow-token|github-app|enterprise-app|token)|gh aw run/);
  assert.match(quickstart, /up to \*\*700 AI\s+credits\*\*/);
  assert.match(quickstart, /public GitHub Pages dashboard/);
  assert.match(quickstart, /In a public control repository[\s\S]*review outputs are\s+also public/);
  assert.match(quickstart, /starter target is never modified/);
  assert.match(quickstart, /require at least one collected run/);
  assert.match(quickstart, /There is no second confirmation/);
  assert.match(quickstart, /Installer-created control repositories\s+remain private/);
  assert.match(quickstart, /works without a terminal and when `CI` is set/);
  assert.match(quickstart, /clean public or private\s+control repository on its default branch/);
  assert.match(quickstart, /gh auth status/);
  assert.match(quickstart, /bash -s -- --quickstart --target OWNER\/REPOSITORY/);
  assert.match(quickstart, /Guided setup installs no campaign and runs no workflow; it never commits or\s+pushes/);
  assert.match(quickstart, /Bare installation also stops without a prompt/);
  assert.doesNotMatch(quickstart, /gh repo create acme\//);
});
