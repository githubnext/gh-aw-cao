import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const study = {
  repository: "github/gh-aw",
  workflow: "daily-rendering-scripts-verifier",
  sourceRevision: "d3915e4a21040c00a6e11e1acb0aac42605abc4c",
  sourcePath: ".github/workflows/daily-rendering-scripts-verifier.md",
  sourceSha256: "871f680ef11461406c2701813febc76b96b4e4a0e375a7a5b044aad506967f56",
  producerRun: "35497567942",
  inputRun: "35497537350",
  inputArtifact: 10600856995,
  receiptArtifact: 10601673074,
  pullRequest: 62155,
  rule: "An observed provider error must survive normalization and appear in the rendered summary.",
  limitation: "Retrospective, deliberately selected positive case; one observed input is not complete workflow coverage or blinded intent validation.",
};

const example = accepted => ({
  valid: true, coverageStatus: "complete", eligibleCount: 1,
  cases: [{ id: "observed-provider-error", rendered: accepted, normalized: accepted }],
  linkedRepair: accepted,
});
export const definition = {
  schemaVersion: 3, slug: study.workflow, repository: study.repository,
  workflowName: "Daily Rendering Scripts Verifier: observed provider-error preservation",
  sourcePath: study.sourcePath,
  intent: {
    goal: "Correctly parse and render engine output, including provider failures.",
    acceptance: study.rule,
    temporalAnchor: "contract-activation",
  },
  adoption: {
    commit: study.sourceRevision, adoptedAt: "2026-10-18T10:14:01Z",
    baselineCommit: null, baselineAt: null,
  },
  evaluation: { mode: "attainment-only" },
  evidence: {
    key: "observed-provider-error", repositories: [study.repository],
    opportunity: "One fixed, independently acquired provider-error input from run 35497537350; evaluated retrospectively, including before its discovery.",
    filters: [study.rule, "Do not treat this selected case as the workflow's entire opportunity population."],
    collection: "Replay pinned parser code on the preserved minimal real-input projection; correlate only through the verified Actions safe-output receipt.",
    measurementKind: "snapshot",
    window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 },
  },
  model: {
    architecture: "Goal -> real input -> immutable code replay -> independently checked behavior -> safe-output creation receipt -> merged revision -> historical snapshots.",
    recommendation: "Retain native evidence; this selected case establishes a delivered repair, not overall workflow economics.",
    presentation: { label: "Observed error preserved", betterLabel: "higher conformance" },
  },
  summary: { nativeLabel: "Observed provider-error cases faithfully preserved" },
  metrics: [
    {
      id: "conformance", role: "primary", name: "Observed provider-error conformance",
      formula: "100 * cases satisfying both error-preservation checks / eligible observed input cases",
      unit: "percent", direction: "increase",
      presentation: { name: "Observed input conformance", legendLabel: "Input conformance", transform: "identity" },
    },
    {
      id: "linked-repairs", role: "diagnostic", name: "Receipt-linked repairs delivered in the measurement window",
      formula: "1 only when the verified creator receipt matches the PR, its original patch repairs the observed input, the merged revision passes, and merge time is inside this window; otherwise 0",
      unit: "repairs", direction: "increase",
      presentation: { name: "New receipt-linked repairs", legendLabel: "New linked repairs", transform: "identity" },
    },
  ],
  validationExamples: {
    targetAttained: example(true), targetMissed: example(false),
    missing: { valid: false, coverageStatus: "missing" },
    malformed: { valid: true, coverageStatus: "complete", cases: [] },
  },
};

export function scoreMetric(id, evidence) {
  if (evidence?.valid !== true || evidence.coverageStatus !== "complete"
    || !Number.isSafeInteger(evidence.eligibleCount) || evidence.eligibleCount <= 0
    || !Array.isArray(evidence.cases) || evidence.cases.length !== evidence.eligibleCount
    || new Set(evidence.cases.map(item => item.id)).size !== evidence.cases.length
    || evidence.cases.some(item => typeof item.id !== "string" || !item.id
      || typeof item.rendered !== "boolean" || typeof item.normalized !== "boolean")) return null;
  if (id === "conformance") {
    return 100 * evidence.cases.filter(item => item.rendered && item.normalized).length / evidence.eligibleCount;
  }
  if (id === "linked-repairs") return typeof evidence.linkedRepair === "boolean"
    ? Number(evidence.linkedRepair && evidence.cases.every(item => item.rendered && item.normalized)) : null;
  return null;
}

export function collectProof(proof, requests) {
  if (proof.schemaVersion !== 1 || JSON.stringify(proof.study) !== JSON.stringify(study)
    || !Array.isArray(proof.snapshots) || !proof.connection || !proof.input) {
    throw new Error("Proof does not match the frozen real-input study");
  }
  const connection = proof.connection;
  const verified = connection.creatorVerified === true && connection.originalPatchRepairs === true
    && connection.mergedRevisionPasses === true && connection.pullRequest === study.pullRequest
    && connection.producerRun === study.producerRun;
  return requests.map(request => {
    if (request.repository && request.repository.toLowerCase() !== study.repository.toLowerCase()) {
      throw new Error("Requested repository is outside this proof's scope");
    }
    const snapshot = proof.snapshots.find(item => item.endAt === request.windowEnd);
    const provenance = [
      { repository: study.repository, kind: "real-input-proof",
        ref: createHash("sha256").update(JSON.stringify({ ...proof, sourcePartitions: undefined })).digest("hex") },
      { repository: study.repository, kind: "actions-input-artifact",
        ref: `https://github.com/${study.repository}/actions/runs/${study.inputRun}/artifacts/${study.inputArtifact}` },
      { repository: study.repository, kind: "actions-creation-receipt",
        ref: `https://github.com/${study.repository}/actions/runs/${study.producerRun}/artifacts/${study.receiptArtifact}` },
      { repository: study.repository, kind: "merged-repair",
        ref: `https://github.com/${study.repository}/commit/${proof.pullRequest.mergeCommit}` },
    ];
    if (!snapshot) return { evidence: { valid: false, coverageStatus: "missing",
      missingReason: "No immutable code replay acquired for this exact cutoff." }, provenance };
    return {
      evidence: {
        valid: true, coverageStatus: "complete", eligibleCount: 1, maturityStatus: "matured",
        populationDigest: proof.input.projectedSha256,
        cases: [{ id: proof.input.projectedSha256, rendered: snapshot.rendered, normalized: snapshot.normalized }],
        linkedRepair: verified ? snapshot.rendered && snapshot.normalized
          && Date.parse(connection.mergedAt) >= Date.parse(request.windowStart)
          && Date.parse(connection.mergedAt) < Date.parse(request.windowEnd) : null,
        scopeLimitation: study.limitation,
      },
      commit: snapshot.commit, provenance,
    };
  });
}

export async function collectBatch(requests) {
  const { readProof, verifyProof } = await import("../../../scripts/prove-workflow-operational-value.mjs");
  const proof = verifyProof(readProof(fileURLToPath(new URL("../../../docs/operational-value/proof/rendering.json.gz", import.meta.url))));
  return collectProof(proof, requests);
}
