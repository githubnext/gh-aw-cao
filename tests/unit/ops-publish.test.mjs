import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  configuredWorkerPackages,
  inspectPublishEvent,
  issueContentDigest,
  publicationCommentMarker,
  publicationMarker,
  publishedIssueBody,
  validateWorkflowRun,
} from "../../ops-publish/ops-publish.mjs";
import { controlSettings, parsePolicy } from "../../.github/workflows/shared/policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packages = controlSettings(
  parsePolicy(readFileSync(join(root, ".github", "workflows", "cao.json"), "utf8")),
  "githubnext/gh-aw-cao",
).packages;

const event = {
  action: "labeled",
  label: { name: "ops:publish-to-target" },
  repository: { full_name: "acme/review" },
  sender: { login: "octocat", type: "User" },
  issue: {
    number: 42,
    state: "open",
    title: "Investigate failing workflow",
    created_at: "2026-08-27T10:01:00Z",
    user: { login: "github-actions[bot]", type: "Bot" },
    body: "Target repository: `acme/service`\n\nGenerated from [CAO Evolution / AW Failures](https://github.com/acme/control/actions/runs/123)",
  },
};

test("ops publish derives routing from an allowlisted generated run", () => {
  const inspection = inspectPublishEvent({
    event,
    repository: "acme/review",
    reviewers: "octocat,hubot",
    controlRepositories: "acme/control",
  });
  assert.deepEqual(inspection, {
    controlRepository: "acme/control",
    controlOwner: "acme",
    controlName: "control",
    reviewer: "octocat",
    runId: "123",
    runUrl: "https://github.com/acme/control/actions/runs/123",
    sourceContentDigest: issueContentDigest(event.issue.title, event.issue.body),
    sourceIssueCreatedAt: event.issue.created_at,
    sourceIssueNumber: 42,
  });

  const validated = validateWorkflowRun({
    inspection,
    reviewRepository: "acme/review",
    allowedOwners: "acme",
    allowedRepositories: "acme/service",
    packages,
    run: {
      id: 123,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      path: ".github/workflows/cao-evolution-failures-investigator.lock.yml",
      head_branch: "main",
      created_at: "2026-08-27T10:00:00Z",
      updated_at: "2026-08-27T10:02:00Z",
      display_title: "AW failure investigation · acme/service · review",
      html_url: inspection.runUrl,
      repository: { full_name: "acme/control", default_branch: "main" },
    },
  });
  assert.deepEqual(validated, {
    packageName: "cao-evolution",
    targetRepository: "acme/service",
    targetOwner: "acme",
    targetName: "service",
  });
});

test("ops publish recognizes every supported worker on the default branch", () => {
  const inspection = inspectPublishEvent({
    event,
    repository: "acme/review",
    reviewers: "OCTOCAT",
    controlRepositories: "ACME/CONTROL",
  });
  for (const [workflowFile, packageName] of configuredWorkerPackages(packages)) {
    const validated = validateWorkflowRun({
      inspection,
      reviewRepository: "acme/review",
      allowedOwners: "ACME",
      allowedRepositories: "ACME/SERVICE",
      packages,
      run: {
        id: 123,
        event: "workflow_dispatch",
        status: "completed",
        conclusion: "success",
        path: `.github/workflows/${workflowFile}@refs/heads/main`,
        head_branch: "main",
        created_at: "2026-08-27T10:00:00Z",
        updated_at: "2026-08-27T10:02:00Z",
        display_title: "Worker · acme/service · review",
        html_url: inspection.runUrl,
        repository: { full_name: "ACME/CONTROL", default_branch: "main" },
      },
    });
    assert.equal(validated.packageName, packageName);
  }
});

test("ops publish rejects unauthorized actors and untrusted routing", () => {
  assert.throws(() => inspectPublishEvent({
    event,
    repository: "acme/review",
    reviewers: "hubot",
    controlRepositories: "acme/control",
  }), /not an authorized ops publisher/);

  assert.throws(() => inspectPublishEvent({
    event: { ...event, issue: { ...event.issue, user: { login: "octocat", type: "User" } } },
    repository: "acme/review",
    reviewers: "octocat",
    controlRepositories: "acme/control",
  }), /must be created by a GitHub App or Actions bot/);

  assert.throws(() => inspectPublishEvent({
    event,
    repository: "acme/review",
    reviewers: "octocat",
    controlRepositories: "acme/other-control",
  }), /outside control-plane\.publishing\.control-repositories/);
});

