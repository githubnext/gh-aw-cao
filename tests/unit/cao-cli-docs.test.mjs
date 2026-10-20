import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const docs = readFileSync("docs/cao-cli.md", "utf8");
const help = `${readFileSync("activity/cao.mjs", "utf8")}\n${readFileSync("activity/cli-usage.mjs", "utf8")}`;
const gettingStarted = readFileSync("docs/setup-quickstarts.md", "utf8");
const walkthrough = readFileSync("docs/repo-assist-quickstart.md", "utf8");

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
  assert.match(walkthrough, /monitor existing[\s\S]*?\[Set Up CAO\]\(setup-quickstarts\.md\)/);
  assert.match(docs, /\[Repo Assist walkthrough\]\(repo-assist-quickstart\.md\)/);
});

test("CAO command guide covers the operator-facing command surface", () => {
  for (const command of [
    "init", "setup", "setup auth github-app", "setup auth enterprise-app",
    "setup auth token", "campaigns add OWNER/REPO/CAMPAIGN", "update",
    "upgrade-gh-aw", "campaigns mode preview", "campaigns mode live",
    "campaigns enable", "campaigns disable", "download", "doctor",
    "computation runtime-health", "query", "gh runs", "gh issues", "gh prs",
  ]) {
    assert.match(docs, new RegExp(`gh cao ${command.replaceAll("-", "\\-")}`));
    const legacy = command.replace(/^campaigns /, "").replace(/^setup auth /, "setup-auth ");
    assert.match(help, new RegExp(`cao ${legacy.split(" ")[0]}`));
  }
});

test("Node-only command documentation uses explicit runtime entry points without a shell launcher", () => {
  for (const command of [
    "setup-auth hosted-cli", "doctor", "operational-value", "cluster-problems",
    "dashboard-complexity", "prune-dashboard", "validate --json",
  ]) {
    assert.ok(docs.includes(`node activity/cao.mjs ${command}`), command);
  }
  assert.doesNotMatch(docs, /cao\.sh/);
  assert.match(docs, /gh cao setup --help/);
  const demo = readFileSync("docs/components/TerminalDemo.astro", "utf8");
  assert.match(demo, /gh cao<\/span> setup/);
  assert.match(demo, /gh cao<\/span> doctor/);
  assert.doesNotMatch(demo, /cao\.sh|<\/span> validate/);
});

