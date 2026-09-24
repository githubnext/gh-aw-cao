#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const STATE_ORDER = new Map([
  ["proposed", 0],
  ["accepted", 1],
  ["running", 2],
  ["rejected", 3],
]);

class EvidenceError extends Error {}
class GitHubEvidenceUnavailableError extends Error {}

function requiredString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return number;
}

function canonicalTimestamp(value, field) {
  const timestamp = requiredString(value, field);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} must be an ISO 8601 timestamp`);
  return new Date(parsed).toISOString().replace(".000Z", "Z");
}

function githubEntity(url, kind) {
  const parsed = new URL(requiredString(url, `${kind} URL`));
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.search || parsed.hash) {
    throw new TypeError(`${kind} URL must be an unqualified github.com URL`);
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  const marker = kind === "issue" ? "issues" : "pull";
  if (parts.length !== 4 || parts[2] !== marker || !/^[1-9][0-9]*$/.test(parts[3])) {
    throw new TypeError(`${kind} URL has an invalid path`);
  }
  return {
    owner: parts[0],
    repository: parts[1],
    fullName: `${parts[0]}/${parts[1]}`,
    number: Number(parts[3]),
    url: `https://github.com/${parts.join("/")}`,
  };
}

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(candidate));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(candidate);
  }
  return files;
}

async function readEnvelopes(directory) {
  const envelopes = [];
  for (const file of await filesUnder(directory)) {
    const content = await readFile(file, "utf8");
    for (const [index, line] of content.split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      try {
        envelopes.push(JSON.parse(line));
      } catch (error) {
        throw new TypeError(`${file}:${index + 1} contains invalid JSON: ${error.message}`);
      }
    }
  }
  return envelopes;
}