test("ops publish rejects malformed review events and provenance", () => {
  const inspect = (candidateEvent, reviewers = "octocat") => inspectPublishEvent({
    event: candidateEvent,
    repository: "acme/review",
    reviewers,
    controlRepositories: "acme/control",
  });
  for (const [candidateEvent, message] of [
    [{ ...event, action: "edited" }, /event must apply/],
    [{ ...event, repository: { full_name: "acme/other" } }, /does not match GITHUB_REPOSITORY/],
    [{ ...event, issue: { ...event.issue, pull_request: {} } }, /supports issues only/],
    [{ ...event, issue: { ...event.issue, state: "closed" } }, /must be open/],
    [{ ...event, sender: { login: "automation[bot]", type: "Bot" } }, /not an authorized ops publisher/],
    [{ ...event, issue: { ...event.issue, body: "No provenance" } }, /missing generated workflow-run provenance/],
    [{ ...event, issue: { ...event.issue, body: event.issue.body.replace("github.com", "example.com") } }, /different GitHub host/],
    [{ ...event, issue: { ...event.issue, body: event.issue.body.replace("actions/runs/123)", "actions/runs/123/extra)") } }, /missing generated workflow-run provenance/],
  ]) {
    assert.throws(() => inspect(candidateEvent), message);
  }
  assert.throws(() => inspect(event, ""), /must list at least one GitHub login/);

  const generatedWith = inspect({
    ...event,
    issue: { ...event.issue, body: event.issue.body.replace("Generated from", "Generated with") },
  });
  assert.equal(generatedWith.runId, "123");
});

test("ops publish rejects non-review runs and destinations outside policy", () => {
  const inspection = inspectPublishEvent({
    event,
    repository: "acme/review",
    reviewers: "octocat",
    controlRepositories: "acme/control",
  });
  const run = {
    id: 123,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    path: ".github/workflows/cao-evolution-failures-investigator.lock.yml",
    head_branch: "main",
    created_at: "2026-08-27T10:00:00Z",
    updated_at: "2026-08-27T10:02:00Z",
    display_title: "AW failure investigation · other/service · review",
    html_url: inspection.runUrl,
    repository: { full_name: "acme/control", default_branch: "main" },
  };
  assert.throws(() => validateWorkflowRun({
    run,
    inspection,
    reviewRepository: "acme/review",
    allowedOwners: "acme",
    allowedRepositories: "",
    packages,
  }), /outside control-plane\.scope\.allowed-owners/);
  assert.throws(() => validateWorkflowRun({
    run: { ...run, display_title: "AW failure investigation · acme/service · live" },
    inspection,
    reviewRepository: "acme/review",
    allowedOwners: "acme",
    allowedRepositories: "acme/service",
    packages,
  }), /does not identify a review-mode target repository/);

  assert.throws(() => validateWorkflowRun({
    run: { ...run, head_branch: "untrusted-feature" },
    inspection,
    reviewRepository: "acme/review",
    allowedOwners: "acme",
    allowedRepositories: "acme/service",
    packages,
  }), /default branch/);

  assert.throws(() => validateWorkflowRun({
    run: { ...run, path: ".github/workflows/nested/cao-evolution-failures-investigator.lock.yml" },
    inspection,
    reviewRepository: "acme/review",
    allowedOwners: "acme",
    allowedRepositories: "acme/service",
    packages,
  }), /not from a supported/);

  for (const [runOverride, message] of [
    [{ id: 124 }, /does not match review issue provenance/],
    [{ repository: { full_name: "acme/other", default_branch: "main" } }, /does not match review issue provenance/],
    [{ event: "schedule" }, /successful dispatched worker run/],
    [{ status: "in_progress", conclusion: null }, /successful dispatched worker run/],
    [{ conclusion: "failure" }, /successful dispatched worker run/],
    [{ updated_at: "2026-08-27T10:00:30Z" }, /creation time must fall within/],
    [{ created_at: "invalid" }, /workflow run creation time must be an ISO 8601 timestamp/],
  ]) {
    assert.throws(() => validateWorkflowRun({
      run: { ...run, ...runOverride },
      inspection,
      reviewRepository: "acme/review",
      allowedOwners: "acme",
      allowedRepositories: "acme/service",
      packages,
    }), message);
  }
});

