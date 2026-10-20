import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const docs = readFileSync("docs/cao-cli.md", "utf8");
const help = `${readFileSync("activity/cao.mjs", "utf8")}\n${readFileSync("activity/cli-usage.mjs", "utf8")}`;
const gettingStarted = readFileSync("docs/setup-quickstarts.md", "utf8");
const quickstart = readFileSync("docs/repo-assist-quickstart.md", "utf8");

test("getting started reaches monitoring before optional campaign execution", () => {
  const optional = gettingStarted.indexOf("## Optional: add automation later");
  assert.ok(optional > 0);
  const monitoring = gettingStarted.slice(0, optional);
  const commands = [
    "curl -fsSL https://raw.githubusercontent.com/githubnext/gh-cao/main/install.sh | bash",
    "gh cao setup",
    "gh cao doctor",
    'git commit -m "Set up CAO monitoring"',
    "git push",
    "gh workflow run cao-activity.yml",
  ];
  let previous = -1;
  for (const command of commands) {
    const index = monitoring.indexOf(command);
    assert.ok(index > previous, `${command} should follow the preceding stage`);
    previous = index;
  }
  assert.deepEqual([...monitoring.matchAll(/^## \d\. (.+)$/gm)].map((match) => match[1]), [
    "Install CAO",
    "Connect one repository",
    "Publish your configuration",
    "Open your dashboard",
  ]);
  assert.ok(gettingStarted.trim().split(/\s+/).length < 1000, "first-run guide should stay concise");
  assert.doesNotMatch(monitoring, /--quickstart|gh aw run|cao\.sh (?:add|enable|quickstart)|AI credits/);
  assert.match(monitoring, /setup installs no campaign and runs no workflow/i);
  assert.match(monitoring, /does not commit or push/);
  assert.match(monitoring, /Check \*\*CAO validation\*\* in Actions/);
  assert.match(monitoring, /control-plane\.campaigns` is `\{\}`/);
  assert.match(monitoring, /empty dashboard is expected/);
  assert.match(monitoring, /not every ordinary Actions job/);
  assert.match(monitoring, /does\s+\*\*not\*\*\s+guarantee a\s+private Pages site/);
  assert.match(monitoring, /including its Pages deployment/);
  assert.match(monitoring, /headless setup only\s+supports the exact current public control repository/);
  assert.match(gettingStarted.slice(optional), /repo-assist-quickstart\.md/);
  assert.match(gettingStarted.slice(optional), /Installation is not execution/);
  assert.match(gettingStarted.slice(optional), /\*\*review\*\* mode with \*\*one\s+repository\*\*/);
  assert.match(quickstart, /monitor existing[\s\S]*?\[Set Up CAO\]\(setup-quickstarts\.md\)/);
  assert.match(docs, /\[Repo Assist walkthrough\]\(repo-assist-quickstart\.md\)/);
});

test("CAO command guide covers the operator-facing command surface", () => {
  for (const command of [
    "init",
    "setup",
    "quickstart",
    "setup auth github-app",
    "setup auth enterprise-app",
    "setup auth token",
    "campaigns add OWNER/REPO/CAMPAIGN",
    "update",
    "upgrade-gh-aw",
    "campaigns mode preview",
    "campaigns mode live",
    "campaigns enable",
    "campaigns disable",
    "download",
    "doctor",
    "computation runtime-health",
    "query",
    "gh runs",
    "gh issues",
    "gh prs",
  ]) {
    assert.match(docs, new RegExp(`gh cao ${command.replaceAll("-", "\\-")}`));
    const legacy = command.replace(/^campaigns /, "").replace(/^setup auth /, "setup-auth ");
    assert.match(help, new RegExp(`cao ${legacy.split(" ")[0]}`));
  }
});

test("Node-only command documentation uses explicit runtime entry points without a shell launcher", () => {
  for (const command of [
    "setup-auth hosted-cli",
    "doctor",
    "operational-value",
    "cluster-problems",
    "dashboard-complexity",
    "prune-dashboard",
    "validate --json",
  ]) {
    assert.ok(docs.includes(`node activity/cao.mjs ${command}`), command);
  }
  assert.doesNotMatch(docs, /cao\.sh/);
  const demo = readFileSync("docs/components/TerminalDemo.astro", "utf8");
  assert.match(demo, /gh cao<\/span> setup/);
  assert.match(demo, /data-terminal-output="setup">Next: gh cao doctor/);
  assert.doesNotMatch(demo, /cao\.sh|<\/span> validate/);
});

test("CAO command guide explains the workflow execution boundary", () => {
  assert.match(docs, /There is intentionally no `cao run` command/);
  assert.match(docs, /gh-aw owns workflow execution/);
  assert.match(docs, /`gh cao campaigns mode preview` writes `mode: review`/);
  assert.match(docs, /different from `gh aw doctor`/);
  assert.match(docs, /Control-plane validation is Actions-only/);
  assert.match(docs, /node activity\/cao\.mjs validate --json/);
  assert.doesNotMatch(docs, /gh cao validate/);
});

test("campaign guides use supported native operator commands", () => {
  for (const [filename, commands] of [
    ["bug-bash/README.md", ["gh cao campaigns add githubnext/gh-cao/bug-bash"]],
    ["repo-assist/README.md", [
      "gh cao quickstart --step run",
      "gh cao quickstart --step collect",
      "gh cao quickstart --step dashboard",
    ]],
  ]) {
    const guide = readFileSync(filename, "utf8");
    for (const command of commands) assert.ok(guide.includes(command), `${filename} must document ${command}`);
    assert.doesNotMatch(guide, /\.\/cao\.sh (?:add|quickstart)\b/);
  }
});

test("quickstart documents separate component stages and explicit checkpoints", () => {
  const installer = quickstart.indexOf("https://raw.githubusercontent.com/githubnext/gh-cao/main/install.sh");
  const command = quickstart.indexOf("bash -s -- --quickstart");
  const campaign = quickstart.indexOf("gh cao quickstart --step run");
  const activity = quickstart.indexOf("gh cao quickstart --step collect");
  const dashboard = quickstart.indexOf("gh cao quickstart --step dashboard");
  const nextStep = quickstart.indexOf("## Next: assist another repository");
  const firstSuccess = quickstart.slice(0, nextStep);

  assert.ok(installer > 0);
  assert.ok(command > installer);
  assert.ok(campaign > command);
  assert.ok(activity > campaign);
  assert.ok(dashboard > activity);
  assert.ok(nextStep > dashboard);
  assert.match(firstSuccess, /does \*\*not\*\* dispatch Repo Assist or Activity, or wait for remote jobs/);
  assert.match(firstSuccess, /## 2\. Install and understand the control plane/);
  assert.match(firstSuccess, /## 3\. Run one Repo Assist review/);
  assert.match(firstSuccess, /## 4\. Collect a CAO Activity snapshot/);
  assert.match(firstSuccess, /## 5\. Check and explore your dashboard/);
  assert.equal((firstSuccess.match(/\*\*Checkpoint:\*\*/g) || []).length, 4);
  assert.match(firstSuccess, /Do not repeat `--step run` just to check progress/);
  assert.match(firstSuccess, /Do not repeat `--step collect` as a status check/);
  assert.match(firstSuccess, /read-only step/);
  assert.match(firstSuccess, /normal push and scheduled\s+triggers/);
  assert.match(firstSuccess, /successful Pages deployment job, not merely a successful build/);
  assert.match(firstSuccess, /gh cao quickstart --wait/);
  assert.match(firstSuccess, /Do not use it to resume a staged installation/);
  assert.match(firstSuccess, /five numbered sections \*\*before each\s+corresponding change\*\*/);
  assert.match(firstSuccess, /stay in terminal scrollback/);
  assert.match(firstSuccess, /numbered `guide` details and its `checkpoint`/);
  assert.match(docs, /\*\*Before continuing\*\* inspection checkpoint/);
  assert.doesNotMatch(firstSuccess, /setup-auth (?:workflow-token|github-app|enterprise-app|token)|gh aw run/);
  assert.match(quickstart, /up to \*\*1,250 AI\s+credits\*\*/);
  assert.match(quickstart, /public GitHub Pages dashboard/);
  assert.match(quickstart, /resolves the latest published CAO `vX\.Y\.Z`\s+release, including prereleases but excluding drafts/);
  assert.match(quickstart, /never silently falls back to `main`/);
  assert.match(quickstart, /githubnext\/gh-cao@main/);
  assert.match(quickstart, /In a public control repository[\s\S]*review outputs are\s+also public/);
  assert.match(quickstart, /selected target is never modified/);
  assert.match(quickstart, /require at least one collected run/);
  assert.match(quickstart, /There is no second confirmation/);
  assert.match(quickstart, /Installer-created control repositories\s+remain private/);
  assert.match(quickstart, /Neither prompt has a default/);
  assert.match(quickstart, /Existing repositories and local files are never reused or overwritten/);
  assert.match(quickstart, /An explicit name is never silently changed/);
  assert.match(quickstart, /Missing `--target` stops before installation or repository creation/);
  assert.doesNotMatch(firstSuccess, /github\/gh-aw|USERNAME\/cao|timestamped/);
  assert.match(firstSuccess, /--create-repo CONTROL_OWNER\/CONTROL_REPOSITORY/);
  assert.match(firstSuccess, /--target TARGET_OWNER\/TARGET_REPOSITORY/);
  assert.match(quickstart, /works without a terminal and when `CI` is set/);
  assert.match(quickstart, /clean public or private\s+control repository on its default branch/);
  assert.match(quickstart, /gh auth status/);
  assert.match(quickstart, /Do not run the installer or `gh cao campaigns add` again/);
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

  assert.match(campaign, /requires `--target OWNER\/REPOSITORY`/);
  assert.match(campaign, /Issue triage, issue fix, and PR upkeep remain disabled/);
  assert.match(quickstart, /No demo repository is created, and useful findings are not guaranteed/);
  assert.match(quickstart, /## See more without running more/);
  assert.match(quickstart, /github\.com\/githubnext\/gh-cao\/blob\/main\/repo-assist\/README\.md#see-repo-assist-in-action/);
  assert.match(readme, /repo-assist\/README\.md#see-repo-assist-in-action/);
  for (const [issue, run] of [
    [17740, 38399472881],
    [17851, 38493105790],
    [17378, 38119485916],
    [14060, 36227760220],
  ]) {
    assert.ok(showcase.includes(`https://github.com/githubnext/gh-cao/issues/${issue}`));
    assert.ok(showcase.includes(`https://github.com/githubnext/gh-cao/actions/runs/${run}`));
  }
  assert.match(showcase, /Reading these reports does not start a workflow or spend AI credits/);
  assert.match(showcase, /No new patch was made[\s\S]*originating run failed[\s\S]*not a successful repair example/);
  assert.match(showcase, /not proof that a patch was applied, accepted, or merged/);
  assert.match(showcase, /workflow artifacts may expire/);
  assert.doesNotMatch(showcase, /gh aw run|gh workflow enable/);
});
