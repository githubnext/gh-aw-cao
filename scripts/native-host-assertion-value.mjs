import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";

export function scoreHostAssertions(id, evidence) {
  if (!["observed-proofs", "complete-proofs"].includes(id) || evidence?.valid !== true
    || !Array.isArray(evidence.assessments) || !evidence.assessments.length
    || new Set(evidence.assessments.map(row => row?.id)).size !== evidence.assessments.length
    || evidence.assessments.some(row => typeof row?.id !== "string" || !row.id || ![true, null].includes(row.passed))) return null;
  if (!evidence.assessments.some(row => row.passed === true)) return null;
  if (id === "complete-proofs" && evidence.assessments.some(row => row.passed === null)) return null;
  return evidence.assessments.filter(row => row.passed === true).length;
}

export function hostAssertionModule(contract) {
  if (contract.interpreterSha256 !== createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex")) {
    throw new Error("Frozen host assertion interpreter changed");
  }
  const example = count => ({ valid: true, assessments: Array.from({ length: count }, (_, id) => ({ id: String(id), passed: true })) });
  const definition = {
    schemaVersion: 3, slug: contract.workflowId, repository: contract.repository,
    workflowName: contract.name, sourcePath: `.github/workflows/${contract.workflowId}.md`,
    intent: { goal: contract.goal, acceptance: contract.acceptance, temporalAnchor: "workflow-adoption" },
    adoption: contract.adoption, evaluation: { mode: "attainment-only" },
    evidence: { key: "exact-native-host-assertion-v1", repositories: [contract.repository],
      interpreterSha256: contract.interpreterSha256, predicates: contract.gates.map(gate => gate.meaning),
      opportunity: "Initial execution attempts with immutable source-bound native host assertions; reruns do not create duplicate proof.",
      filters: ["Only the exact reviewed protected job, its source-defined assertion steps and transitive local checker dependencies establish proof.",
        "An overall successful run, job, agent reply, issue or unverified artifact does not establish the native predicate.",
        "A failed assertion may reflect missing evidence, infrastructure or unmet preconditions; never infer a failed constituent behavior.",
        "Known native proofs remain visible through incomplete historical coverage; complete totals require every eligible assessment.",
        ...contract.limitations],
      collection: "Replay bounded, digest-checked Actions step receipts, immutable source/dependency identities and verified initial-attempt checkouts.",
      measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Exact native predicate verification on the protected runner, preserving unobserved assessments.",
      recommendation: "Review native proof coverage separately from inferred causation, costs and keep/retire decisions.",
      presentation: { label: contract.metricLabel, betterLabel: "More independently observed native proofs" } },
    summary: { nativeLabel: contract.metricLabel },
    metrics: [
      { id: "observed-proofs", role: "primary", name: contract.metricLabel, unit: contract.unit,
        direction: "increase", formula: "Count initial-run native predicates established by every exact protected host assertion.",
        presentation: { name: contract.metricLabel, legendLabel: "Observed native proofs", transform: "identity" } },
      { id: "complete-proofs", role: "diagnostic", name: "Complete native proof count", unit: contract.unit,
        direction: "increase", formula: "The same count, only when all eligible initial-run predicate assessments are known.",
        presentation: { name: "Complete native proof count", legendLabel: "Complete native proofs", transform: "identity" } },
    ],
    validationExamples: { targetAttained: example(2), targetMissed: example(1),
      missing: { valid: false }, malformed: { valid: true, assessments: [{ id: "bad", passed: "success" }] } },
  };
  return { definition, scoreMetric: scoreHostAssertions, collectBatch(requests) {
    const directory = "docs/operational-value/proof/host-assertions";
    const index = readCensusJson(`${directory}/${contract.workflowId}-index.json`);
    if (!index.complete || index.contractSha256 !== censusDigest(contract)) throw new Error("Host assertion evidence contract mismatch");
    const rows = index.partitions.flatMap(part => {
      if (!/^[a-z0-9-]+-observations-\d{3}\.json\.gz$/.test(part.file)) throw new Error("Unsafe host assertion partition");
      const rows = readCensusJson(`${directory}/${part.file}`);
      if (rows.length !== part.count || censusDigest(rows) !== part.sha256) throw new Error("Host assertion evidence changed");
      return rows;
    });
    if (rows.length !== index.observations) throw new Error("Host assertion inventory is incomplete");
    return requests.map(request => {
      if (request.repository && request.repository !== contract.repository) throw new Error("Host assertion repository mismatch");
      const selected = rows.filter(row => row.at >= request.windowStart && row.at < request.windowEnd);
      const assessments = selected.map(({ id, passed }) => ({ id, passed }));
      const known = assessments.some(row => row.passed === true);
      return { evidence: { valid: known && request.windowEnd <= contract.until, assessments,
        coverageStatus: selected.length && selected.every(row => row.passed === true) ? "complete" : "partial",
        missingReason: known ? null : "No source-bound native host assertion establishes this predicate in the period.",
        observedProofs: assessments.filter(row => row.passed === true).length, inventoryInitialAttempts: selected.length,
        costs: "not-measured", workflowCausation: "not-measured", limitations: contract.limitations },
      provenance: [{ repository: contract.repository, kind: "immutable-workflow-source", ref: contract.sourceGitBlob },
        { repository: contract.repository, kind: "native-host-assertion-index", ref: censusDigest(index) }],
      commit: contract.sourceRevision };
    });
  } };
}
