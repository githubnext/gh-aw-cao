import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { generatedJobs, root, workflow } from "./workflow-contract.helpers.mjs";

// Repository maintenance automation and release workflow contracts.

test("Copilot branch cleaner batches discovery and starts in dry-run mode", () => {
  const source = workflow("copilot-branch-cleaner.yml");

  assert.match(source, /cron: "23 \* \* \* \*"/);
  assert.match(source, /COPILOT_BRANCH_CLEANER_DRY_RUN != 'false'/);
  assert.match(source, /refPrefix = 'refs\/heads\/copilot\/'/);
  assert.match(source, /terminal: associatedPullRequests\([\s\S]*?states: \[MERGED, CLOSED\]/);
  assert.match(source, /open: associatedPullRequests\(first: 1, states: \[OPEN\]\)/);
  assert.match(source, /ref\.open\.totalCount === 0 && ref\.terminal\.totalCount > 0/);
  assert.match(source, /mutation DeleteCopilotBranches/);
  assert.match(source, /updateRefs\(input: \$input\)/);
  assert.match(source, /beforeOid: oid/);
  assert.match(source, /afterOid: zeroOid/);
  assert.match(source, /catch \{[\s\S]*?failed\.push\(\.\.\.batch\)/);
  assert.match(source, /addHeading\('Branches not deleted'\)/);
  assert.doesNotMatch(source, /deleteRef/);
  assert.doesNotMatch(source, /github\.rest|gh api/);
});

test("Actions lint failures create new pull request comments without comment lookup", () => {
  const source = workflow("action-lint.yml");
  const pullRequestReporter = source.slice(source.indexOf("- name: Create pull request comment"));

  assert.match(pullRequestReporter, /needs\.lint\.outputs\.failed == 'true'/);
  assert.match(pullRequestReporter, /github\.rest\.issues\.createComment/);
  assert.doesNotMatch(pullRequestReporter, /listComments|updateComment|deleteComment/);
});

test("Actions lint issue reporter uses GraphQL issue APIs", () => {
  const source = workflow("action-lint.yml");
  const issueReporter = source.slice(
    source.indexOf("- name: Update lint issue"),
    source.indexOf("- name: Create pull request comment"),
  );

  assert.match(issueReporter, /github\.graphql/);
  assert.match(issueReporter, /closeIssue\(input: \$input\)/);
  assert.match(issueReporter, /createIssue\(input: \$input\)/);
  assert.doesNotMatch(issueReporter, /github\.rest\.issues/);
});

test("workflow contracts isolate authenticated package lifecycle checks", () => {
  const packageScripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  const packageLifecycleTest = readFileSync(join(root, "tests", "integration", "package-lifecycle.test.mjs"), "utf8");
  assert.match(packageScripts["test:integration"], /control-failure\.test\.mjs/);
  assert.doesNotMatch(packageScripts["test:integration"], /package-lifecycle/);
  assert.match(packageScripts["test:package-lifecycle"], /package-lifecycle\.test\.mjs/);
  assert.match(packageScripts["test:package-root"], /--test-name-pattern=.\^root package bootstraps/);
  assert.match(packageScripts["test:package-root"], /package-lifecycle\.test\.mjs/);
  assert.doesNotMatch(packageScripts.test, /package-lifecycle/);

  const source = workflow("workflow-contracts.yml");
  const jobs = generatedJobs(source);
  const contracts = jobs.get("test")?.block ?? "";
  const packageLifecycle = jobs.get("package-lifecycle")?.block ?? "";

  assert.match(source, /pull_request:\n    paths-ignore:\n      - \.github\/workflows\/cid\.yml\n      - dashboard\/site\/\*\*/);
  assert.match(source, /push:\n    branches: \[main\]\n    paths-ignore:\n      - \.github\/workflows\/cid\.yml\n      - dashboard\/site\/\*\*/);
  assert.match(contracts, /npm run check/);
  assert.doesNotMatch(contracts, /GH_TOKEN|CENTRAL_AGENTIC_OPS_PACKAGE_SOURCE|test:package-lifecycle/);
  assert.match(packageLifecycle, /gh api rate_limit --jq '\.resources\.core\.remaining'/);
  assert.match(packageLifecycle, /remaining < 500/);
  assert.match(packageLifecycle, /max-parallel: 1/);
  assert.match(packageLifecycle, /if: steps\.package-api\.outputs\.ready == 'true'/);
  assert.match(packageLifecycle, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(
    packageLifecycle,
    /export CENTRAL_AGENTIC_OPS_PACKAGE_SOURCE="\$\{GITHUB_REPOSITORY\}@\$\(git rev-parse --short=12 "\$GITHUB_SHA"\)"/,
  );
  assert.match(packageLifecycle, /npm run test:package-lifecycle/);
  assert.match(packageLifecycle, /grep -Fq "API rate limit exceeded for installation"/);
  assert.match(packageLifecycle, /exit "\$status"/);
  assert.match(packageLifecycleTest, /const packageUpdateSource = "https:\/\/github\.com\/githubnext\/gh-aw-cao"/);
  assert.match(packageLifecycleTest, /"update",\n\s+packageUpdateSource,/);
});

test("release increments the semantic version, prepares a draft, then updates its description", () => {
  const agenticSource = workflow("release.md");
  const source = workflow("release.lock.yml");
  const frontmatter = agenticSource.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
  const config = parse(frontmatter);
  const jobs = generatedJobs(source);
  const version = jobs.get("resolve-version")?.block ?? "";
  const validation = jobs.get("validate-package")?.block ?? "";
  const prepare = jobs.get("prepare-release")?.block ?? "";
  const safeOutputs = jobs.get("safe_outputs")?.block ?? "";
  const compiled = parse(source);
  const rootManifest = readFileSync(join(root, "aw.yml"), "utf8");
  const fetchReleaseContext = compiled.jobs.agent.steps.find((step) => step.name === "Fetch release context");
  const processSafeOutputs = compiled.jobs.safe_outputs.steps.find((step) => step.name === "Process Safe Outputs");

  assert.equal(config.on.workflow_dispatch.inputs.operation, undefined);
  assert.equal(config.on.workflow_dispatch.inputs.bump.required, false);
  assert.equal(config.on.workflow_dispatch.inputs.bump.default, "patch");
  assert.deepEqual(config.on.workflow_dispatch.inputs.bump.options, ["patch", "minor", "major"]);
  assert.match(version, /RELEASE_BUMP: \$\{\{ inputs\.bump \}\}/);
  assert.match(version, /TRIGGERING_ACTOR: \$\{\{ github\.triggering_actor \}\}/);
  assert.match(version, /github-token: \$\{\{ secrets\.GH_AW_GITHUB_TOKEN \|\| github\.token \}\}/);
  assert.match(version, /const bump = \['patch', 'minor', 'major'\]\.includes\(requestedBump\) \? requestedBump : 'patch'/);
  assert.match(version, /Unknown release bump.*defaulting to patch/);
  assert.match(version, /context\.payload\.repository\.fork/);
  assert.match(version, /getCollaboratorPermissionLevel/);
  assert.match(version, /const role = access\.role_name \|\| access\.permission/);
  assert.match(version, /\['maintain', 'admin'\]\.includes\(role\)/);
  assert.match(version, /listReleases/);
  assert.match(version, /listTags/);
  assert.match(version, /\.filter\(\(release\) => release\.prerelease\)/);
  assert.match(version, /const versionNames = new Set\(\[\.\.\.releaseTags, \.\.\.prereleaseTags, \.\.\.tags\.map/);
  assert.match(version, /const versions = \[\.\.\.versionNames\]\.flatMap\(toVersion\)/);
  assert.match(version, /const identifier = String\.raw/);
  assert.match(version, /\(\?:-\$\{identifier\}\(\?:\\\.\$\{identifier\}\)\*\)\?/);
  assert.match(version, /\(\?:\\\+\[0-9A-Za-z-\]\+\(\?:\\\.\[0-9A-Za-z-\]\+\)\*\)\?/);
  assert.match(version, /No semantic version releases or tags found/);
  assert.match(version, /const latest = versions\[0\] \|\| \[0, 0, 0\]/);
  assert.match(version, /if \(bump === 'major'\)/);
  assert.match(version, /else if \(bump === 'minor'\)/);
  assert.match(version, /Resolved \$\{bump\} bump from/);
  assert.match(validation, /CENTRAL_AGENTIC_OPS_PACKAGE_SOURCE: \$\{\{ github\.repository \}\}@\$\{\{ github\.sha \}\}/);
  assert.match(validation, /GH_TOKEN: \$\{\{ secrets\.GH_AW_GITHUB_TOKEN \|\| github\.token \}\}/);
  assert.match(validation, /npm run test:package-root/);
  assert.doesNotMatch(validation, /npm run test:package-lifecycle/);
  assert.match(safeOutputs, /github-token: \$\{\{ secrets\.GH_AW_GITHUB_TOKEN \|\| secrets\.GITHUB_TOKEN \}\}/);
  assert.deepEqual(JSON.parse(processSafeOutputs.env.GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG).update_release, { max: 1 });
  assert.deepEqual(jobs.get("prepare-release")?.needs, ["resolve-version", "validate-package"]);
  assert.match(prepare, /github-token: \$\{\{ secrets\.GH_AW_GITHUB_TOKEN \|\| github\.token \}\}/);
  assert.match(prepare, /git\.createRef/);
  assert.match(prepare, /ref: `refs\/tags\/\$\{releaseTag\}`/);
  assert.match(prepare, /sha: context\.sha/);
  assert.match(prepare, /tag_name: releaseTag/);
  assert.match(prepare, /name: releaseTag/);
  assert.match(prepare, /core\.setOutput\('release_id', release\.id\)/);
  assert.match(prepare, /name: Upload prepared release identity/);
  assert.match(prepare, /name: release-context-\$\{\{ github\.run_id \}\}/);
  assert.match(prepare, /git\.deleteRef/);
  assert.match(prepare, /ref: `tags\/\$\{releaseTag\}`/);
  assert.match(prepare, /throw error/);
  assert.match(prepare, /draft: true/);
  assert.match(prepare, /generate_release_notes: true/);
  assert.match(prepare, /release highlights agent will update this draft/);
  assert.match(prepare, /publish the draft, and mark it as the latest release from the GitHub website/);
  assert.match(prepare, /install or update this package only with gh aw add or gh aw update/);
  assert.equal(jobs.has("publish-release"), false);
  assert.equal(jobs.has("update_release_description"), false);
  assert.deepEqual(Object.keys(config["safe-outputs"]).sort(), ["threat-detection", "update-release"]);
  assert.match(agenticSource, /update-release:/);
  assert.match(agenticSource, /Call `safeoutputs\/update_release` exactly once/);
  assert.match(agenticSource, /`operation`: `prepend`/);
  assert.equal(fetchReleaseContext.env.GH_TOKEN, "${{ secrets.GH_AW_GITHUB_TOKEN || github.token }}");
  assert.match(agenticSource, /releases\/\$RELEASE_ID/);
  assert.match(agenticSource, /gh api --paginate --slurp/);
  assert.match(agenticSource, /Keep the existing GitHub-generated notes intact/);
  assert.equal(config.checkout["fetch-depth"], 0);
  assert.match(agenticSource, /COMMIT_RANGE="refs\/tags\/\$PREVIOUS_TAG\.\.refs\/tags\/\$RELEASE_TAG"/);
  assert.match(agenticSource, /COMMIT_RANGE="refs\/tags\/\$RELEASE_TAG"/);
  assert.match(agenticSource, /git rev-list "\$COMMIT_RANGE"/);
  assert.match(agenticSource, /commits\/\$commit_sha\/pulls\?per_page=100/);
  assert.match(agenticSource, /git diff --name-only --diff-filter=AMR/);
  assert.match(agenticSource, /release_adrs\.md/);
  assert.match(agenticSource, /Review every ADR in `release_adrs\.md`/);
  assert.match(agenticSource, /\[ ! -L "\$adr_path" \]/);
  assert.match(agenticSource, /"\$WORKSPACE_ROOT"\/adr\/\*\.md\|"\$WORKSPACE_ROOT"\/docs\/adr\/\*\.md/);
  assert.match(agenticSource, /\[ ! -L CHANGELOG\.md \]/);
  assert.match(agenticSource, /"\$CHANGELOG_PATH" = "\$WORKSPACE_ROOT\/CHANGELOG\.md"/);
  assert.doesNotMatch(agenticSource, /^evals:/m);
  assert.equal(jobs.has("evals"), false);
  assert.match(version, /needs\.activation\.outputs\.daily_ai_credits_exceeded != 'true'/);
  assert.match(jobs.get("agent")?.needs.join(","), /prepare-release/);
  assert.doesNotMatch(agenticSource, /draft: false|make_latest/);
  assert.doesNotMatch(agenticSource, /release-please/);
  assert.doesNotMatch(rootManifest, /\.github\/workflows\/release\.(?:yml|md)/);
});
