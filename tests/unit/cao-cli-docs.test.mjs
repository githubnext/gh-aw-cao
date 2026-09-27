import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const docs = readFileSync("docs/cao-cli.md", "utf8");
const help = `${readFileSync("activity/cao.mjs", "utf8")}\n${readFileSync("activity/cli-usage.mjs", "utf8")}`;
const quickstart = readFileSync("docs/getting-started.md", "utf8");

test("CAO command guide covers the operator-facing command surface", () => {
  for (const command of [
    "init",
    "setup-auth workflow-token",
    "setup-auth github-app",
    "setup-auth enterprise-app",
    "setup-auth token",
    "add OWNER/REPO/CAMPAIGN",
    "update",
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

test("quickstart leads with the direct setup and authentication commands", () => {
  const installer = quickstart.indexOf("https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh");
  const authentication = quickstart.indexOf("./cao.sh setup-auth workflow-token");
  const campaign = quickstart.indexOf("./cao.sh add githubnext/gh-aw-cao/dependabot");
  const run = quickstart.indexOf("gh aw run dependabot");
  const guidedSetup = quickstart.indexOf("### Prefer Guided Setup?");

  assert.ok(installer > 0);
  assert.ok(authentication > installer);
  assert.ok(campaign > authentication);
  assert.ok(run > campaign);
  assert.ok(guidedSetup > run);
});
