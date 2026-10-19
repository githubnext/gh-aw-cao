import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const objectHash = object => hash(JSON.stringify(object));
const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const samePositive = (value, expected) => positive(value) && value === expected;
const sameSha = (value, expected) => sha(value) && value === expected;
const utcTime = value => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const normalized = new Date(time).toISOString();
  return normalized === value || normalized.replace(".000Z", "Z") === value ? time : null;
};

export function inspectExactLineAppend(before, after, intendedLine = null) {
  if (!Buffer.isBuffer(before) || !Buffer.isBuffer(after)
    || before.length > 4 * 1024 * 1024 || after.length > 4 * 1024 * 1024
    || !Buffer.from(before.toString("utf8")).equals(before)
    || !Buffer.from(after.toString("utf8")).equals(after)) {
    return { structuralAppend: null, sequentialAppend: null, reason: "Missing or invalid exact UTF-8 target bytes" };
  }
  let addition = after.subarray(before.length);
  const prefixPreserved = after.length > before.length && after.subarray(0, before.length).equals(before);
  if (before.length && before.at(-1) !== 10) {
    if (addition.at(0) !== 10) return { structuralAppend: false, sequentialAppend: false };
    addition = addition.subarray(1);
  }
  const line = addition.at(-1) === 10 ? addition.subarray(0, -1) : addition;
  const structuralAppend = prefixPreserved && line.length > 0 && !line.includes(10) && !line.includes(13)
    && !before.toString("utf8").split(/\r?\n/).includes(line.toString("utf8"));
  if (!structuralAppend) return { structuralAppend: false, sequentialAppend: false };
  if (!Buffer.isBuffer(intendedLine) || !intendedLine.length || intendedLine.includes(10) || intendedLine.includes(13)) {
    return { structuralAppend: true, sequentialAppend: null,
      reason: "An independently frozen source-grounded next-line oracle is unavailable" };
  }
  return { structuralAppend: true, sequentialAppend: line.equals(intendedLine) };
}