async function readEnvelopeFile(file) {
  const content = await readFile(file, "utf8");
  return content.split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function ghApi(endpoint) {
  try {
    const paginated = /\/pulls\/[1-9][0-9]*\/files\?/u.test(endpoint);
    const args = ["api", endpoint];
    if (paginated) args.push("--paginate", "--slurp");
    const response = JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
    return paginated ? response.flat() : response;
  } catch (error) {
    throw new GitHubEvidenceUnavailableError(
      `GitHub evidence unavailable for ${endpoint}: ${error.message}`,
    );
  }
}

function fetchEvidence(fetchGitHub, endpoint) {
  try {
    return fetchGitHub(endpoint);
  } catch (error) {
    if (error instanceof EvidenceError || error instanceof GitHubEvidenceUnavailableError) throw error;
    throw new GitHubEvidenceUnavailableError(
      `GitHub evidence unavailable for ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function stableDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function latestLifecycle(envelopes, interventionId) {
  return envelopes
    .filter((envelope) =>
      envelope.kind === "token_efficiency_lifecycle_observation"
      && envelope.observation?.interventionId === interventionId)
    .map((envelope) => envelope.observation)
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0];
}

function unique(records, identity) {
  const deduplicated = new Map();
  for (const record of records) deduplicated.set(identity(record), record);
  return [...deduplicated.values()];
}

export function hasLifecycleClaim(envelopes, claim) {
  return envelopes.some((envelope) =>
    envelope.kind === "token_efficiency_lifecycle_observation"
    && String(envelope.observation?.claimRunId) === String(claim.claimRunId)
    && Number(envelope.observation?.claimRunAttempt) === Number(claim.claimRunAttempt));
}

export async function buildLifecycleObservation({
  claim,
  envelopes,
  fetchGitHub = ghApi,
}) {
  if (claim.schemaVersion !== 1) throw new TypeError("unsupported lifecycle claim schemaVersion");
  const claimRunId = String(positiveInteger(claim.claimRunId, "claimRunId"));
  const claimRunAttempt = positiveInteger(claim.claimRunAttempt, "claimRunAttempt");
  const optimizerRunId = String(positiveInteger(claim.optimizerRunId, "optimizerRunId"));
  const optimizerRunAttempt = positiveInteger(
    claim.optimizerRunAttempt,
    "optimizerRunAttempt",
  );
  const opportunityId = requiredString(claim.opportunityId, "opportunityId");
  const interventionId = requiredString(claim.interventionId, "interventionId");
  if (!opportunityId.startsWith("token-opportunity:")) throw new TypeError("invalid opportunityId");
  if (!interventionId.startsWith(`token-intervention:${opportunityId}:`)) {
    throw new TypeError("interventionId does not belong to opportunityId");
  }
  const controlRepository = requiredString(claim.controlRepository, "controlRepository").toLowerCase();
  const claimedAt = canonicalTimestamp(claim.claimedAt, "claimedAt");
  const actor = requiredString(claim.actor, "actor");
  const decision = requiredString(claim.decision, "decision");
  if (!["accepted", "rejected"].includes(decision)) throw new TypeError("invalid decision");

  const lifecycleHistory = envelopes.filter((envelope) =>
    envelope.kind === "token_efficiency_lifecycle_observation"
    && String(envelope.observation?.optimizerRunId) === optimizerRunId
    && Number(envelope.observation?.optimizerRunAttempt
      ?? envelope.observation?.runAttempt) === optimizerRunAttempt
    && envelope.observation?.opportunityId === opportunityId
    && envelope.observation?.interventionId === interventionId)
    .map((envelope) => envelope.observation);
  const proposals = envelopes.filter((envelope) =>
    envelope.kind === "token_efficiency_observation"
    && String(envelope.observation?.optimizerRunId) === optimizerRunId
    && Number(envelope.observation?.runAttempt) === optimizerRunAttempt
    && envelope.observation?.opportunityId === opportunityId
    && envelope.observation?.interventionId === interventionId);
  if (proposals.length > 1) throw new TypeError("claim must match exactly one optimizer observation");
  const proposal = proposals[0]?.observation ?? lifecycleHistory[0];
  if (!proposal) throw new TypeError("claim must match an optimizer observation or retained lifecycle");
  if (String(proposal.controlRepository).toLowerCase() !== controlRepository) {
    throw new TypeError("claim controlRepository does not match optimizer observation");
  }

  const issue = githubEntity(claim.safeOutputUrl, "issue");
  if (issue.fullName.toLowerCase() !== controlRepository) {
    throw new TypeError("safe output must belong to the control repository");
  }
  const sourceRun = envelopes.find((envelope) =>
    ["run", "token_efficiency_run_context"].includes(envelope.kind)
    && String(envelope.run?.run_id) === optimizerRunId
    && Number(envelope.run?.run_attempt ?? 1) === optimizerRunAttempt);
  const runStartedAt = sourceRun
    ? Date.parse(sourceRun.run.started_at ?? sourceRun.run.created_at)
    : Number.NaN;
  const runCompletedAt = sourceRun
    ? Date.parse(sourceRun.run.updated_at ?? sourceRun.run.completed_at)
    : Number.NaN;
  const safeOutputs = unique(envelopes.filter((envelope) =>
    envelope.kind === "safe_output_item"
    && String(envelope.safe_output?.run_id) === optimizerRunId
    && envelope.safe_output?.type === "create_issue"
    && envelope.safe_output?.url === issue.url
    && (envelope.safe_output?.run_attempt !== undefined
      ? Number(envelope.safe_output.run_attempt) === optimizerRunAttempt
      : Number.isFinite(runStartedAt)
        && Number.isFinite(runCompletedAt)
        && Date.parse(envelope.safe_output?.timestamp) >= runStartedAt
        && Date.parse(envelope.safe_output?.timestamp) <= runCompletedAt)),
  (envelope) => envelope.safe_output.url);
  const retainedSafeOutput = lifecycleHistory.some((observation) =>
    observation.safeOutputUrl === issue.url
    && observation.safeOutputId
      === `github:issue:${issue.fullName.toLowerCase()}:${issue.number}`);
  if (safeOutputs.length !== 1 && !(safeOutputs.length === 0 && retainedSafeOutput)) {
    throw new TypeError("claim must match exactly one optimizer safe output");
  }

  const current = latestLifecycle(envelopes, interventionId);
  const previousInterventionState = current?.interventionState ?? "proposed";
  const previousDisposition = current?.recommendationDisposition ?? "unapplied";
  if (["verified", "regressed", "inconclusive", "rejected"].includes(previousInterventionState)) {
    throw new TypeError("a terminal intervention cannot transition");
  }
  if (previousDisposition === "applied" && decision === "rejected") {
    throw new TypeError("an applied intervention cannot be downgraded");
  }

  let interventionState;
  let recommendationDisposition;
  let evidenceState = "complete";
  let missingReason;
  let implementationChangeId = current?.implementationChangeId;
  let implementationPullRequestUrl = current?.implementationPullRequestUrl;
  let implementationRunIds = current?.implementationRunIds;
  let implementationStartedAt = current?.implementationStartedAt;
  let implementationCompletedAt = current?.implementationCompletedAt;
  let rejectedAt;
  let supersededAt;
  let supersededByInterventionId;
  const implementationPullRequestClaim = claim.implementationPullRequestUrl
    ?? (decision === "rejected" ? current?.implementationPullRequestUrl : undefined);
  const implementationRunIdClaims = claim.implementationRunIds
    ?? (decision === "rejected" ? current?.implementationRunIds : undefined);

  if (decision === "rejected") {
    recommendationDisposition = requiredString(claim.rejectionDisposition, "rejectionDisposition");
    if (!["rejected", "failed-start", "outdated", "duplicate", "superseded"].includes(recommendationDisposition)) {
      throw new TypeError("invalid rejectionDisposition");
    }
    interventionState = "rejected";
    rejectedAt = claimedAt;
    if (recommendationDisposition === "superseded") {
      supersededByInterventionId = requiredString(
        claim.supersededByInterventionId,
        "supersededByInterventionId",
      );
      if (!supersededByInterventionId.startsWith(`token-intervention:${opportunityId}:`)) {
        throw new TypeError("superseding intervention must belong to the same opportunity");
      }
      supersededAt = claimedAt;
    } else if (claim.supersededByInterventionId !== undefined) {
      throw new TypeError("supersededByInterventionId requires a superseded disposition");
    }
    if (implementationPullRequestClaim !== undefined
        && !["rejected", "failed-start"].includes(recommendationDisposition)) {
      throw new TypeError(
        "only rejected or failed-start claims can identify an implementation pull request",
      );
    }
  } else {
    if (claim.rejectionDisposition !== undefined || claim.supersededByInterventionId !== undefined) {
      throw new TypeError("accepted claims cannot contain rejection fields");
    }
    interventionState = current?.interventionState ?? "accepted";
    recommendationDisposition = current?.recommendationDisposition ?? "unapplied";
  }

  if (implementationPullRequestClaim !== undefined) {
    const pullRequest = githubEntity(implementationPullRequestClaim, "pull request");
    if (pullRequest.fullName.toLowerCase() !== String(proposal.targetRepo).toLowerCase()) {
      throw new TypeError("implementation pull request must belong to the target repository");
    }
    try {
      const pullRequestRecord = fetchEvidence(
        fetchGitHub,
        `repos/${pullRequest.fullName}/pulls/${pullRequest.number}`,
      );
      const files = fetchEvidence(
        fetchGitHub,
        `repos/${pullRequest.fullName}/pulls/${pullRequest.number}/files?per_page=100`,
      );
      if (pullRequestRecord.html_url !== pullRequest.url
          || Number(pullRequestRecord.number) !== pullRequest.number) {
        throw new EvidenceError("implementation-pull-request-identity-mismatch");
      }
      if (!Array.isArray(files)
          || !files.some((file) => file?.filename === proposal.workflowPath)) {
        throw new EvidenceError("implementation-pull-request-does-not-change-target-workflow");
      }
      implementationChangeId =
        `github:pull-request:${pullRequest.fullName.toLowerCase()}:${pullRequest.number}`;
      implementationPullRequestUrl = pullRequest.url;
      implementationStartedAt = canonicalTimestamp(
        pullRequestRecord.created_at,
        "implementation pull request created_at",
      );
      if (implementationRunIdClaims !== undefined) {
        if (!Array.isArray(implementationRunIdClaims) || implementationRunIdClaims.length === 0) {
          throw new TypeError("implementationRunIds must be a non-empty array when provided");
        }
        implementationRunIds = [...new Set(implementationRunIdClaims.map((runId) =>
          String(positiveInteger(runId, "implementationRunIds entry"))))];
        const pullRequestHeadSha = requiredString(
          pullRequestRecord.head?.sha,
          "implementation pull request head SHA",
        );
        for (const runId of implementationRunIds) {
          const runRecord = fetchEvidence(
            fetchGitHub,
            `repos/${pullRequest.fullName}/actions/runs/${runId}`,
          );
          if (String(runRecord.id) !== runId
              || String(runRecord.repository?.full_name).toLowerCase()
                !== pullRequest.fullName.toLowerCase()
              || runRecord.head_sha !== pullRequestHeadSha) {
            throw new EvidenceError("implementation-run-does-not-match-pull-request");
          }
        }
      }
      if (decision === "accepted") interventionState = "running";
      if (pullRequestRecord.merged_at && decision === "accepted") {
        implementationCompletedAt = canonicalTimestamp(
          pullRequestRecord.merged_at,
          "implementation pull request merged_at",
        );
        recommendationDisposition = "applied";
      } else if (pullRequestRecord.merged_at && decision === "rejected") {
        throw new EvidenceError("rejected-intervention-has-merged-implementation");
      } else if (pullRequestRecord.state !== "open" && decision === "accepted") {
        evidenceState = "incomplete";
        missingReason = "implementation-pull-request-closed-without-merge";
        interventionState = (STATE_ORDER.get(previousInterventionState) ?? -1)
          > STATE_ORDER.get("accepted")
          ? previousInterventionState
          : "accepted";
      } else if (pullRequestRecord.state === "open" && decision === "rejected") {
        throw new EvidenceError("rejected-intervention-has-open-implementation");
      }
    } catch (error) {
      if (!(error instanceof EvidenceError) && !(error instanceof GitHubEvidenceUnavailableError)) {
        throw error;
      }
      evidenceState = error instanceof EvidenceError ? "incomplete" : "unavailable";
      missingReason = error instanceof EvidenceError
        ? error.message
        : "implementation-pull-request-unavailable";
      if (decision === "accepted") {
        if ((STATE_ORDER.get(previousInterventionState) ?? -1) > STATE_ORDER.get("accepted")) {
          interventionState = previousInterventionState;
          recommendationDisposition = previousDisposition;
        } else {
          interventionState = "accepted";
          recommendationDisposition = "unapplied";
        }
      } else {
        interventionState = previousInterventionState;
        recommendationDisposition = previousDisposition;
        rejectedAt = undefined;
        supersededAt = undefined;
        supersededByInterventionId = undefined;
      }
    }
  } else if (implementationRunIdClaims !== undefined) {
    throw new TypeError("implementationRunIds require an implementation pull request");
  }

  if (current && Date.parse(claimedAt) < Date.parse(current.observedAt)) {
    throw new TypeError("lifecycle claim predates the current observation");
  }
  if (current?.implementationChangeId
      && implementationChangeId
      && current.implementationChangeId !== implementationChangeId) {
    throw new TypeError("lifecycle claim changes the implementation identity");
  }
  if (previousDisposition === "applied" && recommendationDisposition !== "applied") {
    throw new TypeError("an applied intervention cannot be downgraded");
  }
  if ((STATE_ORDER.get(interventionState) ?? -1) < (STATE_ORDER.get(previousInterventionState) ?? -1)) {
    throw new TypeError("lifecycle claim would move the intervention backward");
  }

  const acceptedAt = decision === "accepted"
    ? current?.acceptedAt ?? claimedAt
    : current?.acceptedAt;
  const sourceId =
    `github-actions-run:${controlRepository}:${claimRunId}:attempt:${claimRunAttempt}`;
  const evidenceLinks = [issue.url, implementationPullRequestUrl].filter(Boolean);
  const observation = {
    schemaVersion: 1,
    lifecycleObservationId:
      `token-lifecycle:${stableDigest({ interventionId, claimRunId, claimRunAttempt })}`,
    observedAt: claimedAt,
    controlRepository,
    claimRunId,
    claimRunAttempt,
    actor,
    optimizerRunId,
    optimizerRunAttempt,
    optimizerWorkflowPath: ".github/workflows/optimization-token-optimizer.md",
    optimizerWorkflowName: "Optimization / Token Optimizer",
    targetRepo: proposal.targetRepo,
    workflowPath: proposal.workflowPath,
    opportunityId,
    interventionId,
    experimentId: proposal.experimentId,
    controlVariant: proposal.controlVariant,
    optimizedVariant: proposal.optimizedVariant,
    proposedSavingsAic: proposal.proposedSavingsAic,
    supersedesInterventionId: proposal.supersedesInterventionId,
    recommendationChurnCount: proposal.recommendationChurnCount,
    recommendationChurnRate: proposal.recommendationChurnRate,
    previousInterventionState,
    previousRecommendationDisposition: previousDisposition,
    interventionState,
    recommendationDisposition,
    evidenceState,
    safeOutputId: `github:issue:${issue.fullName.toLowerCase()}:${issue.number}`,
    safeOutputUrl: issue.url,
    acceptedAt,
    implementationChangeId,
    implementationPullRequestUrl,
    implementationRunIds,
    implementationStartedAt,
    implementationCompletedAt,
    rejectedAt,
    supersededAt,
    supersededByInterventionId,
    missingReason,
    sourceProvenance: {
      kind: "workflow-dispatch-claim",
      sourceId,
      sourceSchemaRevision: 1,
      repository: controlRepository,
      runId: claimRunId,
      runAttempt: claimRunAttempt,
      actor,
      observedAt: claimedAt,
      generation: sourceId,
      completeness: evidenceState === "complete"
        ? "complete"
        : evidenceState === "incomplete" ? "partial" : "unknown",
      freshness: "fresh",
      evidenceLinks,
    },
  };
  return Object.fromEntries(
    Object.entries(observation).filter(([, value]) => value !== undefined),
  );
}

async function main(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    options.set(args[index], args[index + 1]);
  }
  const claimPath = options.get("--claim");
  const shardDirectory = options.get("--shard-dir");
  if (!claimPath || !shardDirectory) {
    throw new TypeError("usage: token-intervention-lifecycle.mjs --claim FILE --shard-dir DIRECTORY");
  }
  const claim = JSON.parse(await readFile(claimPath, "utf8"));
  const envelopes = await readEnvelopes(shardDirectory);
  const historyPath = options.get("--history-file");
  const history = historyPath ? await readEnvelopeFile(historyPath) : [];
  envelopes.push(...history);
  const optimizerRunId = String(positiveInteger(claim.optimizerRunId, "optimizerRunId"));
  const optimizerRunAttempt = positiveInteger(
    claim.optimizerRunAttempt,
    "optimizerRunAttempt",
  );
  const correlatedObservation = envelopes.find((envelope) =>
    (envelope.kind === "token_efficiency_observation"
      || envelope.kind === "token_efficiency_lifecycle_observation")
    && String(envelope.observation?.optimizerRunId) === optimizerRunId
    && Number(envelope.observation?.optimizerRunAttempt
      ?? envelope.observation?.runAttempt) === optimizerRunAttempt
    && envelope.observation?.opportunityId === claim.opportunityId
    && envelope.observation?.interventionId === claim.interventionId);
  if (!correlatedObservation) {
    throw new TypeError("lifecycle claim requires retained optimizer correlation");
  }
  const sourceRun = envelopes.find((envelope) =>
    ["run", "token_efficiency_run_context"].includes(envelope.kind)
    && String(envelope.run?.run_id) === optimizerRunId
    && Number(envelope.run?.run_attempt ?? 1) === optimizerRunAttempt);
  const retainedRun = history.some((envelope) =>
    envelope.kind === "token_efficiency_run_context"
    && String(envelope.run?.run_id) === optimizerRunId
    && Number(envelope.run?.run_attempt ?? 1) === optimizerRunAttempt);
  if (!retainedRun) {
    if (!sourceRun) throw new TypeError("lifecycle claim requires its optimizer run envelope");
    process.stdout.write(`${JSON.stringify({
      ...sourceRun,
      kind: "token_efficiency_run_context",
    })}\n`);
  }
  if (hasLifecycleClaim(envelopes, claim)) return;
  const observation = await buildLifecycleObservation({ claim, envelopes });
  process.stdout.write(`${JSON.stringify({
    schema_version: 2,
    kind: "token_efficiency_lifecycle_observation",
    created_at: observation.observedAt,
    observation,
  })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
