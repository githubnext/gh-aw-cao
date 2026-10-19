import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";

export const reusableArtifactPaths = {
  directory: "docs/operational-value/proof/reusable-artifact",
  contract: "docs/operational-value/proof/reusable-artifact/contract.json",
  index: "docs/operational-value/proof/reusable-artifact/index.json",
};
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function assessReusableArtifacts(row) {
  if (!row || !Array.isArray(row.invocations) || row.invocations.length !== 3
    || new Set(row.invocations.map(item => item.caller)).size !== 3
    || !["task-a", "task-b", "task-c"].every(id => row.invocations.some(item => item.caller === id))) return null;
  if (!row.sourceBound || !row.inventoryComplete) return null;
  const prefixes = row.invocations.map(item => item.prefix);
  if (prefixes.some(prefix => typeof prefix !== "string" || !/^[a-f0-9]{8}-$/.test(prefix))) return null;
  if (new Set(prefixes).size !== 3) return false;
  const ids = new Set(), names = new Set();
  for (const invocation of row.invocations) {
    if (invocation.payloadCorrect === false || invocation.consumerCorrect === false) return false;
    if (invocation.payloadCorrect !== true || invocation.consumerCorrect !== true
      || !Array.isArray(invocation.artifacts) || invocation.artifacts.length < 2) return null;
    for (const kind of ["activation", "agent"]) {
      const artifacts = invocation.artifacts.filter(artifact => artifact.name === `${invocation.prefix}${kind}`);
      if (artifacts.length !== 1) return artifacts.length > 1 ? false : null;
      const artifact = artifacts[0];
      if (!Number.isSafeInteger(artifact.id) || artifact.id <= 0
        || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)
        || artifact.archiveSha256 !== artifact.digest.slice(7)
        || artifact.runId !== row.runId || artifact.headSha !== row.headSha) return null;
      if (ids.has(artifact.id) || names.has(artifact.name)) return false;
      ids.add(artifact.id);
      names.add(artifact.name);
    }
    if (!/^[a-f0-9]{64}$/.test(invocation.payloadReceiptSha256 ?? "")
      || !/^[a-f0-9]{64}$/.test(invocation.consumerReceiptSha256 ?? "")) return null;
  }
  return true;
}

export function scoreReusableArtifacts(id, evidence) {
  if (!["verified-scenarios", "complete-scenarios"].includes(id)
    || evidence?.valid !== true || !Array.isArray(evidence.assessments)
    || !evidence.assessments.length
    || evidence.assessments.some(row => !Number.isSafeInteger(row.id)
      || ![true, false, null].includes(row.attained))
    || new Set(evidence.assessments.map(row => row.id)).size !== evidence.assessments.length) return null;
  const known = evidence.assessments.filter(row => row.attained !== null);
  if (!known.length || (id === "complete-scenarios" && known.length !== evidence.assessments.length)) return null;
  return known.filter(row => row.attained).length;
}

export function reusableArtifactModule(contract) {
  if (sha256(readFileSync(import.meta.filename)) !== contract.interpreterSha256) {
    throw new Error("Frozen reusable-artifact interpreter changed");
  }
  const example = count => ({ valid: true, assessments: Array.from({ length: count }, (_, id) => ({ id, attained: true })) });
  const definition = {
    schemaVersion: 3, slug: contract.workflowId, repository: contract.repository,
    workflowName: "Smoke Workflow Call with Inputs", sourcePath: contract.sourcePath,
    intent: { goal: contract.goal, acceptance: contract.acceptance, temporalAnchor: "workflow-adoption" },
    adoption: contract.adoption, evaluation: { mode: "attainment-only" },
    evidence: { key: "reusable-artifact-isolation-v1", repositories: [contract.repository],
      opportunity: "Every original smoke-multi-caller execution attempt invoking task-a, task-b concurrently and task-c sequentially against the assigned reusable workflow.",
      filters: contract.filters, collection: "Offline replay of complete Actions discovery, source-bound caller/callee jobs, provider artifact digests and input-correlated payload/consumer receipts.",
      measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Independent artifact identity/content and protected consumer verification; missing payloads remain unknown.",
      recommendation: "Do not claim collision safety, trends or retention decisions from successful jobs or artifact counts.",
      presentation: { label: "Verified isolated caller scenarios", betterLabel: "More independently verified scenarios" } },
    summary: { nativeLabel: "Verified isolated caller scenarios" },
    metrics: [
      { id: "verified-scenarios", name: "Verified isolated caller scenarios", role: "primary",
        formula: "Count source-bound three-caller scenarios with distinct input-correlated artifact identities, correct payloads and protected consumer readback.",
        direction: "increase", unit: "verified scenarios",
        presentation: { name: "Verified isolated caller scenarios", legendLabel: "Verified scenarios", transform: "identity" } },
      { id: "complete-scenarios", name: "Complete isolated caller scenarios", role: "diagnostic",
        formula: "The same native count only if every eligible scenario in the period has accepted positive or negative evidence.",
        direction: "increase", unit: "verified scenarios",
        presentation: { name: "Complete isolated caller scenarios", legendLabel: "Complete scenarios", transform: "identity" } },
    ],
    validationExamples: { targetAttained: example(2), targetMissed: example(1),
      missing: { valid: false }, malformed: { valid: true, assessments: [{ id: 1, attained: "success" }] } },
  };
  return { definition, scoreMetric: scoreReusableArtifacts, collectBatch(requests) {
    const index = readCensusJson(reusableArtifactPaths.index);
    if (!index.complete || index.contractSha256 !== censusDigest(contract)) throw new Error("Reusable artifact evidence index mismatch");
    const rows = readCensusJson(`${reusableArtifactPaths.directory}/observations.json.gz`);
    if (rows.length !== index.observations || censusDigest(rows) !== index.observationsSha256) throw new Error("Reusable artifact observations changed");
    return requests.map(request => {
      if (request.repository && request.repository !== contract.repository) throw new Error("Reusable artifact repository mismatch");
      if (!Number.isFinite(Date.parse(request.windowStart)) || !Number.isFinite(Date.parse(request.windowEnd))
        || request.windowStart >= request.windowEnd) throw new Error("Invalid reusable artifact observation window");
      const selected = rows.filter(row => row.at >= request.windowStart && row.at < request.windowEnd);
      const assessments = selected.filter(row => row.eligible !== false)
        .map(row => ({ id: row.runId, attained: assessReusableArtifacts(row) }));
      const known = assessments.filter(row => row.attained !== null).length;
      return { evidence: { valid: request.windowEnd <= contract.until && assessments.length > 0,
        assessments, eligibleCount: assessments.length, populationDigest: censusDigest(assessments.map(row => row.id)),
        coverageStatus: !assessments.length ? "missing" : known === assessments.length ? "complete" : known ? "partial" : "unknown",
        missingReason: !assessments.length ? "No eligible source-defined multi-caller scenario in this period; this is not successful attainment."
          : known === assessments.length ? null : "Input-correlated artifact payloads, provider digests or protected consumer readback unavailable.",
        acquiredScenarios: selected.length, unresolvedScenarios: assessments.length - known,
        costs: "not-measured", soleAttribution: "not-measured", limitations: contract.limitations },
      provenance: [{ repository: contract.repository, kind: "immutable-workflow-source", ref: contract.sourceGitBlob },
        { repository: contract.repository, kind: "reusable-artifact-isolation-index", ref: censusDigest(index) }],
      commit: contract.sourceRevision };
    });
  } };
}