test("active documentation and architecture do not advertise the retired Quickstart capability", () => {
  for (const filename of [
    "docs/cao-cli.md", "docs/repo-assist-quickstart.md", "docs/glossary.md",
    "docs/authentication.md", "docs/setup-quickstarts.md", "README.md",
    "repo-assist/README.md", "ARCHITECTURE.md", "CODEBASE.yml",
    "specs/repository-layout-and-installation.md", "skills/setup-cao/SKILL.md",
    "skills/setup-cao/references/implementation-details.md",
    "skills/setup-cao/references/non-interactive.md",
    "skills/setup-cao/references/public-control-repositories.md",
  ]) {
    assert.doesNotMatch(
      readFileSync(filename, "utf8"),
      /--quickstart|\b(?:gh cao|node activity\/cao\.mjs) quickstart\b|activity\/quickstart\.mjs|Node-only installer quickstart|control_plane_quickstart|first_success_quickstart/,
      filename,
    );
  }
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

test("campaign guides use supported native campaign installation", () => {
  for (const campaign of ["bug-bash", "repo-assist"]) {
    const guide = readFileSync(`${campaign}/README.md`, "utf8");
    assert.ok(guide.includes(`gh cao campaigns add githubnext/gh-cao/${campaign}`));
    assert.doesNotMatch(guide, /\.\/cao\.sh (?:add|quickstart)\b/);
  }
});

test("manual Repo Assist walkthrough separates installation, execution, and evidence collection", () => {
  const install = walkthrough.indexOf("gh cao campaigns add githubnext/gh-cao/repo-assist");
  const review = walkthrough.indexOf("gh cao campaigns mode preview repo-assist");
  const run = walkthrough.indexOf("gh aw run repo-assist");
  const collect = walkthrough.indexOf("gh workflow run cao-activity.yml");
  assert.ok(install > 0 && review > install && run > review && collect > run);
  const push = walkthrough.indexOf("\ngit push\n");
  const initialPause = walkthrough.indexOf("\ngh workflow disable repo-assist.lock.yml\n");
  const checkpoint = walkthrough.indexOf("Check **CAO validation**");
  const executionStep = walkthrough.indexOf("## 2. Request one maintenance review");
  assert.ok(push > review && initialPause > push && checkpoint > initialPause && executionStep > checkpoint);
  assert.match(walkthrough, /Keep it paused until Step 2/);
  const execution = walkthrough.slice(executionStep);
  assert.ok(execution.indexOf("gh workflow enable") < execution.indexOf("gh aw run"));
  assert.ok(execution.indexOf("gh workflow disable") > execution.indexOf("gh aw run"));
  assert.match(walkthrough, /Installation is not execution/);
  assert.match(walkthrough, /nothing commits, pushes, or dispatches on your behalf/);
  assert.match(walkthrough, /Commit the reviewed workflows and\s+policy together/);
  assert.match(walkthrough, /Check \*\*CAO validation\*\*/);
  assert.match(walkthrough, /control-plane\.campaigns\.repo-assist\.targets/);
  assert.match(walkthrough, /control-plane\.activity\.repositories/);
  assert.match(walkthrough, /enable only maintenance/);
  assert.match(walkthrough, /gh workflow disable repo-assist\.lock\.yml/);
  assert.match(walkthrough, /Pause the orchestrator even if dispatch fails/);
  assert.match(walkthrough, /does not cancel an already requested run/);
  assert.match(walkthrough, /repeating `gh aw run` requests new work/);
  assert.match(walkthrough, /successful Pages deployment job/);
  assert.match(walkthrough, /never applies\s+changes to the target repository/);
  assert.match(walkthrough, /A no-op is a valid result/);
  assert.match(walkthrough, /1,250 AI credits/);
  assert.match(walkthrough, /Use a private control repository for non-public targets or evidence/);
  assert.doesNotMatch(walkthrough, /--step (?:install|run|collect|dashboard)|--wait|--raw-field starter=/);
});

test("Repo Assist walkthrough preserves verified historical examples without dispatching work", () => {
  const campaign = readFileSync("repo-assist/README.md", "utf8");
  const readme = readFileSync("README.md", "utf8");
  const showcase = campaign.slice(campaign.indexOf("## See Repo Assist in action"), campaign.indexOf("## Install"));
  assert.match(walkthrough, /No demo repository is created,\s+and useful findings are not guaranteed/);
  assert.match(walkthrough, /## See more without running more/);
  assert.match(walkthrough, /github\.com\/githubnext\/gh-cao\/blob\/main\/repo-assist\/README\.md#see-repo-assist-in-action/);
  assert.match(readme, /repo-assist\/README\.md#see-repo-assist-in-action/);
  for (const [issue, run] of [
    [17740, 38399472881], [17851, 38493105790],
    [17378, 38119485916], [14060, 36227760220],
  ]) {
    assert.ok(showcase.includes(`https://github.com/githubnext/gh-cao/issues/${issue}`));
    // eslint-disable-next-line cao/no-hardcoded-github-actions-url -- These historical reports belong to github.com.
    assert.ok(showcase.includes(`https://github.com/githubnext/gh-cao/actions/runs/${run}`));
  }
  assert.match(showcase, /Reading these reports does not start a workflow or spend AI credits/);
  assert.match(showcase, /No new patch was made[\s\S]*originating run failed[\s\S]*not a successful repair example/);
  assert.match(showcase, /not proof that a patch was applied, accepted, or merged/);
  assert.match(showcase, /workflow artifacts may expire/);
  assert.doesNotMatch(showcase, /gh aw run|gh workflow enable/);
});
