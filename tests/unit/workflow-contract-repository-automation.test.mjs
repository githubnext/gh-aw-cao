import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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
  assert.match(pullRequestReporter, /### GitHub Actions lint failures/);
  assert.doesNotMatch(pullRequestReporter, /['"`]#{1,2} /);
  assert.doesNotMatch(pullRequestReporter, /listComments|updateComment|deleteComment/);
});

test("comment-writing workflow actions are explicitly inventoried", () => {
  const commentWriters = readdirSync(join(root, ".github", "workflows"))
    .filter((name) => name.endsWith(".yml"))
    .filter((name) => workflow(name).includes("github.rest.issues.createComment"))
    .toSorted();

  assert.deepEqual(commentWriters, [
    "action-lint.yml",
    "actions.yml",
    "cid.yml",
    "dashboard-deployed-integration.yml",
    "dashboard-query-parity.yml",
    "dashboard-views.yml",
    "svg-contrast-check.yml",
  ]);
  for (const name of commentWriters) {
    const source = workflow(name);
    if (/'<\/details>',\n(?!\s*'',)/.test(source)) {
      assert.match(
        source,
        /sections\.join\('\\n\\n'\)/,
        `${name} must leave an empty line after each closing details element`,
      );
    }
  }
  assert.match(workflow("svg-contrast-check.yml"), /### Affected files/);
  assert.doesNotMatch(workflow("svg-contrast-check.yml"), /\? '## Affected files/);
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

test("workflow contracts isolate authenticated campaign lifecycle checks", () => {
  const campaignScripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  const campaignLifecycleTest = readFileSync(join(root, "tests", "integration", "campaign-lifecycle.test.mjs"), "utf8");
  assert.match(campaignScripts["test:integration"], /control-failure\.test\.mjs/);
  assert.doesNotMatch(campaignScripts["test:integration"], /campaign-lifecycle/);
  assert.match(campaignScripts["test:campaign-lifecycle"], /campaign-lifecycle\.test\.mjs/);
  assert.match(campaignScripts["test:campaign-root"], /--test-name-pattern=.\^root campaign bootstraps/);
  assert.match(campaignScripts["test:campaign-root"], /campaign-lifecycle\.test\.mjs/);
  assert.doesNotMatch(campaignScripts.test, /campaign-lifecycle/);

  const source = workflow("workflow-contracts.yml");
  const jobs = generatedJobs(source);
  const contracts = jobs.get("test")?.block ?? "";
  const operationalValue = jobs.get("dependabot-operational-value")?.block ?? "";
  const campaignLifecycle = jobs.get("campaign-lifecycle")?.block ?? "";

  assert.match(source, /pull_request:\n    paths-ignore:\n      - \.github\/workflows\/cid\.yml\n      - dashboard\/site\/\*\*/);
  assert.match(source, /push:\n    branches: \[main\]\n    paths-ignore:\n      - \.github\/workflows\/cid\.yml\n      - dashboard\/site\/\*\*/);
  assert.match(contracts, /npm run check/);
  assert.doesNotMatch(contracts, /GH_TOKEN|CENTRAL_AGENTIC_OPS_CAMPAIGN_SOURCE|test:campaign-lifecycle/);
  assert.match(operationalValue, /name: Dependabot operational value integration/);
  assert.match(operationalValue, /permissions:\n\s+contents: read\n\s+security-events: read\n\s+vulnerability-alerts: read/);
  assert.match(operationalValue, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(operationalValue, /--repository "\$GITHUB_REPOSITORY"/);
  assert.match(operationalValue, /--max-github-api-rate-limit -100/);
  assert.match(operationalValue, /value_id == "dependabot-vulnerability-alerts"/);
  assert.match(campaignLifecycle, /gh api rate_limit --jq '\.resources\.core\.remaining'/);
  assert.match(campaignLifecycle, /remaining < 500/);
  assert.match(campaignLifecycle, /max-parallel: 1/);
  assert.match(campaignLifecycle, /if: steps\.campaign-api\.outputs\.ready == 'true'/);
  assert.match(campaignLifecycle, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(
    campaignLifecycle,
    /export CENTRAL_AGENTIC_OPS_CAMPAIGN_SOURCE="\$\{GITHUB_REPOSITORY\}@\$\(git rev-parse --short=12 "\$GITHUB_SHA"\)"/,
  );
  assert.match(campaignLifecycle, /npm run test:campaign-lifecycle/);
  assert.match(campaignLifecycle, /grep -Fq "API rate limit exceeded for installation"/);
  assert.match(campaignLifecycle, /exit "\$status"/);
  assert.match(campaignLifecycleTest, /const campaignUpdateSource = "https:\/\/github\.com\/githubnext\/gh-aw-cao"/);
  assert.match(campaignLifecycleTest, /"update",\n\s+campaignUpdateSource,/);
});
