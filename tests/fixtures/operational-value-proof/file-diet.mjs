import { fileURLToPath } from "node:url";

export const study = {
  repository: "github/gh-aw", workflow: "daily-file-diet",
  sourceRevision: "d3915e4a21040c00a6e11e1acb0aac42605abc4c",
  sourcePath: ".github/workflows/daily-file-diet.md",
  sourceSha256: "b1b720c25b252e251ce8e5cf11df73b7dd87d93c329a7285c958bb6ab5fe420b",
  threshold: 800, newFileLimit: 500, minimumCoverage: 80,
  since: "2026-09-19T10:16:09Z", until: "2026-10-17T10:16:09Z",
  limitation: "Complete pkg/ production-Go size inventories; bounded exact-workflow issue discovery is not complete attribution or a maintainability/ROI measure.",
};

export const eligiblePath = value => typeof value === "string" && value.startsWith("pkg/")
  && value.endsWith(".go") && !value.endsWith("_test.go");

export function acceptedRefactor(candidate) {
  if (!candidate || candidate.creatorVerified !== true || candidate.historyComplete !== true
    || !Array.isArray(candidate.closingPullRequests)) return null;
  if (candidate.closingPullRequests.length === 0) return false;
  if (candidate.closingPullRequests.length !== 1) return null;
  const pull = candidate.closingPullRequests[0];
  if (!pull || typeof pull.id !== "string" || !pull.id) return null;
  if (pull.mergedAt === null) return false;
  if (typeof pull.mergedAt !== "string" || !Number.isFinite(Date.parse(pull.mergedAt))) return null;
  const gates = candidate.gates;
  if (!gates || ["size", "tests", "lint", "build", "coverage", "publicApi"].some(key => typeof gates[key] !== "boolean")) return null;
  if (typeof candidate.completed !== "boolean" || typeof candidate.merged !== "boolean") return null;
  return candidate.completed && candidate.merged
    && ["size", "tests", "lint", "build", "coverage", "publicApi"].every(key => gates[key]);
}

const example = healthy => ({
  valid: true, coverageStatus: "complete", eligibleCount: 1,
  lineCounts: [healthy ? 799 : 800],
  acceptedRefactors: healthy ? 1 : 0, correctIssues: healthy ? 1 : 0,
});
export const definition = {
  schemaVersion: 3, slug: study.workflow, repository: study.repository, workflowName: "Daily File Diet",
  sourcePath: study.sourcePath,
  intent: {
    goal: "Identify oversized production Go files and promote behavior-preserving decomposition.",
    acceptance: "Count the source-defined 800+ line condition independently; credit a linked refactor only after completed/merged, under-500 new files, tests, lint, build, >=80% new-file coverage and unchanged public API are established.",
    temporalAnchor: "contract-activation",
  },
  adoption: { commit: study.sourceRevision, adoptedAt: "2026-10-18T11:03:58Z", baselineCommit: null, baselineAt: null },
  evaluation: { mode: "attainment-only" },
  evidence: {
    key: "file-diet-production-go", repositories: [study.repository],
    opportunity: "All regular non-test .go files under pkg/ in each immutable revision; linked-refactor diagnostics cover only the declared exact-workflow issue cohort.",
    filters: ["wc -l newline semantics", "800 lines is already oversized", "Generated Go files are not silently excluded"],
    collection: "Complete Git tree inventories and independently cross-checked blob newline counts; verified Actions issue receipts and complete explicit closing relationships.",
    measurementKind: "snapshot", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 },
  },
  model: {
    architecture: "Workflow intent -> complete Git inventory -> native structural condition -> receipt-linked issue -> explicit completed refactor and independent safeguards.",
    recommendation: "Do not equate valid suggestions, closed issues or a lower size count with accepted behavior-preserving refactors.",
    presentation: { label: "Oversized production Go files", betterLabel: "fewer oversized files" },
  },
  summary: { nativeLabel: "Production Go files at or above 800 lines" },
  metrics: [
    { id: "oversized", name: "Production Go files with at least 800 lines", role: "primary",
      formula: "count distinct regular pkg/**/*.go paths excluding *_test.go with wc -l >= 800",
      unit: "files", direction: "decrease",
      presentation: { name: "Oversized production files", legendLabel: "Oversized files", transform: "identity" } },
    { id: "accepted-refactors", name: "New accepted receipt-linked refactors in this window", role: "diagnostic",
      formula: "count explicitly completed merged refactors satisfying all frozen safeguards; unknown identity, graph coverage or required checks yields null",
      unit: "refactors", direction: "increase",
      presentation: { name: "Accepted linked refactors", legendLabel: "Accepted refactors", transform: "identity" } },
    { id: "correct-issues", name: "New receipt-linked issues correctly targeting a largest oversized file", role: "diagnostic",
      formula: "count new verified create_issue receipts whose target exists, is at least 800 lines and has the maximum source-revision line count; a precursor, not accepted refactoring",
      unit: "issues", direction: "increase",
      presentation: { name: "Correctly targeted issues", legendLabel: "Correct target issues", transform: "identity" } },
  ],
  validationExamples: {
    targetAttained: example(true), targetMissed: example(false),
    missing: { valid: false, coverageStatus: "missing" },
    malformed: { valid: true, coverageStatus: "complete", eligibleCount: 1, lineCounts: [] },
  },
};

