import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { smokeToolsContract as contract } from "../../../../scripts/smoke-test-tools-contract.mjs";
import { parseNativeCodexToolLog, parseNativePiToolLog, scoreSmokeTools, verifyNativeToolReceipt } from "../../../../scripts/native-smoke-test-tools.mjs";
import { censusDigest, readCensusJson } from "../../../../scripts/operational-value-census-io.mjs";

const directory = "docs/operational-value/proof/smoke-test-tools";
const sha = filename => createHash("sha256").update(readFileSync(filename)).digest("hex");
const nativeIdentity = {
  contractSha256: "5b56e008445f9b489474379b165e1e9eba34ea286b384cd38e66f6f80ee9133f",
  interpreterSha256: "3c4cca2117fb915762014427bfbbb687dd4b50830302adebf272c366e3d6740e",
  sourceBindingSha256: "4012e35681c110d3822cd25d0d40eb0c2c21167ea872c1999bf32d97a4ec5990",
};
if (censusDigest(contract) !== nativeIdentity.contractSha256
  || sha("scripts/native-smoke-test-tools.mjs") !== nativeIdentity.interpreterSha256
  || sha("scripts/interpret-smoke-test-tools-evidence.mjs") !== nativeIdentity.sourceBindingSha256) {
  throw new Error("Frozen native tool checker changed; define a new function identity before evaluation");
}
const example = count => ({ valid: true, unknownEligibility: 0,
  assessments: Array.from({ length: 2 }, (_, id) => ({ id: String(id), passed: id < count })) });
