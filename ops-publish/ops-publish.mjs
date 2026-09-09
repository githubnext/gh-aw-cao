import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const PUBLISH_LABEL = "ops:publish-to-target";
const API_TIMEOUT_MS = 30_000;

const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
export function configuredWorkerPackages(packages) {
  return new Map(
    Object.entries(packages || {}).flatMap(([packageName, policy]) =>
      Object.keys(policy.worker_policies || {}).map((workflow) => [`${workflow}.lock.yml`, packageName]),
    ),
  );
}

function normalized(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function configuredSet(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map(normalized)
      .filter(Boolean),
  );
}

function requireRepository(value, label) {
  if (!repositoryPattern.test(value || "")) throw new Error(`${label} must use owner/repository form`);
  return value;
}

function requireTimestamp(value, label) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be an ISO 8601 timestamp`);
  return timestamp;
}

function controlSettings() {
  if (!process.env.CONTROL_SETTINGS) throw new Error("CONTROL_SETTINGS is required");
  const settings = JSON.parse(readFileSync(process.env.CONTROL_SETTINGS, "utf8"));
  if (!settings || Array.isArray(settings) || typeof settings !== "object") {
    throw new Error("CONTROL_SETTINGS must contain resolved control policy");
  }
  return settings;
}

export function issueContentDigest(title, body) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: String(title || ""),
        body: String(body || ""),
      }),
    )
    .digest("hex");
}

function generatedRun(body, serverUrl) {
  const match = String(body || "").match(/Generated (?:from|with) \[[^\]]+\]\((https?:\/\/[^\s)]+\/actions\/runs\/(\d+))\)/i);
  if (!match) throw new Error("review issue is missing generated workflow-run provenance");
  const runUrl = new URL(match[1]);
  const server = new URL(serverUrl);
  if (runUrl.origin !== server.origin) throw new Error("workflow-run provenance uses a different GitHub host");
  const pathParts = runUrl.pathname.split("/").filter(Boolean);
  if (pathParts.length !== 5 || pathParts[2] !== "actions" || pathParts[3] !== "runs" || pathParts[4] !== match[2]) {
    throw new Error("workflow-run provenance URL is invalid");
  }
  const controlRepository = requireRepository(`${pathParts[0]}/${pathParts[1]}`, "control repository");
  return { controlRepository, runId: match[2], runUrl: match[1] };
}

export function inspectPublishEvent({ event, repository, serverUrl = "https://github.com", reviewers, controlRepositories }) {
  if (event.action !== "labeled" || event.label?.name !== PUBLISH_LABEL) {
    throw new Error(`event must apply the ${PUBLISH_LABEL} label`);
  }
  if (normalized(event.repository?.full_name) !== normalized(repository)) {
    throw new Error("event repository does not match GITHUB_REPOSITORY");
  }
  if (event.issue?.pull_request) throw new Error(`${PUBLISH_LABEL} supports issues only`);
  if (event.issue?.state !== "open") throw new Error("review issue must be open");
  if (event.issue?.user?.type !== "Bot") throw new Error("review issue must be created by a GitHub App or Actions bot");

  const allowedReviewers = configuredSet(reviewers);
  if (allowedReviewers.size === 0) {
    throw new Error("control-plane.publishing.reviewers must list at least one GitHub login");
  }
  const reviewer = event.sender?.login || "";
  if (event.sender?.type !== "User" || !allowedReviewers.has(normalized(reviewer))) {
    throw new Error(`${reviewer || "event sender"} is not an authorized ops publisher`);
  }

  const provenance = generatedRun(event.issue?.body, serverUrl);
  const allowedControlRepositories = configuredSet(controlRepositories || repository);
  if (!allowedControlRepositories.has(normalized(provenance.controlRepository))) {
    throw new Error("generated workflow run is outside control-plane.publishing.control-repositories");
  }
  const [controlOwner, controlName] = provenance.controlRepository.split("/");
  return {
    ...provenance,
    controlOwner,
    controlName,
    reviewer,
    sourceIssueNumber: event.issue.number,
    sourceContentDigest: issueContentDigest(event.issue.title, event.issue.body),
    sourceIssueCreatedAt: event.issue.created_at,
  };
}

export function validateWorkflowRun({ run, inspection, reviewRepository, allowedOwners, allowedRepositories, packages }) {
  if (
    String(run.id) !== String(inspection.runId) ||
    normalized(run.repository?.full_name) !== normalized(inspection.controlRepository) ||
    run.html_url !== inspection.runUrl
  ) {
    throw new Error("workflow run does not match review issue provenance");
  }
  if (run.event !== "workflow_dispatch" || run.status !== "completed" || run.conclusion !== "success") {
    throw new Error("review issue must originate from a successful dispatched worker run");
  }
  const defaultBranch = String(run.repository?.default_branch || "");
  if (!defaultBranch || run.head_branch !== defaultBranch) {
    throw new Error("workflow run must execute from the control repository default branch");
  }
  const sourceCreatedAt = requireTimestamp(inspection.sourceIssueCreatedAt, "review issue creation time");
  const runCreatedAt = requireTimestamp(run.created_at, "workflow run creation time");
  const runUpdatedAt = requireTimestamp(run.updated_at, "workflow run update time");
  if (sourceCreatedAt < runCreatedAt || sourceCreatedAt > runUpdatedAt) {
    throw new Error("review issue creation time must fall within the originating workflow run");
  }
  const workflowPath = String(run.path || "").split("@")[0];
  const workflowFile = workflowPath.split("/").at(-1);
  const workerPackages = configuredWorkerPackages(packages);
  const packageName = workerPackages.get(workflowFile);
  if (!packageName || workflowPath !== `.github/workflows/${workflowFile}`) {
    throw new Error("workflow run is not from a supported Central Agentic Ops worker");
  }
  const targetMatch = String(run.display_title || "").match(/ · ([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+) · review$/);
  if (!targetMatch) throw new Error("workflow run does not identify a review-mode target repository");
  const targetRepository = requireRepository(targetMatch[1], "target repository");
  if (normalized(targetRepository) === normalized(reviewRepository)) {
    throw new Error("target repository must differ from the review repository");
  }

  const owner = normalized(targetRepository.split("/")[0]);
  const ownerAllowlist = configuredSet(allowedOwners);
  if (!ownerAllowlist.has(owner)) throw new Error("target repository owner is outside control-plane.scope.allowed-owners");
  const repositoryAllowlist = configuredSet(allowedRepositories);
  if (repositoryAllowlist.size > 0 && !repositoryAllowlist.has(normalized(targetRepository))) {
    throw new Error("target repository is outside control-plane.scope.allowed-repositories");
  }
  const [targetOwner, targetName] = targetRepository.split("/");
  return { packageName, targetRepository, targetOwner, targetName };
}

export function publicationMarker(sourceRepository, sourceIssueNumber) {
  return `<!-- central-agentic-ops:published-from=${sourceRepository}#${sourceIssueNumber} -->`;
}

