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

test("quickstart uses the interactive setup command and stops before campaigns", () => {
  const installer = quickstart.indexOf("https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh");
  const setup = quickstart.indexOf("./cao.sh setup");
  const validation = quickstart.indexOf("./cao.sh validate");
  const review = quickstart.indexOf("git diff --check");

  assert.ok(installer > 0);
  assert.ok(setup > installer);
  assert.ok(validation > setup);
  assert.ok(review > setup);
  assert.doesNotMatch(quickstart, /setup-auth (?:workflow-token|github-app|enterprise-app|token)|gh aw run/);
  assert.match(quickstart, /installs no campaign and runs no workflow/);
  assert.match(quickstart, /gh auth status/);
  assert.match(quickstart, /stage only the setup files you\s+reviewed/);
  assert.match(quickstart, /Adding a campaign installs its\s+workflows but does not run them/);
  assert.match(quickstart, /gh repo create OWNER\/CONTROL_REPOSITORY --private --clone/);
  assert.match(quickstart, /\.\/cao\.sh add githubnext\/gh-aw-cao\/CAMPAIGN/);
  assert.doesNotMatch(quickstart, /gh repo create acme\//);
});
