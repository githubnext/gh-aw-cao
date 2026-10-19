import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { aggregateAttempts, hashBytes, readRetainedAttempts, verifyLineage } from "../../../../scripts/native-smoke-drive.mjs";

const directory = fileURLToPath(new URL("../smoke-drive/", import.meta.url));
const frozenFiles = {
  acceptance: "59439d5a0302664da932f0ad7d3e152d22aa2210e7948cc0b8ab006e579c4672",
  lineage: "83a4adf8f8ff1bb3a05208d14853a161fa029e387f75c1608a66cbdf2afd10fc",
  nativeOracle: "c02551e9330c785538ff827d5b4099d83afa553ed1c1e211011547dd787b2abf",
};
for (const [file, digest] of [
  [path.join(directory, "acceptance.json"), frozenFiles.acceptance],
  [path.join(directory, "lineage.json"), frozenFiles.lineage],
  [fileURLToPath(new URL("../../../../scripts/native-smoke-drive.mjs", import.meta.url)), frozenFiles.nativeOracle],
]) {
  if (hashBytes(readFileSync(file)) !== digest) throw new Error("Frozen native contract dependency changed; create a reviewed new function version");
}
const acceptance = JSON.parse(readFileSync(path.join(directory, "acceptance.json")));
const lineage = verifyLineage(JSON.parse(readFileSync(path.join(directory, "lineage.json"))));
const metric = (id, name, role, field) => ({
  id, name, role, field,
  formula: `Count distinct attempt identities with independently accepted ${field}; null when no dependent claim is assessed.`,
  direction: "increase", unit: "accepted cases",
  presentation: { name, legendLabel: name, transform: "identity" },
});
const metrics = [
  metric("same-run", "Exact same-run readbacks", "primary", "sameRunReadbacks"),
  metric("persistence", "Restored transitions", "diagnostic", "restoredTransitions"),
  metric("repository-access", "Native git-log accesses", "diagnostic", "repositoryAccesses"),
  metric("full-goal", "Full-goal cases", "diagnostic", "fullGoalAttainments"),
];
const example = count => ({ key: "smoke-drive/native-v1", valid: true,
  sameRunReadbacks: count, restoredTransitions: count, repositoryAccesses: count, fullGoalAttainments: count });

export const definition = {
  schemaVersion: 3, slug: "smoke-drive", repository: "github/gh-aw", workflowName: "Smoke Drive",
  sourcePath: ".github/workflows/smoke-drive.md",
  intent: {
    goal: acceptance.intent,
    acceptance: "Exact native write/readback is partial value, distinct from independently restored cross-run bytes and full-goal acceptance.",
    temporalAnchor: "workflow-adoption",
  },
  adoption: {
    commit: lineage.actualAdoption.commit,
    adoptedAt: lineage.actualAdoption.at,
    baselineCommit: lineage.baseline.commit,
    baselineAt: lineage.baseline.at,
  },
  frozenFiles,
  evaluation: { mode: "attainment-only",
    reason: "No comparable pre-adoption memory producer/consumer evidence has been retained. Historical scoring is explicitly retrospective, not ex ante." },
  evidence: {
    key: "smoke-drive/native-v1", repositories: ["github/gh-aw"],
    opportunity: "Distinct source-bound native drive-memory attempts, measured at protected agent-job completion.",
    filters: ["Start inclusive; end exclusive", "Same-source supported execution profiles only",
      "Issue/PR candidates are not accepted outcomes", "Partial cohort counts are not complete period totals"],
    collection: "Offline original provider artifacts, protected attempt logs/jobs, immutable source/compiled blobs and preserved acquisition receipts.",
    measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 },
  },
  model: {
    architecture: "Deterministic native attempt facets, actor-independent acceptance; source-dependent workflow links reported as contribution evidence.",
    recommendation: "Inspect blocked drive authorization before interpreting memory correctness. No keep bar or cost estimate is invented.",
    presentation: { label: "Native drive test attainment", betterLabel: "More independently accepted cases" },
  },
  summary: { nativeLabel: "Accepted native memory cases in retained attempts; partial coverage" },
  metrics,
  validationExamples: { targetAttained: example(1), targetMissed: example(0), missing: {},
    malformed: { ...example(1), sameRunReadbacks: -1, restoredTransitions: -1,
      repositoryAccesses: -1, fullGoalAttainments: -1 } },
  limitations: [
    "Historical case study reconstructed under explicit fixed source-derived acceptance, not an ex-ante historical rule.",
    "No accepted producer/restored-state receipts exist in the selected originals; same-run tests never prove persistence.",
    "Native not-started receipts plus protected failed checkout and skipped execution establish no test execution in those attempts.",
    "The function currently supports the retained source era, not all historical or future workflows.",
    "Costs not measured; keep not rated; no continuous collector or remote memory deployment.",
  ],
};

export async function collectBatch(requests, context = {}) {
  const attempts = readRetainedAttempts(context.evidenceDirectory ?? directory);
  const sourceDigest = hashBytes(readFileSync(path.join(directory, "acceptance.json")));
  return requests.map(request => {
    if (request.repository && request.repository !== definition.repository) throw new Error("Unsupported evidence repository");
    const evidence = { ...aggregateAttempts(attempts, request), key: definition.evidence.key, valid: true,
      repositories: definition.evidence.repositories, opportunity: definition.evidence.opportunity,
      filters: definition.evidence.filters, collection: definition.evidence.collection,
      window: definition.evidence.window, eligibleCount: null, populationDigest: null,
      contractDigest: sourceDigest, maturityStatus: "mature", dubious: true,
      assessmentBasis: "Explicit retrospective source-grounded reconstruction",
      acquisitionIsNotObservationCutoff: true };
    const provenance = [{ repository: definition.repository, kind: "frozen-native-acceptance", ref: `sha256:${sourceDigest}` },
      { repository: definition.repository, kind: "actual-introduction-parent-proof", ref: `sha256:${frozenFiles.lineage}` },
      ...evidence.attempts.flatMap(attempt => attempt.provenance.map(row => ({ repository: definition.repository, ...row })))];
    return { evidence, provenance };
  });
}

export function scoreMetric(id, evidence) {
  const selected = metrics.find(row => row.id === id);
  if (!selected || evidence?.valid !== true || evidence.key !== definition.evidence.key) return null;
  const value = evidence[selected.field];
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