export function scoreMetric(id, evidence) {
  if (evidence?.valid !== true || evidence.coverageStatus !== "complete"
    || !Number.isSafeInteger(evidence.eligibleCount) || evidence.eligibleCount < 0
    || !Array.isArray(evidence.lineCounts) || evidence.lineCounts.length !== evidence.eligibleCount
    || evidence.lineCounts.some(value => !Number.isSafeInteger(value) || value < 0)) return null;
  if (id === "oversized") return evidence.lineCounts.filter(value => value >= study.threshold).length;
  const value = id === "accepted-refactors" ? evidence.acceptedRefactors
    : id === "correct-issues" ? evidence.correctIssues : null;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function collectProof(proof, requests) {
  return requests.map(request => {
    if (request.repository && request.repository.toLowerCase() !== study.repository.toLowerCase()) throw new Error("Repository outside File Diet scope");
    const snapshot = proof.snapshots.find(item => item.endAt === request.windowEnd);
    const provenance = [{ repository: study.repository, kind: "immutable-git-inventory",
      ref: snapshot ? `https://github.com/${study.repository}/tree/${snapshot.commit}/pkg` : study.sourceRevision }];
    if (!snapshot) return { evidence: { valid: false, coverageStatus: "missing",
      missingReason: "No complete inventory acquired for this exact cutoff." }, provenance };
    const candidates = proof.candidates.filter(item => item.closingPullRequests.some(pr =>
      Date.parse(pr.mergedAt) >= Date.parse(request.windowStart) && Date.parse(pr.mergedAt) < Date.parse(request.windowEnd)));
    const decisions = candidates.map(acceptedRefactor);
    const complete = proof.discovery.complete && proof.candidates.every(item => item.historyComplete
      && item.graph.closingLinksComplete && item.creatorVerified);
    const newIssues = proof.candidates.filter(item => Date.parse(item.createdAt) >= Date.parse(request.windowStart)
      && Date.parse(item.createdAt) < Date.parse(request.windowEnd));
    return {
      evidence: {
        valid: true, coverageStatus: "complete", maturityStatus: "matured",
        eligibleCount: snapshot.files.length, populationDigest: snapshot.inventoryDigest,
        lineCounts: snapshot.files.map(item => item.lines),
        acceptedRefactors: complete && decisions.every(value => value !== null)
          ? new Set(candidates.filter((_, index) => decisions[index])
            .map(item => `${item.closingPullRequests[0].id}:${item.targetPath}`)).size : null,
        correctIssues: complete ? newIssues.filter(item => item.correctTarget).length : null,
        scopeLimitation: study.limitation,
      },
      commit: snapshot.commit, provenance,
    };
  });
}

export async function collectBatch(requests) {
  const { readProof, verifyProof } = await import("../../../scripts/prove-file-diet-operational-value.mjs");
  const proof = verifyProof(readProof(fileURLToPath(new URL("../../../docs/operational-value/proof/file-diet.json.gz", import.meta.url))));
  return collectProof(proof, requests);
}