export const definition = {
  schemaVersion: 3, slug: contract.workflowId, repository: contract.repository,
  workflowName: "Agent Container Smoke Test", sourcePath: ".github/workflows/smoke-test-tools.md",
  intent: { goal: contract.outcome, acceptance: contract.acceptance, temporalAnchor: "workflow-adoption" },
  adoption: contract.adoption, evaluation: { mode: "attainment-only" },
  evidence: { key: "native-container-development-tool-receipts-v2", repositories: [contract.repository],
    predecessorFunctionSha256: "ca063d49e8c8aee6dc914080b84ed0d0c6f2e530ff45911bca9c4b5c4bcc061d",
    ...nativeIdentity, sourceGitBlob: contract.sourceGitBlob, tools: contract.tools, historicalCapability: contract.historicalCapability,
    opportunity: contract.scope, filters: [contract.comparison, contract.metricPolicy, ...contract.limitations],
    collection: "Offline replay of complete retained initial-attempt inventory and digest-checked source-bound native host tool-execution receipts. Unknown history remains null.",
    measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
  model: { architecture: "Independent protected engine transport pairs actual container-side shell commands with native output; twelve tool opportunities per activated initial execution.",
    recommendation: "Inspect missing receipts separately from observed native proof delivery. No keep or retire threshold is established.",
    presentation: { label: "Verified container tool checks", betterLabel: "More independently demonstrated usable tools" } },
  summary: { nativeLabel: "Verified native container tool checks" },
  metrics: [
    { id: "observed-tool-proofs", name: "Observed native container tool proofs", role: "primary",
      formula: "Count distinct (initial run, required tool) opportunities with an independent successful native invocation and valid output; preserve known proofs through gaps.",
      direction: "increase", unit: "tool proofs", presentation: { name: "Observed native container tool proofs", legendLabel: "Observed tool proofs", transform: "identity" } },
    { id: "complete-tool-proofs", name: "Complete native container tool proofs", role: "diagnostic",
      formula: "The same native count only when all eligible tool assessments and eligibility are known.",
      direction: "increase", unit: "tool proofs", presentation: { name: "Complete native container tool proofs", legendLabel: "Complete tool proofs", transform: "identity" } },
  ],
  validationExamples: { targetAttained: example(2), targetMissed: example(1),
    missing: { valid: false }, malformed: { valid: true, assessments: [{ id: "bad", passed: "PASS" }] } },
};
export const scoreMetric = scoreSmokeTools;
export function collectBatch(requests) {
  const index = readCensusJson(`${directory}/index.json`);
  const rows = readCensusJson(`${directory}/observations.json.gz`);
  if (!index.complete || index.contractSha256 !== nativeIdentity.contractSha256
    || index.observationsSha256 !== censusDigest(rows) || rows.length !== index.runs
    || sha(`${directory}/sources.json.gz`) !== index.sourcesSha256
    || sha(`${directory}/runs.json.gz`) !== index.runsSha256
    || sha(`${directory}/source-review.json.gz`) !== index.sourceReviewSha256
    || sha(`${directory}/native-receipts.json.gz`) !== index.nativeReceiptsSha256) throw new Error("Native tool evidence identity or inventory mismatch");
  const originals = readCensusJson(`${directory}/native-receipts.json.gz`);
  const replayed = new Map();
  for (const projection of originals.projections) {
    const parse = projection.engine === "pi" ? parseNativePiToolLog : projection.engine === "codex" ? parseNativeCodexToolLog : null;
    if (!parse || replayed.has(projection.runId) || projection.sourceBound !== true) throw new Error("Invalid native receipt projection");
    const result = parse(projection.nativeLines.join("\n"), projection.step);
    if (censusDigest(result.results) !== projection.resultsSha256) throw new Error("Native receipt replay changed");
    replayed.set(projection.runId, { projection, results: result.results });
  }
  for (const row of rows) for (const receipt of row.nativeProofs) {
    verifyNativeToolReceipt(receipt);
    const replay = replayed.get(row.runId);
    if (!replay || censusDigest(receipt.results) !== censusDigest(replay.results)
      || receipt.logsSha256 !== replay.projection.logsSha256
      || receipt.sourceProfileSha256 !== replay.projection.sourceProfileSha256) throw new Error("Native tool result lacks its original execution receipt");
  }
  return requests.map(request => {
    if (request.repository && request.repository !== contract.repository) throw new Error("Native tool repository mismatch");
    if (![request.windowStart, request.windowEnd, request.observedAt].every(at => typeof at === "string" && Number.isFinite(Date.parse(at)))
      || request.windowStart >= request.windowEnd) throw new Error("Invalid native tool evidence interval");
    const selected = rows.filter(row => row.at >= request.windowStart && row.at < request.windowEnd);
    const eligible = selected.filter(row => row.execution && row.execution.conclusion !== "skipped"
      && row.execution.started_at < request.windowEnd);
    const unknownEligibility = selected.filter(row => row.jobsStatus !== "initial-run-skipped" && !row.jobs?.length).length;
    const assessments = eligible.flatMap(row => contract.tools.map(tool => {
      const native = row.nativeProofs.flatMap(receipt => receipt.results).filter(result => result.toolId === tool.id && result.at < request.windowEnd);
      return { id: `${row.runId}:${tool.id}`, passed: native.some(result => result.passed === true) ? true
        : native.length && native.every(result => result.passed === false) ? false : null };
    }));
    const known = assessments.filter(row => row.passed !== null).length;
    const inScope = request.windowEnd <= contract.until;
    return { evidence: { valid: inScope && known > 0, assessments, unknownEligibility,
      eligibleCount: eligible.length * contract.tools.length,
      populationDigest: censusDigest(eligible.map(row => row.runId)),
      coverageStatus: !inScope || !known ? "missing"
        : unknownEligibility || known !== assessments.length ? "partial" : "complete",
      missingReason: !inScope ? "Requested cutoff exceeds frozen acquisition authority."
        : !known ? "No accepted independent container-side tool invocation receipt in this period; setup, comments and successful runs are not proof." : null,
      inventoryRuns: selected.length, eligibleInitialExecutions: eligible.length,
      knownToolAssessments: known, unknownToolAssessments: assessments.length - known,
      acquisitionComplete: index.acquisitionComplete,
      pendingReceiptAcquisitions: selected.filter(row => row.logStatus === "not-acquired-rate-limited").length,
      historicalProfiles: [...new Set(eligible.flatMap(row => row.nativeProofs.map(receipt => receipt.sourceProfileSha256)))],
      evidenceReady: index.evidenceReady, costs: "not-measured", exclusiveCausation: "not-measured",
      limitations: contract.limitations },
    provenance: [{ repository: contract.repository, kind: "immutable-workflow-source", ref: contract.sourceGitBlob },
      { repository: contract.repository, kind: "native-container-tool-evidence-index", ref: censusDigest(index) }],
    commit: contract.sourceRevision };
  });
}
