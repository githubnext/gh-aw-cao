import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { controlPrecompute, root, workflow } from "./workflow-contract.helpers.mjs";

// Authentication, credential, and action pinning contracts.

test("deterministic workflows pin third-party actions by commit SHA", () => {
  for (const relativePath of [
    join(".github", "workflows", "workflow-contracts.yml"),
    join(".github", "workflows", "copilot-setup-steps.yml"),
    join(".github", "workflows", "enterprise-canary.yml"),
    join(".github", "workflows", "enterprise-stress.yml"),
    join(".github", "workflows", "review-smoke.yml"),
    join(".github", "workflows", "cao-activity.yml"),
    join(".github", "workflows", "cao-dashboard.yml"),
  ]) {
    const source = readFileSync(join(root, relativePath), "utf8");
    for (const action of source.matchAll(/^\s*uses:\s+([^./\s][^@\s]+)@([^\s#]+)/gm)) {
      assert.match(action[2], /^[0-9a-f]{40}$/, `${relativePath}: ${action[1]} is mutable`);
    }
  }
});

test("Copilot setup uses Node 24", () => {
  const source = readFileSync(join(root, ".github", "workflows", "copilot-setup-steps.yml"), "utf8");

  assert.match(source, /actions\/setup-node@[0-9a-f]{40}[\s\S]*?node-version: 24[\s\S]*?cache: npm[\s\S]*?run: npm ci/);
});

test("root CAO workflows use organization-billed Copilot authentication", () => {
  const rootCampaignWorkflowIds = [
    "cao-evolution-failures-investigator",
    "cao-evolution-compiler-security",
    "cao-evolution",
    "cao-evolution-efficiency",
    "cao-evolution-integrity",
    "cao-evolution-reliability",
    "dependabot-update-planner",
    "dependabot",
    "optimization-token-auditor",
    "optimization-token-optimizer",
    "optimization",
  ];
  const rootManifest = readFileSync(join(root, "aw.yml"), "utf8");

  assert.doesNotMatch(rootManifest, /COPILOT_GITHUB_TOKEN/);

  for (const workflowId of rootCampaignWorkflowIds) {
    const source = workflow(`${workflowId}.md`);
    const lock = workflow(`${workflowId}.lock.yml`);

    assert.match(source, /copilot-requests: write/, `${workflowId}.md must use organization billing`);
    assert.doesNotMatch(source, /COPILOT_GITHUB_TOKEN/, `${workflowId}.md must not use PAT inference`);
    assert.match(lock, /copilot-requests: write/, `${workflowId}.lock.yml must grant Copilot requests`);
    assert.match(lock, /COPILOT_GITHUB_TOKEN: \$\{\{ github\.token \}\}/, `${workflowId}.lock.yml must use the workflow token`);
    assert.doesNotMatch(lock, /secrets\.COPILOT_GITHUB_TOKEN/, `${workflowId}.lock.yml must not declare the Copilot PAT secret`);
  }
});

test("repository-local SelfCare uses organization-billed Copilot authentication", () => {
  const rootManifest = readFileSync(join(root, "aw.yml"), "utf8");
  const selfCareManifest = readFileSync(join(root, "self-care", "aw.yml"), "utf8");
  const workflowIds = [
    "self-care-accessibility-checker",
    "self-care-code-improvement",
    "self-care-dashboard-data-schema",
    "self-care-dashboard-debug-logging",
    "self-care-dashboard-performance",
    "self-care-data-acquisition-audit",
    "self-care-dashboard-language-refactor",
    "self-care-dashboard-review",
    "self-care-docs-build-time-investigator",
    "self-care-glossary",
    "self-care-open-source-failures",
    "self-care-pages-health",
    "self-care-primer-brand-checker",
    "self-care-reactive-ui-expert",
    "self-care-server-go-logging",
    "self-care",
  ];

  assert.doesNotMatch(rootManifest, /\.github\/workflows\/self-care(?:-[\w-]+)?\.md/);
  assert.match(selfCareManifest, /description: Repository-local/);
  assert.match(selfCareManifest, /\.github\/workflows\/self-care\.md/);
  assert.match(selfCareManifest, /\.github\/workflows\/self-care-data-acquisition-audit\.md/);
  assert.match(selfCareManifest, /\.github\/workflows\/self-care-docs-build-time-investigator\.md/);
  for (const workflowId of workflowIds) {
    const source = workflow(`${workflowId}.md`);
    const lock = workflow(`${workflowId}.lock.yml`);

    assert.match(source, /copilot-requests: write/, `${workflowId}.md must use organization billing`);
    assert.doesNotMatch(source, /COPILOT_GITHUB_TOKEN/, `${workflowId}.md must not mix auth profiles`);
    assert.match(lock, /copilot-requests: write/, `${workflowId}.lock.yml must grant Copilot requests`);
    assert.match(lock, /COPILOT_GITHUB_TOKEN: \$\{\{ github\.token \}\}/, `${workflowId}.lock.yml must use the workflow token`);
  }
});

test("public read-only operation uses the built-in token without widening access", () => {
  const authentication = readFileSync(join(root, "docs", "authentication.md"), "utf8");
  const configuration = readFileSync(join(root, "docs", "configuration.md"), "utf8");
  const controlSource = readFileSync(join(root, ".github", "workflows", "shared", "control.mjs"), "utf8");
  const control = workflow("shared/control.md");
  const precompute = controlPrecompute();

  assert.match(control, /GH_TOKEN:.*secrets\.GH_AW_GITHUB_TOKEN.*github\.token/);
  assert.match(precompute, /\{id, full_name, archived, disabled, private, pushed_at, default_branch\}/);
  assert.match(authentication, /App or PAT is not required for a bounded `review` run when every target repository is public/);
  assert.match(authentication, /use `review` mode and keep safe outputs in the current control repository/);
  assert.match(authentication, /configure an App or PAT for private or internal targets, an alternate review repository, or any `live` cross-repository write/);
  assert.match(authentication, /report incomplete and produce no speculative result/);
  assert.match(authentication, /conditional requests/);
  assert.match(authentication, /`ETag`/);
  assert.match(authentication, /`If-None-Match`/);
  assert.match(authentication, /GraphQL/);
  assert.match(controlSource, /const GITHUB_API_CACHE_DURATION = "60s";/);
  assert.match(controlSource, /const args = \["api", "--cache", GITHUB_API_CACHE_DURATION\];/);
  assert.match(configuration, /no App or PAT secret is required/);
  assert.match(control, /cannot read target evidence required by the importing workflow, stop that analysis and report it as incomplete/);
  assert.match(control, /persist response `ETag` values and send them as `If-None-Match`/);
  assert.match(control, /prefer one bounded GraphQL query/);
  assert.match(control, /do not silently reduce the requested analysis to the subset the token can read/);
});

test("authentication prefers an optional GitHub App and retains bounded fallbacks", () => {
  const authentication = readFileSync(join(root, "docs", "authentication.md"), "utf8");
  const control = workflow("shared/control.md");
  const precompute = controlPrecompute();

  assert.match(control, /github-app:\n\s+client-id: \$\{\{ vars\.GH_AW_GITHUB_READ_APP_ID \}\}/);
  assert.match(control, /private-key: \$\{\{ secrets\.GH_AW_GITHUB_READ_APP_PRIVATE_KEY \}\}/);
  assert.match(control, /safe-outputs:\n\s+github-app:\n\s+client-id: \$\{\{ vars\.GH_AW_GITHUB_WRITE_APP_ID \}\}/);
  assert.match(control, /private-key: \$\{\{ secrets\.GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY \}\}/);
  assert.match(control, /ignore-if-missing: true/);
  assert.doesNotMatch(control, /repositories: \["\*"\]/);
  assert.match(control, /jobs:\n\s+pre-activation:[\s\S]*?secrets\.GH_AW_GITHUB_TOKEN \|\| github\.token/);
  assert.match(authentication, /runtime availability precedence, not permission to choose a PAT silently/);
  assert.match(authentication, /A PAT is not a substitute for repository or organization access/);
  assert.match(authentication, /A fine-grained PAT cannot access multiple organizations at once/);
  assert.match(authentication, /including the Checks API/);
  assert.match(authentication, /Obtain explicit confirmation to proceed/);
  assert.match(authentication, /presence of an existing PAT secret, is not consent/);
  assert.match(authentication, /CAO installation does not require Copilot organization billing/);
  assert.match(authentication, /verifying it up front is completely optional/);
  assert.match(authentication, /most user tokens cannot read organization billing/);
  assert.match(authentication, /Customers may author workflows with another gh-aw-supported engine\/provider/);
  assert.match(authentication, /does not support `COPILOT_GITHUB_TOKEN` inference fallback/);
});

test("Dependabot planner scopes its read token to the dispatched target", () => {
  const source = workflow("dependabot-update-planner.md");
  const generated = workflow("dependabot-update-planner.lock.yml");
  const tokenStep = /\n\s+- name: Generate GitHub App token\n\s+id: github-mcp-app-token[\s\S]*?(?=\n\s+- name: )/.exec(generated)?.[0];

  assert.ok(tokenStep, "missing GitHub MCP App token step");
  assert.match(source, /name: Derive target GitHub App scope[\s\S]*?TARGET_REPOSITORY: \$\{\{ inputs\.target_repo \}\}/);
  assert.match(source, /echo "owner=\$owner" >> "\$GITHUB_OUTPUT"/);
  assert.match(source, /echo "repository=\$repository" >> "\$GITHUB_OUTPUT"/);
  assert.match(source, /github-app:[\s\S]*?owner: \$\{\{ steps\.target_github_app_scope\.outputs\.owner \}\}/);
  assert.match(source, /repositories: \["\$\{\{ steps\.target_github_app_scope\.outputs\.repository \}\}"\]/);
  assert.match(tokenStep, /owner: \$\{\{ steps\.target_github_app_scope\.outputs\.owner \}\}/);
  assert.match(tokenStep, /repositories: \$\{\{ steps\.target_github_app_scope\.outputs\.repository \}\}/);
  assert.doesNotMatch(tokenStep, /github\.repository_(owner|name)|github\.event\.repository\.name/);
});
