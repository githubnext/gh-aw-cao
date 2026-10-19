import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { reusableArtifactPaths, sha256 } from "./reusable-artifact-value.mjs";

const { directory } = reusableArtifactPaths;
const contract = readCensusJson(reusableArtifactPaths.contract);
const index = readCensusJson(reusableArtifactPaths.index);
const observations = readCensusJson(`${directory}/observations.json.gz`);
const reportDirectory = existsSync(`${directory}/final-reports`) ? "final-reports" : "reports";
const reportPrefix = `${directory}/${reportDirectory}/github-gh-aw/${contract.workflowId}`;
const timeline = readCensusJson(`${reportPrefix}-timeline.json`);
if (index.contractSha256 !== censusDigest(contract) || index.observationsSha256 !== censusDigest(observations)) {
  throw new Error("Cannot summarize changed reusable-artifact evidence");
}
const closure = readCensusJson(`${directory}/sources.json.gz`);
const helper = closure.find(row => row.path === "actions/setup/sh/compute_artifact_prefix.sh"
  && row.revision === contract.sourceRevision);
const helperBytes = Buffer.from(helper.content, "base64");
if (sha256(helperBytes) !== helper.sha256) throw new Error("Native namespace probe source changed");
const scratch = mkdtempSync(path.resolve(".cache/reusable-artifact-value/probe-"));
try {
  const probes = [];
  for (const [caller, job] of Object.entries(contract.callerJobs)) {
    for (const attempt of [1, 2]) {
      const inputs = Object.fromEntries(Object.entries(contract.declaredInputs).map(([key, value]) => [key, value.default]));
      Object.assign(inputs, job.with);
      const serialization = JSON.stringify(inputs), output = path.join(scratch, `${caller}-${attempt}.txt`);
      execFileSync("bash", ["-s"], { input: helperBytes, timeout: 5000,
        env: { PATH: process.env.PATH, INPUTS_JSON: serialization,
          GITHUB_RUN_ATTEMPT: String(attempt), GITHUB_OUTPUT: output } });
      probes.push({ caller, attempt, inputSha256: sha256(serialization),
        prefix: readFileSync(output, "utf8").trim().replace(/^prefix=/, "") });
    }
  }
  writeCensusJson(`${directory}/native-prefix-probes.json`, { sourceGitBlob: helper.gitBlob,
    sourceSha256: helper.sha256, kind: "synthetic-native-hash-only-probe-not-runtime-attainment",
    inputSerialization: "Explicit synthetic JSON.stringify serialization, not an inferred GitHub toJSON receipt",
    tool: { bash: execFileSync("bash", ["--version"], { encoding: "utf8" }).split("\n")[0],
      sha256sum: execFileSync("sha256sum", ["--version"], { encoding: "utf8" }).split("\n")[0] }, probes });
} finally {
  rmSync(scratch, { recursive: true });
}
const statuses = observations.reduce((counts, row) => {
  const key = row.logProbe?.status ?? "excluded-skipped";
  counts[key] = (counts[key] ?? 0) + 1;
  return counts;
}, {});
const remaining = observations.filter(row => row.logProbe?.status === "not-acquired").map(row => ({
  runId: row.runId, endpoint: `repos/${contract.repository}/actions/runs/${row.runId}/attempts/1/logs`,
}));
writeCensusJson(`${directory}/remaining-requests.json`, {
  repository: contract.repository, until: contract.until, remainingCount: remaining.length,
  reason: remaining.length ? "Temporary shared core API quota exhaustion, not historical evidence unavailability."
    : "All original-attempt candidate log requests have been acquired; unavailable provider responses establish no outcome.",
  requests: remaining, resumeCommand: "node scripts/collect-reusable-artifact-value.mjs BARE_CACHE PRIVATE_API_CACHE collect",
});
const modulePath = `docs/operational-value/proof/functions/${contract.workflowId}.mjs`;
const summary = {
  schemaVersion: 1, workflowId: contract.workflowId, status: "open-blocked", measured: false,
  functionSha256: sha256(readFileSync(modulePath)), interpreterSha256: contract.interpreterSha256,
  receiptPrimitivesSha256: sha256(readFileSync("scripts/reusable-artifact-receipts.mjs")),
  contractSha256: censusDigest(contract), sourceGitBlob: contract.sourceGitBlob,
  sourceRevision: contract.sourceRevision, until: contract.until,
  sourceReview: {
    adoption: contract.adoption,
    findings: [
      "Actual source names a concurrent task-a/task-b plus dependent sequential task-c scenario, with three distinct task-description inputs.",
      "At adoption, only task-description was declared; the current source adds the numeric task-count default of zero. Historical prefixes cannot be computed from current defaults.",
      "The native namespace hashes the exact input serialization plus run attempt. Its fully inspected Bash parameter-default expression appends a literal closing brace for nonempty INPUTS_JSON; tests execute the original helper rather than guessing this preimage.",
      "Initial and current compiled workflows differ in artifact families and consumers. No unreviewed historical source profile is accepted as current.",
      "Noop host handling validates/logs a message but does not independently establish invocation input correctness or artifact isolation.",
      "Current shared aic-usage-scan-v2 telemetry overwrites one unprefixed artifact; it is not evidence of invocation payload isolation.",
      "Source history is retained as exact first-parent identities for the caller, callee and namespace helper; no historical runtime source compatibility was established without retained invocation receipts.",
      "Original Actions referenced_workflows receipts independently identify 2,005 reusable merge-source executions, including 1,137 unresolved candidates, across 1,056 revisions. A PR head SHA is not substituted for that provider-pinned source. Identifying its immutable revision does not itself establish compatible source contents or correct artifacts.",
    ],
  },
  acquisition: { discoveryComplete: index.discoveryComplete, logAcquisitionComplete: index.acquisitionComplete,
    callerRuns: index.callerRuns, directRuns: index.directRuns, originalSkipped: index.excludedScenarios,
    unresolvedCandidates: index.candidateScenarios, knownEligibleScenarios: index.eligibleScenarios,
    unresolvedEligibility: index.unresolvedEligibility, retainedArtifacts: index.retainedArtifacts,
    originalAttemptsWithReusableSourceReceipt: index.originalAttemptsWithReusableSourceReceipt,
    retainedJobRecords: observations.reduce((count, row) => count + (row.jobs?.length ?? 0), 0),
    independentLogProbes: statuses, remainingRequests: remaining.length },
  evaluation: { snapshots: timeline.snapshots.length,
    primaryNonNull: timeline.snapshots.filter(row => row.metrics["verified-scenarios"] !== null).length,
    currentNativeValue: timeline.snapshots.at(-1).metrics["verified-scenarios"],
    actualSignal: "No accepted artifact-isolation observation. Neither successful attainment, failure, zero native value nor a trend is established.",
    decision: timeline.valueReview?.decision ?? null,
    causation: "not-measured", costs: "not-measured" },
  blockers: [
    ...(remaining.length ? ["Resume the exact remaining log requests after the shared quota reset. HTTP 403 is temporary acquisition blockage, never expired evidence."]
      : ["Original-attempt log acquisition is now complete. Provider HTTP 404 responses are retained as missing evidence, not as zero attainment or proof that no invocation existed."]),
    "All 1,524 non-skipped original-attempt candidates have empty provider artifact inventories; contents, provider payload digests and per-invocation names cannot currently be verified.",
    "Only eight unrelated result-check job records are retained, across six runs. Empty/mismatched jobs are missing source-bound execution evidence, not proof that a scenario was ineligible.",
    "Provider-referenced merge-source revisions are preserved, but their full source compatibility plus input/prefix, payload and protected consumer binding remain unverified. The producer has not interpreted a real artifact payload and must not be advertised as a production-ready positive-outcome decoder.",
  ],
  validation: { focusedTests: 9, nativeHashOnlyProbes: 6, collectorVerification: "passed",
    eslint: "passed", caoTypecheck: "passed", strictWorkflowCompile: "72 succeeded, 2 pre-existing action-version warnings" },
  registration: { workflowId: contract.workflowId, function: modulePath,
    contract: reusableArtifactPaths.contract, index: reusableArtifactPaths.index,
    timeline: `${reportPrefix}-timeline.json`, plot: `${reportPrefix}-pulse.html`,
    primaryMetric: "verified-scenarios", provenanceKind: "reusable-artifact-isolation-index",
    evidenceReadinessGuard: "index.discoveryComplete && index.acquisitionComplete && index.outcomeEvidenceReady && timeline.snapshots.some(s => s.metrics['verified-scenarios'] !== null)",
    currentGuard: false, portfolioDisposition: "open-blocked; exclude from measured coverage" },
  skillLessons: [
    "Partition Actions discovery by bounded date ranges below the 1,000-result ceiling, then exhaust every page and reconcile totals.",
    "Retrieve attempt 1 for rerun identities before classifying skipped or executed opportunities.",
    "Empty historical job/artifact inventories are not evidence that no opportunity ever existed; preserve unresolved eligibility separately.",
    "Model native shell serialization exactly with inspected hash-only probes. Input defaults and serialization are source-profile facts, not JSON convenience assumptions.",
    "Coordinate a shared provider quota centrally; persist exact endpoint-to-cache manifests and remaining requests before pausing acquisition.",
    "A gap-only plot and fixture-tested scorer do not establish measurement; require actual receipt readiness and distinguish an unimplemented positive decoder.",
    "Check original-attempt referenced_workflows metadata before declaring reusable PR source identity unavailable. Its immutable merge SHA may differ from head_sha; still verify the actual source profile before accepting outcomes.",
  ],
};
writeCensusJson(`${directory}/review.json`, summary);
console.log(JSON.stringify({ status: summary.status, measured: summary.measured,
  observations: summary.evaluation.snapshots, remainingRequests: remaining.length,
  functionSha256: summary.functionSha256, contractSha256: summary.contractSha256 }));