export function inspectUpdateReceipt(receipt, profile, before, after, intendedLine = null, artifactBytes = null) {
  // The expected profile comes from protected source/run/host metadata, never from the receipt being checked.
  if (!receipt || !profile || receipt.repository !== profile.targetRepository
    || receipt.visibility !== "public" || receipt.pullNumber !== 1
    || typeof profile.expectedBranch !== "string" || !profile.expectedBranch
    || receipt.branch !== profile.expectedBranch || receipt.preBranch !== profile.expectedBranch
    || !sha(receipt.beforeCommit) || !sha(receipt.afterCommit) || receipt.beforeCommit === receipt.afterCommit
    || receipt.beforeIsAncestor !== true || receipt.kind !== "protected-host-push-receipt"
    || !sameSha(receipt.workflowSourceBlob, profile.gitBlob)
    || !sameSha(receipt.compiledGitBlob, profile.compiledGitBlob)
    || !sameSha(receipt.sourceHead, profile.sourceHead) || !sameSha(receipt.runtimeTree, profile.runtimeTree)
    || typeof profile.workflowRepository !== "string" || !profile.workflowRepository
    || receipt.workflowRepository !== profile.workflowRepository
    || !samePositive(receipt.workflowRepositoryId, profile.workflowRepositoryId)
    || !samePositive(receipt.runId, profile.runId) || !samePositive(receipt.attempt, profile.attempt)
    || !samePositive(receipt.repositoryId, profile.repositoryId) || !samePositive(receipt.pullId, profile.pullId)
    || typeof profile.workflowPath !== "string" || !profile.workflowPath
    || receipt.workflowPath !== profile.workflowPath
    || !Array.isArray(receipt.changedPaths) || receipt.changedPaths.length !== 1 || receipt.changedPaths[0] !== "README.md"
    || !Buffer.isBuffer(before) || !Buffer.isBuffer(after)
    || receipt.beforeSha256 !== hash(before) || receipt.afterSha256 !== hash(after)) {
    return { structuralAppend: null, sequentialAppend: null, reason: "Missing independent target/run/attempt/source/branch binding" };
  }
  const host = receipt.host, expectedHost = profile.host;
  const artifact = receipt.artifact, expectedArtifact = profile.artifact;
  if (!host || !expectedHost || !artifact || !expectedArtifact
    || !samePositive(host.jobId, expectedHost.jobId)
    || !samePositive(host.stepNumber, expectedHost.stepNumber)
    || typeof expectedHost.jobName !== "string" || !expectedHost.jobName || host.jobName !== expectedHost.jobName
    || !sameSha(host.checkerGitBlob, expectedHost.checkerGitBlob)
    || !samePositive(artifact.id, expectedArtifact.id)
    || !samePositive(artifact.runId, profile.runId) || !samePositive(artifact.attempt, profile.attempt)
    || !samePositive(artifact.repositoryId, profile.workflowRepositoryId)
    || !samePositive(artifact.jobId, host.jobId) || !sameSha(artifact.sourceHead, profile.sourceHead)
    || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)
    || artifact.sha256 !== expectedArtifact.sha256
    || !Buffer.isBuffer(artifactBytes) || artifactBytes.length > 4 * 1024 * 1024
    || hash(artifactBytes) !== artifact.sha256) {
    return { structuralAppend: null, sequentialAppend: null, reason: "Missing independent protected host/artifact identity or payload digest" };
  }
  const at = {
    runStart: utcTime(profile.runStartedAt), runEnd: utcTime(profile.runCompletedAt),
    hostStart: utcTime(host.startedAt), hostEnd: utcTime(host.completedAt),
    pre: utcTime(receipt.preObservedAt), pushed: utcTime(receipt.pushedAt),
    post: utcTime(receipt.postObservedAt), artifact: utcTime(artifact.createdAt),
    cutoff: utcTime(profile.evidenceCutoff),
  };
  if (Object.values(at).some(value => value === null)
    || host.startedAt !== expectedHost.startedAt || host.completedAt !== expectedHost.completedAt
    || artifact.createdAt !== expectedArtifact.createdAt
    || !(at.runStart <= at.hostStart && at.hostStart <= at.pre && at.pre < at.pushed
      && at.pushed <= at.post && at.post <= at.hostEnd && at.hostEnd <= at.artifact
      && at.artifact <= at.runEnd && at.runEnd < at.cutoff)) {
    return { structuralAppend: null, sequentialAppend: null, reason: "Invalid protected receipt/run/artifact chronology" };
  }
  let nativePayload;
  try {
    nativePayload = JSON.parse(artifactBytes.toString("utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { structuralAppend: null, sequentialAppend: null, reason: "Malformed native receipt artifact JSON" };
  }
  const { artifact: artifactMetadata, ...projectedPayload } = receipt;
  if (!isDeepStrictEqual(nativePayload, projectedPayload) || !artifactMetadata) {
    return { structuralAppend: null, sequentialAppend: null, reason: "Receipt projection differs from independently digest-bound native artifact" };
  }
  return inspectExactLineAppend(before, after, intendedLine);
}

export function crossRepoUpdateScore(id, evidence) {
  if (!["sequential-appends", "nonduplicate-line-appends"].includes(id) || evidence?.valid !== true
    || !Array.isArray(evidence.assessments) || evidence.assessments.length === 0
    || new Set(evidence.assessments.map(row => row?.id)).size !== evidence.assessments.length
    || evidence.assessments.some(row => typeof row?.id !== "string" || !row.id
      || ![true, false, null].includes(row.structuralAppend)
      || ![true, false, null].includes(row.sequentialAppend)
      || (row.sequentialAppend === true && row.structuralAppend !== true)
      || (row.structuralAppend === false && row.sequentialAppend !== false))) return null;
  const field = id === "sequential-appends" ? "sequentialAppend" : "structuralAppend";
  const known = evidence.assessments.filter(row => row[field] !== null);
  return known.length ? known.filter(row => row[field]).length : null;
}

export function crossRepoUpdateModule(contract) {
  if (contract.interpreterSha256 !== hash(readFileSync(import.meta.filename))) {
    throw new Error("Frozen cross-repo update interpreter changed");
  }
  const example = passed => ({ valid: true, assessments: [{ id: "synthetic-validator-only",
    structuralAppend: passed, sequentialAppend: passed }] });
  const definition = {
    schemaVersion: 3, slug: contract.slug, repository: contract.repository,
    workflowName: "Smoke Update Cross-Repo PR",
    sourcePath: `.github/workflows/${contract.slug}.md`,
    intent: { goal: "Append exactly the next nonduplicate Odyssey line to the source-declared target PR branch.",
      acceptance: "Independent, source-bound pre/post target bytes prove one nonduplicate next-line append under a frozen edition/sequence oracle; target identity and branch are preserved.",
      temporalAnchor: "workflow-adoption" },
    adoption: contract.adoption, evaluation: { mode: "attainment-only" },
    evidence: { key: "cross-repo-update-exact-sequential-append-v1",
      repositories: [contract.repository, "github/gh-aw-side-repo", "githubnext/gh-aw-side-repo"],
      opportunity: "An independently bound update attempt on source-declared PR #1; skipped workflow records are not update opportunities.",
      filters: ["Public-only authority; authenticated access is not permission to collect private target content.",
        "Exact immutable source profile determines target; inconsistent namespaces are never silently aliased.",
        "No agent text, issue report, job success, PR state or generic push count establishes the outcome.",
        "An independently known structural append may count as partial progress without asserting the next intended line.",
        "No accepted source-grounded Odyssey edition/sequence oracle exists in the reviewed source closure.",
        "Unknown, absent opportunities and failed native assessments remain distinct."],
      collection: "Offline replay of digest-bound public source profiles and complete retained run metadata. Native target receipts are unavailable under public-only authority.",
      measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Exact-byte append oracle with independent target/branch/source binding and separately unknown semantic sequence acceptance.",
      recommendation: "Blocked, not measured; acquire authorized native target receipts and resolve the source-grounded edition/sequence contract before claiming value.",
      presentation: { label: "Verified sequential append outcomes", betterLabel: "More independently verified next-line appends" } },
    summary: { nativeLabel: "Verified next-line appends (unavailable)" },
    metrics: [
      { id: "sequential-appends", name: "Verified next-line appends", role: "primary",
        formula: "Count independently bound assessments whose exact-byte append equals the frozen next intended line, with no duplicate or prior-byte alteration.",
        direction: "increase", unit: "verified line appends",
        presentation: { name: "Verified sequential appends", legendLabel: "Next-line appends", transform: "identity" } },
      { id: "nonduplicate-line-appends", name: "Verified nonduplicate one-line appends", role: "diagnostic",
        formula: "Count independently bound exact-byte nonduplicate one-line appends, separately from unknown Odyssey sequence acceptance.",
        direction: "increase", unit: "verified line appends",
        presentation: { name: "Structural partial progress", legendLabel: "One-line appends", transform: "identity" } },
    ],
    validationExamples: { targetAttained: example(true), targetMissed: example(false),
      missing: { valid: false }, malformed: { valid: true, assessments: [{ id: "bad", structuralAppend: 1 }] } },
    sourceReview: contract.sourceReview,
    receiptBinding: contract.receiptBinding,
    predecessor: contract.predecessor,
    limitations: contract.limitations,
  };
  return { definition, scoreMetric: crossRepoUpdateScore, collectBatch(requests) {
    const root = path.resolve(import.meta.dirname, "../docs/operational-value/proof/cross-repo-update");
    const source = readJsonArchive(`${root}/sources.json`);
    const acquisition = readJsonArchive(`${root}/acquisition.json`);
    if (objectHash(source) !== contract.sourcesSha256 || objectHash(source) !== acquisition.sourcesSha256
      || acquisition.scope.sourceBlob !== contract.sourceBlob || acquisition.scope.until !== contract.until
      || acquisition.completeness.retainedRunInventory !== true
      || !Array.isArray(acquisition.runs)
      || new Set(acquisition.runs.map(row => row.id)).size !== acquisition.runs.length) {
      throw new Error("Cross-repo update source/evidence integrity mismatch");
    }
    return requests.map(request => {
      if (request.repository && request.repository !== contract.repository) throw new Error("Wrong workflow repository");
      if (![request.windowStart, request.windowEnd, request.observedAt].every(value => typeof value === "string"
        && Number.isFinite(Date.parse(value))) || request.windowStart >= request.windowEnd) throw new Error("Invalid bounded update window");
      const retained = acquisition.runs.filter(row => row.createdAt >= request.windowStart && row.createdAt < request.windowEnd);
      return { evidence: { valid: false, assessments: [], coverageStatus: "missing",
        missingReason: acquisition.missing.join(" "), eligibleCount: null,
        maturityStatus: "unavailable", costs: "not-measured", workflowContribution: null,
        populationDigest: null, retainedRunMetadataCount: retained.length,
        skippedMetadataCount: retained.filter(row => row.conclusion === "skipped").length,
        nativeAssessmentCount: 0, sourceProfiles: contract.sourceReview.profiles.length,
        cutoff: contract.until, latestWindowCovered: request.windowEnd <= contract.until,
        limitations: contract.limitations },
      provenance: [{ repository: contract.repository, kind: "immutable-workflow-source", ref: contract.sourceBlob },
        { repository: contract.repository, kind: "public-source-and-run-inventory", ref: objectHash(acquisition) }],
      commit: contract.revision };
    });
  } };
}
