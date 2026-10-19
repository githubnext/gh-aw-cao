import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export const smokeDigest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const smokeCases = {
  "smoke-agy": ["result-schema", "file-read", "inference", "shell-and-environment", "tool-round-trip", "staged-safe-output",
    "native-mcp", "native-infrastructure-mcp", "native-safeoutputs", "inference-accounting"],
  "smoke-aider": ["expected-file-content", "successful-git-log-shell-evidence"],
  "smoke-claude-copilot": ["unpredictable-native-mcp-receipt", "post-tool-inference-echo"],
};
export function smokeRead(file) {
  const bytes = readFileSync(file);
  return JSON.parse((file.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"));
}
export function smokeScore(id, evidence) {
  if (!["proven-behaviors", "full-acceptance"].includes(id) || evidence?.valid !== true
    || !Array.isArray(evidence.assessments) || !evidence.assessments.length
    || new Set(evidence.assessments.map(row => row?.id)).size !== evidence.assessments.length
    || evidence.assessments.some(row => typeof row?.id !== "string" || !row.id
      || !Array.isArray(row.cases) || row.cases.length === 0
      || row.cases.length !== smokeCases[evidence.workflowId]?.length
      || new Set(row.cases.map(item => item?.name)).size !== row.cases.length
      || row.cases.some(item => !smokeCases[evidence.workflowId]?.includes(item?.name)
        || ![true, false, null].includes(item?.passed))
      || ![true, false, null].includes(row.fullAcceptance)
      || (row.fullAcceptance === true && row.cases.some(item => item.passed !== true)))) return null;
  if (id === "full-acceptance") {
    return evidence.acceptanceComplete === true && evidence.assessments.every(row => row.fullAcceptance !== null)
      ? evidence.assessments.filter(row => row.fullAcceptance).length : null;
  }
  const known = evidence.assessments.flatMap(row => row.cases).filter(item => item.passed !== null);
  return known.length ? known.filter(item => item.passed).length : null;
}
export function smokeModule(contract) {
  if (contract.interpreterSha256 !== createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex")) {
    throw new Error("Frozen smoke interpreter changed");
  }
  const { workflowId, repository } = contract;
  const example = passed => ({ valid: true, workflowId, acceptanceComplete: true, assessments: [{ id: "fixture",
    cases: smokeCases[workflowId].map(name => ({ name, passed })), fullAcceptance: passed }] });
  const definition = {
    schemaVersion: 3, slug: workflowId, repository, workflowName: contract.name,
    sourcePath: `.github/workflows/${workflowId}.md`,
    intent: { goal: contract.goal, acceptance: contract.acceptance, temporalAnchor: "workflow-adoption" },
    adoption: contract.adoption, evaluation: { mode: "attainment-only" },
    evidence: { key: "source-verified-smoke-behaviors-v1", repositories: [repository],
      opportunity: "Named source-defined behavioral assertions per independently observed execution attempt.",
      filters: ["Only exact reviewed host checker scripts and protected environments establish behavioral proof.",
        "Run, agent and job success are never behavioral evidence. A failed conjunction has unknown components.",
        "Distinct attempts are repeated monitoring assessments, not unique repository improvements.",
        "Observed native subtotals survive missing attempts; they are not complete workflow-wide totals.",
        "Aider's checker proves two partial facets, not edit method or safe-output publication.",
        "Agy requires its actual specialized native gate separately from the shared conformance gate."],
      collection: "Offline digest-checked replay of bounded immutable-head Actions receipts, reviewed source blobs and trusted mainline lock/runtime trees.",
      measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Source-specific independent host assertions, preserving unknown cases and full acceptance separately.",
      recommendation: "No native keep bar was agreed; not rated. Missing evidence is not failed behavior.",
      presentation: { label: "Observed smoke behavior proofs", betterLabel: "More independently demonstrated behavior" } },
    summary: { nativeLabel: "Independently proven smoke behavioral assertions" },
    metrics: [
      { id: "proven-behaviors", name: "Observed independently proven behaviors", role: "primary",
        formula: "Count named source-defined host behavioral assertions proven true; unknown components stay unknown.",
        direction: "increase", unit: "behavior proofs",
        presentation: { name: "Observed behavioral proofs", legendLabel: "Behavior proofs", transform: "identity" } },
      { id: "full-acceptance", name: "Fully accepted smoke assessments", role: "diagnostic",
        formula: "Count assessments meeting every source-specific goal requirement, only when all acceptance facts are known.",
        direction: "increase", unit: "assessments",
        presentation: { name: "Full source-goal acceptance", legendLabel: "Fully accepted", transform: "identity" } },
    ],
    validationExamples: { targetAttained: example(true), targetMissed: example(false),
      missing: { valid: false }, malformed: { valid: true, workflowId, assessments: [{ id: "bad", cases: [] }] } },
  };
  return { definition, scoreMetric: smokeScore, collectBatch(requests) {
    const root = path.resolve(import.meta.dirname, "../docs/operational-value/proof/smoke-native");
    const index = smokeRead(path.join(root, `${workflowId}-index.json`));
    if (!index.complete || index.contractSha256 !== smokeDigest(contract)) throw new Error("Smoke evidence contract mismatch");
    const rows = index.partitions.flatMap(part => {
      const file = path.join(root, part.file);
      if (path.dirname(file) !== root || smokeDigest(smokeRead(file)) !== part.sha256) throw new Error("Smoke evidence partition mismatch");
      return smokeRead(file);
    });
    if (rows.length !== index.observations) throw new Error("Incomplete smoke partition inventory");
    return requests.map(request => {
      if (request.repository && request.repository !== repository) throw new Error("Smoke repository mismatch");
      const selected = rows.filter(row => row.at >= request.windowStart && row.at < request.windowEnd);
      const assessments = selected.filter(row => row.cases?.some(item => item.passed !== null));
      const valid = request.windowEnd <= contract.until && assessments.length > 0;
      return { evidence: { valid, workflowId,
        acceptanceComplete: selected.length > 0 && selected.every(row => row.fullAcceptance !== null),
        assessments: assessments.map(({ id, cases, fullAcceptance }) => ({ id, cases, fullAcceptance })),
        coverageStatus: selected.length && assessments.length === selected.length ? "complete" : "partial",
        missingReason: valid ? null : "No independently usable behavioral assertion evidence in this period.",
        inventoryAttempts: selected.length, observedAssessments: assessments.length,
        limitations: contract.limitations, costs: "not-measured" },
      provenance: [{ repository, kind: "immutable-workflow-source", ref: contract.sourceGitBlob },
        { repository, kind: "smoke-host-evidence-index", ref: smokeDigest(index) }], commit: contract.sourceRevision };
    });
  } };
}
