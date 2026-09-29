import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import {
  activityCollectionPlan,
} from "../../activity/authentication.mjs";
import {
  controlPrecompute,
  root,
  workflow,
  workflowsDirectory,
} from "./workflow-contract.helpers.mjs";

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
    "self-care-agent-discoverability",
    "self-care-code-improvement",
    "self-care-dashboard-data-schema",
    "self-care-dashboard-debug-logging",
    "self-care-dashboard-performance",
    "self-care-data-acquisition-audit",
    "self-care-dashboard-language-refactor",
    "self-care-dashboard-review",
    "self-care-docs-build-time-investigator",
    "self-care-docs-maintainer",
    "self-care-glossary",
    "self-care-open-source-failures",
    "self-care-pages-health",
    "self-care-primer-brand-checker",
    "self-care-reactive-ui-expert",
    "self-care-release-blogger",
    "self-care-server-go-logging",
    "self-care",
  ];

  assert.doesNotMatch(rootManifest, /\.github\/workflows\/self-care(?:-[\w-]+)?\.md/);
  assert.match(selfCareManifest, /description: Repository-local/);
  assert.match(selfCareManifest, /\.github\/workflows\/self-care\.md/);
  assert.match(selfCareManifest, /\.github\/workflows\/self-care-data-acquisition-audit\.md/);
  assert.match(selfCareManifest, /\.github\/workflows\/self-care-docs-build-time-investigator\.md/);
  assert.match(selfCareManifest, /\.github\/workflows\/self-care-docs-maintainer\.md/);
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

  assert.match(control, /GH_TOKEN:.*GH_AW_GITHUB_READ_PAT_REPOSITORIES.*secrets\.GH_AW_GITHUB_READ_PAT.*secrets\.GH_AW_GITHUB_TOKEN.*github\.token/);
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
  assert.match(configuration, /Configure a GitHub App or fine-grained PAT profile for every cross-repository scope/);
  assert.match(control, /cannot read target evidence required by the importing workflow, stop that analysis and report it as incomplete/);
  assert.match(control, /persist response `ETag` values and send them as `If-None-Match`/);
  assert.match(control, /prefer one bounded GraphQL query/);
  assert.match(control, /do not silently reduce the requested analysis to the subset the token can read/);
});