test("ops publish does not consult target-owned policy", () => {
  const source = readFileSync(join(root, "ops-publish", "ops-publish.mjs"), "utf8");
  assert.doesNotMatch(source, /target-authority|contents\/\.github\/workflows\/cao\.json/);
});

test("published issues retain review and run provenance", () => {
  const body = publishedIssueBody("Finding", {
    sourceRepository: "acme/review",
    sourceIssueNumber: 42,
    sourceRunUrl: "https://github.com/acme/control/actions/runs/123",
    reviewer: "octocat",
    serverUrl: "https://github.com",
  });
  assert.match(body, /Published from \[a reviewed operations proposal\]/);
  assert.match(body, /Originating workflow run/);
  assert.match(body, new RegExp(publicationMarker("acme/review", 42).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(
    publicationCommentMarker("acme/service", 84),
    "<!-- central-agentic-ops:published-to=acme/service#84 -->",
  );
});

test("Ops Publish remains an explicit least-privilege add-on", () => {
  const rootManifest = readFileSync(join(root, "aw.yml"), "utf8");
  const workflow = readFileSync(join(root, "ops-publish", "ops-publish.yml"), "utf8");
  assert.doesNotMatch(rootManifest, /ops-publish/);
  assert.match(workflow, /issues:\n\s+types: \[labeled\]/);
  assert.match(workflow, /github\.event\.label\.name == 'ops:publish-to-target'/);
  assert.match(workflow, /runs-on: ubuntu-latest\n\s+timeout-minutes: 10/);
  assert.match(workflow, /group: ops-publish-\$\{\{ github\.event\.issue\.number \}\}\n\s+cancel-in-progress: false/);
  assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(workflow, /control\.mjs control-settings \.github\/workflows\/cao\.json/);
  assert.doesNotMatch(workflow, /vars\.CENTRAL_AGENTIC_OPS_/);
  assert.match(workflow, /permissions:\n\s+actions: read\n\s+contents: read\n\s+issues: write/);
  assert.match(workflow, /actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1/);
  assert.match(workflow, /APP_CLIENT_ID: \$\{\{ vars\.GH_AW_GITHUB_READ_APP_ID \}\}/);
  assert.match(workflow, /APP_CLIENT_ID: \$\{\{ vars\.GH_AW_GITHUB_WRITE_APP_ID \}\}/);
  assert.match(workflow, /APP_PRIVATE_KEY: \$\{\{ secrets\.GH_AW_GITHUB_READ_APP_PRIVATE_KEY \}\}/);
  assert.match(workflow, /APP_PRIVATE_KEY: \$\{\{ secrets\.GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY \}\}/);
  assert.match(workflow, /permission-contents: read\n\s+permission-issues: write/);
  assert.match(workflow, /SOURCE_CONTENT_DIGEST: \$\{\{ steps\.inspect\.outputs\.source_content_digest \}\}/);
  assert.match(workflow, /SOURCE_ISSUE_CREATED_AT: \$\{\{ steps\.inspect\.outputs\.source_created_at \}\}/);
  assert.match(workflow, /CONTROL_TOKEN: \$\{\{ steps\.control-app-token\.outputs\.token \|\| secrets\.CENTRAL_AGENTIC_OPS_PUBLISH_CONTROL_TOKEN \|\| github\.token \}\}/);
  assert.match(workflow, /TARGET_TOKEN: \$\{\{ steps\.target-app-token\.outputs\.token \|\| secrets\.CENTRAL_AGENTIC_OPS_PUBLISH_TARGET_TOKEN \}\}/);
  assert.doesNotMatch(workflow, /secrets\.GH_AW_GITHUB_TOKEN/);
  assert.doesNotMatch(workflow, /copilot-requests|models:/);
  const publisher = readFileSync(join(root, "ops-publish", "ops-publish.mjs"), "utf8");
  assert.match(publisher, /AbortSignal\.timeout\(API_TIMEOUT_MS\)/);
});
