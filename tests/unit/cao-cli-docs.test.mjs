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
  const campaign = quickstart.indexOf("Install Repo Assist");
  const activity = quickstart.indexOf("Collect a CAO Activity snapshot");
  const dashboard = quickstart.indexOf("Wait for the data-bearing dashboard deployment");
  const nextStep = quickstart.indexOf("## Next: assist another repository");
  const firstSuccess = quickstart.slice(0, nextStep);

  assert.ok(installer > 0);
  assert.ok(command > installer);
  assert.ok(campaign > command);
  assert.ok(activity > campaign);
  assert.ok(dashboard > activity);
  assert.ok(nextStep > dashboard);
  assert.doesNotMatch(firstSuccess, /setup-auth (?:workflow-token|github-app|enterprise-app|token)|gh aw run/);
  assert.match(quickstart, /up to \*\*1,250 AI\s+credits\*\*/);
  assert.match(quickstart, /public GitHub Pages dashboard/);
  assert.match(quickstart, /resolves the latest stable CAO `vX\.Y\.Z`\s+release/);
  assert.match(quickstart, /never silently falls back to `main`/);
  assert.match(quickstart, /githubnext\/gh-aw-cao@main/);
  assert.match(quickstart, /In a public control repository[\s\S]*review outputs are\s+also public/);
  assert.match(quickstart, /starter target is never modified/);
  assert.match(quickstart, /require at least one collected run/);
  assert.match(quickstart, /There is no second confirmation/);
  assert.match(quickstart, /Installer-created control repositories\s+remain private/);
  assert.match(quickstart, /works without a terminal and when `CI` is set/);
  assert.match(quickstart, /clean public or private\s+control repository on its default branch/);
  assert.match(quickstart, /gh auth status/);
  assert.match(quickstart, /Do not run the installer or `cao add` again/);
  assert.match(quickstart, /control-plane\.scope\.allowed-owners/);
  assert.match(quickstart, /control-plane\.scope\.allowed-repositories/);
  assert.match(quickstart, /control-plane\.campaigns\.repo-assist\.targets/);
  assert.match(quickstart, /gh aw run repo-assist/);
  assert.match(quickstart, /You do not need existing Agentic Workflows, Actions history, or telemetry/);
  assert.match(quickstart, /one concrete, low-risk improvement/);
  assert.match(quickstart, /existing maintenance worker/);
  assert.match(quickstart, /gh workflow disable repo-assist\.lock\.yml/);
  assert.match(quickstart, /gh workflow enable repo-assist\.lock\.yml/);
  assert.match(quickstart, /None of the proposals is a requirement for using CAO/);
  assert.match(quickstart, /There are no readiness grades or required practice checklists/);
  assert.match(quickstart, /repository\s+can stay exactly as it is/);
  assert.match(quickstart, /never applies changes to the target repository/);
  assert.match(quickstart, /review issue and downloadable\s+review bundle/);
  assert.match(quickstart, /A no-op is a valid result/);
  assert.doesNotMatch(quickstart, /--raw-field starter=|maintenance-starter|starter-snapshot/);
  assert.match(quickstart, /Guided setup installs no campaign and runs no workflow; it never commits or\s+pushes/);
  assert.match(quickstart, /Bare installation also stops without a prompt/);
  assert.doesNotMatch(quickstart, /gh repo create acme\//);
});

test("quickstart separates the first run from verified historical Repo Assist examples", () => {
  const campaign = readFileSync("repo-assist/README.md", "utf8");
  const readme = readFileSync("README.md", "utf8");
  const showcase = campaign.slice(campaign.indexOf("## See Repo Assist in action"), campaign.indexOf("## Install"));

  assert.match(campaign, /With no `--target`[\s\S]*github\/gh-aw/);
  assert.match(campaign, /Issue triage, issue fix, and PR upkeep remain disabled/);
  assert.match(quickstart, /No demo repository is created, and useful findings are not guaranteed/);
  assert.match(quickstart, /## See more without running more/);
  assert.match(quickstart, /github\.com\/githubnext\/gh-aw-cao\/blob\/main\/repo-assist\/README\.md#see-repo-assist-in-action/);
  assert.match(readme, /repo-assist\/README\.md#see-repo-assist-in-action/);
  for (const [issue, run] of [
    [17740, 38399472881],
    [17851, 38493105790],
    [17378, 38119485916],
    [14060, 36227760220],
  ]) {
    assert.ok(showcase.includes(`https://github.com/githubnext/gh-aw-cao/issues/${issue}`));
    assert.ok(showcase.includes(`https://github.com/githubnext/gh-aw-cao/actions/runs/${run}`));
  }
  assert.match(showcase, /Reading these reports does not start a workflow or spend AI credits/);
  assert.match(showcase, /No new patch was made[\s\S]*originating run failed[\s\S]*not a successful repair example/);
  assert.match(showcase, /not proof that a patch was applied, accepted, or merged/);
  assert.match(showcase, /workflow artifacts may expire/);
  assert.doesNotMatch(showcase, /gh aw run|gh workflow enable/);
});