export function publicationCommentMarker(targetRepository, targetIssueNumber) {
  return `<!-- central-agentic-ops:published-to=${targetRepository}#${targetIssueNumber} -->`;
}

export function publishedIssueBody(sourceBody, { sourceRepository, sourceIssueNumber, sourceRunUrl, reviewer, serverUrl }) {
  const sourceUrl = `${serverUrl}/${sourceRepository}/issues/${sourceIssueNumber}`;
  return `${String(sourceBody || "").trimEnd()}\n\n---\n\nPublished from [a reviewed operations proposal](${sourceUrl}) by @${reviewer}. [Originating workflow run](${sourceRunUrl}).\n\n${publicationMarker(sourceRepository, sourceIssueNumber)}\n`;
}

async function apiRequest(token, apiUrl, pathname, options = {}) {
  if (!token) throw new Error("required GitHub credential is not configured");
  const response = await fetch(`${apiUrl}${pathname}`, {
    ...options,
    signal: options.signal || AbortSignal.timeout(API_TIMEOUT_MS),
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      ...options.headers,
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub API ${response.status} for ${pathname}: ${detail.slice(0, 500)}`);
  }
  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch {
    throw new Error(`GitHub API returned invalid JSON for ${pathname}`);
  }
}

function writeOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}

async function inspectCommand() {
  const settings = controlSettings();
  if (settings.publishing_enabled !== true) throw new Error("Ops Publish is disabled by control policy");
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const inspection = inspectPublishEvent({
    event,
    repository: process.env.GITHUB_REPOSITORY,
    serverUrl: process.env.GITHUB_SERVER_URL,
    reviewers: settings.publishing_reviewers,
    controlRepositories: settings.publishing_control_repositories,
  });
  writeOutputs({
    control_owner: inspection.controlOwner,
    control_name: inspection.controlName,
    control_repository: inspection.controlRepository,
    reviewer: inspection.reviewer,
    run_id: inspection.runId,
    run_url: inspection.runUrl,
    source_content_digest: inspection.sourceContentDigest,
    source_created_at: inspection.sourceIssueCreatedAt,
    source_issue: inspection.sourceIssueNumber,
  });
}

async function validateRunCommand() {
  const settings = controlSettings();
  const inspection = {
    controlRepository: process.env.CONTROL_REPOSITORY,
    runId: process.env.SOURCE_RUN_ID,
    runUrl: process.env.SOURCE_RUN_URL,
    sourceIssueCreatedAt: process.env.SOURCE_ISSUE_CREATED_AT,
  };
  const run = await apiRequest(
    process.env.CONTROL_TOKEN,
    process.env.GITHUB_API_URL,
    `/repos/${inspection.controlRepository}/actions/runs/${inspection.runId}`,
  );
  const validated = validateWorkflowRun({
    run,
    inspection,
    reviewRepository: process.env.GITHUB_REPOSITORY,
    allowedOwners: settings.allowed_owners,
    allowedRepositories: settings.allowed_repositories,
    packages: settings.packages,
  });
  writeOutputs({
    package: validated.packageName,
    target_owner: validated.targetOwner,
    target_name: validated.targetName,
    target_repository: validated.targetRepository,
  });
}

async function findPublishedIssue(targetToken, apiUrl, targetRepository, marker, sourceCreatedAt) {
  for (let page = 1; page <= 100; page += 1) {
    const issues = await apiRequest(targetToken, apiUrl, `/repos/${targetRepository}/issues?state=all&sort=created&direction=desc&per_page=100&page=${page}`);
    const existing = issues.find((issue) => String(issue.body || "").includes(marker));
    if (existing) return existing;
    if (issues.length < 100) return null;
    const oldestCreatedAt = issues.at(-1)?.created_at;
    if (oldestCreatedAt && Date.parse(oldestCreatedAt) < Date.parse(sourceCreatedAt)) return null;
  }
  throw new Error("could not prove publication idempotency within 100 target issue pages");
}

async function findPublicationComment(sourceToken, apiUrl, sourceRepository, sourceIssueNumber, marker) {
  for (let page = 1; page <= 100; page += 1) {
    const comments = await apiRequest(sourceToken, apiUrl, `/repos/${sourceRepository}/issues/${sourceIssueNumber}/comments?per_page=100&page=${page}`);
    const existing = comments.find((comment) => String(comment.body || "").includes(marker));
    if (existing) return existing;
    if (comments.length < 100) return null;
  }
  throw new Error("could not prove source comment idempotency within 100 comment pages");
}

async function publishCommand() {
  const settings = controlSettings();
  const apiUrl = process.env.GITHUB_API_URL;
  const serverUrl = process.env.GITHUB_SERVER_URL;
  const sourceRepository = requireRepository(process.env.GITHUB_REPOSITORY, "review repository");
  const sourceIssueNumber = Number(process.env.SOURCE_ISSUE);
  const targetRepository = requireRepository(process.env.TARGET_REPOSITORY, "target repository");
  const packageName = process.env.PACKAGE;
  const expectedContentDigest = process.env.SOURCE_CONTENT_DIGEST || "";
  if (!Number.isInteger(sourceIssueNumber) || sourceIssueNumber < 1) throw new Error("source issue number is invalid");
  if (!/^[a-f0-9]{64}$/.test(expectedContentDigest)) throw new Error("approved source content digest is invalid");
  if (![...configuredWorkerPackages(settings.packages).values()].includes(packageName)) {
    throw new Error("package is unsupported");
  }

  const sourceIssue = await apiRequest(process.env.SOURCE_TOKEN, apiUrl, `/repos/${sourceRepository}/issues/${sourceIssueNumber}`);
  if (sourceIssue.state !== "open" || sourceIssue.pull_request || sourceIssue.user?.type !== "Bot") {
    throw new Error("review issue is no longer an open bot-authored issue");
  }
  if (!sourceIssue.labels?.some((label) => label.name === PUBLISH_LABEL)) {
    throw new Error(`${PUBLISH_LABEL} label was removed before publication`);
  }
  if (issueContentDigest(sourceIssue.title, sourceIssue.body) !== expectedContentDigest) {
    throw new Error(`review issue content changed after ${PUBLISH_LABEL} approval; remove and reapply the label`);
  }
  const currentProvenance = generatedRun(sourceIssue.body, serverUrl);
  if (
    currentProvenance.runUrl !== process.env.SOURCE_RUN_URL ||
    normalized(currentProvenance.controlRepository) !== normalized(process.env.CONTROL_REPOSITORY)
  ) {
    throw new Error("review issue provenance changed during publication");
  }

  const target = await apiRequest(process.env.TARGET_TOKEN, apiUrl, `/repos/${targetRepository}`);
  if (target.archived || target.disabled || !target.has_issues) throw new Error("target repository cannot accept published issues");

  const marker = publicationMarker(sourceRepository, sourceIssueNumber);
  let targetIssue = await findPublishedIssue(process.env.TARGET_TOKEN, apiUrl, targetRepository, marker, sourceIssue.created_at);
  if (!targetIssue) {
    targetIssue = await apiRequest(process.env.TARGET_TOKEN, apiUrl, `/repos/${targetRepository}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: sourceIssue.title,
        body: publishedIssueBody(sourceIssue.body, {
          sourceRepository,
          sourceIssueNumber,
          sourceRunUrl: process.env.SOURCE_RUN_URL,
          reviewer: process.env.REVIEWER,
          serverUrl,
        }),
      }),
    });
  }

  const commentMarker = publicationCommentMarker(targetRepository, targetIssue.number);
  const existingComment = await findPublicationComment(process.env.SOURCE_TOKEN, apiUrl, sourceRepository, sourceIssueNumber, commentMarker);
  if (!existingComment) {
    await apiRequest(process.env.SOURCE_TOKEN, apiUrl, `/repos/${sourceRepository}/issues/${sourceIssueNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({
        body: `Published to ${targetIssue.html_url} after approval by @${process.env.REVIEWER}.\n\n${commentMarker}`,
      }),
    });
  }
  await apiRequest(process.env.SOURCE_TOKEN, apiUrl, `/repos/${sourceRepository}/issues/${sourceIssueNumber}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed", state_reason: "completed" }),
  });
  writeOutputs({ target_issue_url: targetIssue.html_url });
}

async function main() {
  const command = process.argv[2];
  if (command === "inspect") return inspectCommand();
  if (command === "validate-run") return validateRunCommand();
  if (command === "publish") return publishCommand();
  throw new Error("usage: ops-publish.mjs <inspect|validate-run|publish>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
