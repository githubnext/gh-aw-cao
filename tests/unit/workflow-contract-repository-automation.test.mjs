import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { generatedJobs, root, workflow } from "./workflow-contract.helpers.mjs";

// Repository maintenance automation and release workflow contracts.

test("Copilot branch cleaner limits weekly discovery and starts in dry-run mode", () => {
  const source = workflow("copilot-branch-cleaner.yml");
  const cleanerStart = source.indexOf("const dryRun");
  assert.ok(cleanerStart >= 0);
  const cleaner = source.slice(cleanerStart);

  assert.match(source, /cron: "23 3 \* \* 1"/);
  assert.match(source, /COPILOT_BRANCH_CLEANER_DRY_RUN != 'false'/);
  assert.match(source, /refPrefix = 'refs\/heads\/'/);
  assert.match(source, /branchNamePrefix = 'copilot\/'/);
  assert.match(source, /deleteDelayMs = 1000/);
  assert.match(source, /\$branchNamePrefix: String!/);
  assert.match(source, /query: \$branchNamePrefix/);
  assert.match(source, /refPrefix,\n\s+branchNamePrefix,\n\s+cursor/);
  assert.match(source, /ref\.name\.startsWith\(branchNamePrefix\)/);
  assert.match(source, /terminal: associatedPullRequests\([\s\S]*?states: \[MERGED, CLOSED\]/);
  assert.match(source, /open: associatedPullRequests\(first: 1, states: \[OPEN\]\)/);
  assert.match(source, /ref\.open\.totalCount === 0 && ref\.terminal\.totalCount > 0/);
  assert.match(source, /mutation DeleteCopilotBranches/);
  assert.match(source, /updateRefs\(input: \$input\)/);
  assert.match(source, /beforeOid: candidate\.oid/);
  assert.match(source, /afterOid: zeroOid/);
  assert.match(source, /for \(const \[index, candidate\] of candidates\.entries\(\)\)/);
  assert.match(source, /catch \{[\s\S]*?failed\.push\(candidate\)/);
  assert.match(source, /await new Promise\(resolve => setTimeout\(resolve, deleteDelayMs\)\)/);
  assert.match(cleaner, /\$\{failed\.length\} eligible branch\$\{failed\.length === 1 \? " was" : "es were"\} not deleted/);
  assert.doesNotMatch(cleaner, /core\.setFailed/);
  assert.match(source, /core\.info\('Branches eligible for deletion \(dry run\)'\)/);
  assert.match(source, /core\.info\('Deleted branches'\)/);
  assert.match(source, /core\.info\('Branches not deleted'\)/);
  assert.doesNotMatch(source, /core\.summary/);
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