test("authentication prefers an optional GitHub App and retains bounded fallbacks", () => {
  const authentication = readFileSync(join(root, "docs", "authentication.md"), "utf8");
  const control = workflow("shared/control.md");
  const precompute = controlPrecompute();

  assert.match(control, /github-app:\n\s+client-id: \$\{\{ vars\.GH_AW_GITHUB_AUTH_MODE != 'pat'[\s\S]*?vars\.GH_AW_GITHUB_READ_APP_ID/);
  assert.match(control, /private-key: \$\{\{ vars\.GH_AW_GITHUB_AUTH_MODE != 'pat'[\s\S]*?secrets\.GH_AW_GITHUB_READ_APP_PRIVATE_KEY/);
  assert.match(control, /safe-outputs:\n\s+github-app:\n\s+client-id: \$\{\{ vars\.GH_AW_GITHUB_AUTH_MODE != 'pat'[\s\S]*?vars\.GH_AW_GITHUB_WRITE_APP_ID/);
  assert.match(control, /private-key: \$\{\{ vars\.GH_AW_GITHUB_AUTH_MODE != 'pat'[\s\S]*?secrets\.GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY/);
  assert.match(control, /github-token: \$\{\{ vars\.GH_AW_GITHUB_AUTH_MODE == 'pat'[\s\S]*?GH_AW_GITHUB_READ_PAT_REPOSITORIES/);
  assert.match(
    control,
    /safe-outputs:[\s\S]*?github-token: \$\{\{ env\.CAO_ROLE == 'orchestrator' && \(\(inputs\.safe_output_mode[\s\S]*?== github\.repository && github\.token \|\| vars\.GH_AW_GITHUB_AUTH_MODE == 'pat'[\s\S]*?GH_AW_GITHUB_WRITE_PAT_REPOSITORIES/,
  );
  assert.match(control, /ignore-if-missing: true/);
  assert.doesNotMatch(control, /repositories: \["\*"\]/);
  assert.match(
    control,
    /safe-outputs:\n\s+github-app:\n\s+client-id:[\s\S]*?ignore-if-missing: true\n\s+repositories:\n\s+- \$\{\{ inputs\.safe_output_repo \|\| github\.repository \}\}/,
  );
  assert.match(control, /jobs:\n\s+pre-activation:[\s\S]*?GH_AW_GITHUB_READ_PAT_REPOSITORIES[\s\S]*?secrets\.GH_AW_GITHUB_READ_PAT[\s\S]*?github\.token/);
  assert.match(control, /name: Resolve CAO GitHub read scope[\s\S]*?CAO_READ_REPOSITORY: \$\{\{ github\.aw\.import-inputs\.read_repository \}\}/);
  assert.match(control, /name: Generate CAO target-scoped read App token[\s\S]*?owner: \$\{\{ steps\.cao_target_read_scope\.outputs\.owner \}\}/);
  assert.match(control, /echo "permission_vulnerability_alerts=\$\{\{ github\.aw\.import-inputs\.read_vulnerability_alerts \}\}"/);
  assert.match(control, /permission-vulnerability-alerts: \$\{\{ steps\.cao_target_read_scope\.outputs\.permission_vulnerability_alerts \}\}/);
  assert.match(control, /name: Resolve CAO target read credential[\s\S]*?GH_AW_GITHUB_READ_PAT_REPOSITORIES[\s\S]*?cao_target_read_scope\.outputs\.full_name/);
  assert.match(control, /tools:\n\s+github:[\s\S]*?github-token: \$\{\{ steps\.cao_target_read_credential\.outputs\.token \}\}/);
  assert.match(authentication, /runtime availability precedence, not permission to choose a PAT silently/);
  assert.match(authentication, /A PAT is not a substitute for repository or organization access/);
  assert.match(authentication, /Each token covers repositories from exactly one resource owner/);
  assert.match(authentication, /including the Checks API/);
  assert.match(authentication, /Obtain explicit confirmation to proceed/);
  assert.match(authentication, /presence of an existing PAT secret, is not consent/);
  assert.match(authentication, /CAO installation does not require Copilot organization billing/);
  assert.match(authentication, /verifying it up front is completely optional/);
  assert.match(authentication, /most user tokens cannot read organization billing/);
  assert.match(authentication, /Customers may author workflows with another gh-aw-supported engine\/provider/);
  assert.match(authentication, /does not support `COPILOT_GITHUB_TOKEN` inference fallback/);
});

test("CAO workflows bind GitHub tools to exact declared read permissions", () => {
  const permissionInputs = new Map([
    ["actions", "read_actions"],
    ["checks", "read_checks"],
    ["contents", "read_contents"],
    ["issues", "read_issues"],
    ["packages", "read_packages"],
    ["pull-requests", "read_pull_requests"],
    ["secret-scanning-alerts", "read_secret_scanning_alerts"],
    ["security-events", "read_security_events"],
    ["statuses", "read_statuses"],
    ["vulnerability-alerts", "read_vulnerability_alerts"],
  ]);

  for (const name of readdirSync(workflowsDirectory).filter((entry) => entry.endsWith(".md"))) {
    const source = workflow(name);
    if (!/uses: shared\/control\.md/.test(source)) continue;

    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source)?.[1];
    assert.ok(frontmatter, `${name} must have frontmatter`);
    const config = parse(frontmatter);
    const controlImport = config.imports.find((entry) => entry?.uses === "shared/control.md");
    assert.ok(controlImport, `${name} must import shared control`);

    const expected = [...permissionInputs]
      .filter(([permission]) => config.permissions?.[permission] === "read")
      .map(([, input]) => input)
      .sort();
    const actual = Object.entries(controlImport.with)
      .filter(([input, value]) => input.startsWith("read_") && value === "read")
      .map(([input]) => input)
      .sort();
    assert.deepEqual(actual, expected, `${name} must pass its exact read permission set`);

    const lock = workflow(name.replace(/\.md$/, ".lock.yml"));
    assert.match(lock, /name: Resolve CAO target read credential/, `${name} must resolve shared target authentication`);
    if (config.tools?.github === false) {
      assert.equal(controlImport.with.github_tools, false, `${name} must disable unused shared GitHub authentication`);
      continue;
    }
    assert.match(
      lock,
      /(?:GH_TOKEN|GITHUB_MCP_SERVER_TOKEN): \$\{\{ steps\.cao_target_read_credential\.outputs\.token \}\}/,
      `${name} GitHub tools must use shared target authentication`,
    );
    assert.doesNotMatch(lock, /permission-[a-z-]+: null/, `${name} App permissions must be valid action inputs`);
  }
});

test("CAO Activity PAT mode groups exact repositories by owner-scoped secret", () => {
  const plan = activityCollectionPlan({
    allowed_repositories: ["acme/service", "octo/library"],
    allowed_owners: ["acme", "octo"],
  }, {
    authMode: "pat",
    controlRepository: "acme/control",
    patRepositoryMap: JSON.stringify({
      "acme/control": "GH_AW_GITHUB_READ_PAT_ACME",
      "acme/service": "GH_AW_GITHUB_READ_PAT_ACME",
      "octo/library": "GH_AW_GITHUB_READ_PAT_OCTO",
    }),
  });

  assert.deepEqual(plan, [
    {
      owner: "acme",
      repositories: ["acme/control", "acme/service"],
      secret: "GH_AW_GITHUB_READ_PAT_ACME",
      credentialRepository: "acme/control",
      artifact: "acme",
    },
    {
      owner: "octo",
      repositories: ["octo/library"],
      secret: "GH_AW_GITHUB_READ_PAT_OCTO",
      credentialRepository: "octo/library",
      artifact: "octo",
    },
  ]);
});

test("CAO Activity PAT mode fails closed for missing or cross-owner mappings", () => {
  const settings = { allowed_repositories: ["octo/library"] };
  assert.throws(
    () => activityCollectionPlan(settings, {
      authMode: "pat",
      controlRepository: "acme/control",
      patRepositoryMap: '{"acme/control":"GH_AW_GITHUB_READ_PAT_ACME"}',
    }),
    /no mapping for octo\/library/,
  );
  assert.throws(
    () => activityCollectionPlan(settings, {
      authMode: "pat",
      controlRepository: "acme/control",
      patRepositoryMap: JSON.stringify({
        "acme/control": "GH_AW_GITHUB_READ_PAT_ACME",
        "octo/library": "GH_AW_GITHUB_READ_PAT_ACME",
      }),
    }),
    /octo\/library must map to owner-scoped secret GH_AW_GITHUB_READ_PAT_OCTO/,
  );
  assert.throws(
    () => activityCollectionPlan({ allowed_repositories: [] }, {
      authMode: "pat",
      controlRepository: "acme/control",
      patRepositoryMap: "{}",
    }),
    /requires an exact allowed-repositories scope/,
  );
});

test("CAO Activity App mode creates independent organization scopes", () => {
  assert.deepEqual(activityCollectionPlan({
    allowed_repositories: ["acme/service", "octo/library"],
    allowed_owners: ["acme", "octo"],
  }, {
    authMode: "app",
    controlRepository: "acme/control",
  }), [
    {
      owner: "acme",
      repositories: ["acme/control", "acme/service"],
      credentialRepository: "",
      artifact: "acme",
    },
    {
      owner: "octo",
      repositories: ["octo/library"],
      credentialRepository: "",
      artifact: "octo",
    },
  ]);
  assert.deepEqual(activityCollectionPlan({
    allowed_repositories: [],
    allowed_owners: ["acme", "octo"],
  }, {
    authMode: "app",
    controlRepository: "acme/control",
  }).map(({ owner, repositories }) => ({ owner, repositories })), [
    { owner: "acme", repositories: [] },
    { owner: "octo", repositories: [] },
  ]);
});

test("Dependabot planner scopes its read token to the dispatched target", () => {
  const source = workflow("dependabot-update-planner.md");
  const generated = workflow("dependabot-update-planner.lock.yml");
  const scopeStep = /\n\s+- name: Resolve CAO GitHub read scope\n\s+id: cao_target_read_scope[\s\S]*?(?=\n\s+- name: )/.exec(generated)?.[0];
  const appTokenStep = /\n\s+- name: Generate CAO target-scoped read App token\n\s+id: cao_target_read_app_token[\s\S]*?(?=\n\s+- name: )/.exec(generated)?.[0];
  const credentialStep = /\n\s+- name: Resolve CAO target read credential\n\s+id: cao_target_read_credential[\s\S]*?(?=\n\s+- name: )/.exec(generated)?.[0];

  assert.ok(scopeStep, "missing target read scope step");
  assert.ok(appTokenStep, "missing target-scoped App token step");
  assert.ok(credentialStep, "missing target-scoped credential selection step");
  assert.match(source, /read_vulnerability_alerts: read/);
  assert.match(appTokenStep, /owner: \$\{\{ steps\.cao_target_read_scope\.outputs\.owner \}\}/);
  assert.match(appTokenStep, /repositories: \$\{\{ steps\.cao_target_read_scope\.outputs\.repository \}\}/);
  assert.match(scopeStep, /echo "permission_vulnerability_alerts=read"/);
  assert.match(appTokenStep, /permission-vulnerability-alerts: \$\{\{ steps\.cao_target_read_scope\.outputs\.permission_vulnerability_alerts \}\}/);
  assert.doesNotMatch(appTokenStep, /github\.repository_(owner|name)|github\.event\.repository\.name/);
  assert.match(
    credentialStep,
    /GH_AW_GITHUB_AUTH_MODE == 'pat' && secrets\[fromJSON\(vars\.GH_AW_GITHUB_READ_PAT_REPOSITORIES \|\| '\{\}'\)\[steps\.cao_target_read_scope\.outputs\.full_name\]\]/,
  );
  assert.match(generated, /GITHUB_MCP_SERVER_TOKEN: \$\{\{ steps\.cao_target_read_credential\.outputs\.token \}\}/);
});

test("safe-output write App token scopes to the admitted safe-output repository", () => {
  const generated = workflow("dependabot-update-planner.lock.yml");
  const writeAppTokenStep = /\n\s+- name: Generate GitHub App token\n\s+id: safe-outputs-app-token[\s\S]*?(?=\n\s+- name: )/.exec(generated)?.[0];

  assert.ok(writeAppTokenStep, "missing safe-outputs App token step");
  assert.match(writeAppTokenStep, /owner: \$\{\{ github\.repository_owner \}\}/);
  assert.match(writeAppTokenStep, /repositories: \$\{\{ inputs\.safe_output_repo \|\| github\.repository \}\}/);
  assert.doesNotMatch(writeAppTokenStep, /github\.event\.repository\.name/);
  assert.doesNotMatch(writeAppTokenStep, /repositories: \["\*"\]|repositories: \*/);
});
