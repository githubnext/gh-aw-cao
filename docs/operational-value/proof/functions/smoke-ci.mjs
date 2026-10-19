import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { operationalValuePeriod } from "../../../../.github/skills/add-operational-value/scripts/measurement-period.mjs";
import { evaluateNative, timestamp } from "../../../../scripts/native-smoke-ci.mjs";

const contractUrl = new URL("../smoke-ci/contract-v1.json", import.meta.url);
const contractBytes = readFileSync(contractUrl);
const contractDigest = "cb857b5bf7b395084949fbcc65469ef29e2148bbdadf042cbd093afd919c4e51";
if (createHash("sha256").update(contractBytes).digest("hex") !== contractDigest) {
  throw new Error("Frozen smoke-ci contract integrity mismatch");
}
const contract = JSON.parse(contractBytes);
const nativeOracleDigest = "6df04f8b706aa36766517359e8d10e9aeca2dabbda4b1c2aa429cbb0efdefdf0";
if (createHash("sha256").update(readFileSync(new URL("../../../../scripts/native-smoke-ci.mjs", import.meta.url)))
  .digest("hex") !== nativeOracleDigest) throw new Error("Frozen native oracle integrity mismatch");
const cliContractDigest = "bbeb52aee43ed7a2bb2cb39371ab65d39029b1c1f9692e6f23417dae50ce7daf";
if (createHash("sha256").update(readFileSync(new URL("../smoke-ci/historical-cli-contract-v2.json", import.meta.url)))
  .digest("hex") !== cliContractDigest) throw new Error("Frozen historical CLI contract integrity mismatch");
const postconditionDigest = "1f6f8547a8511cdb899527b05470abdc4dfde8375d2c6c8d4f1478528cfd6866";
if (createHash("sha256").update(readFileSync(new URL("../smoke-ci/persisted-postcondition-contract-v3.json", import.meta.url)))
  .digest("hex") !== postconditionDigest) throw new Error("Frozen native postcondition contract integrity mismatch");
const metric = (id, name, formula, role = "diagnostic", unit = "effects") => ({
  id, name, role, formula, direction: "increase", unit,
  presentation: { name, legendLabel: name, transform: "identity" },
});
export const definition = {
  schemaVersion: 3, slug: "smoke-ci", repository: "github/gh-aw",
  workflowName: "Smoke CI", sourcePath: ".github/workflows/smoke-ci.md",
  intent: {
    goal: contract.goal,
    acceptance: "Retrospective fixed-reference five-sample predicates; primary is explicitly narrower persisted-effect progress, not full semantics.",
    temporalAnchor: "workflow-adoption",
  },
  adoption: {
    commit: "42fe9bee6733515d6e875be9e929d3b9b11126db", adoptedAt: "2026-04-18T11:23:19Z",
    baselineCommit: "a7e0dfb04765978f1048e37339e50462cb1fa612", baselineAt: "2026-04-18T11:12:12Z",
  },
  evaluation: { mode: "attainment-only" },
  nativeOracle: { path: "scripts/native-smoke-ci.mjs", sha256: nativeOracleDigest },
  historicalInterpretation: {
    contractDesign: "Retrospective source-grounded; not ex-ante",
    antecedent: "Safe-output repository effects can exist without this workflow; source introduction is not phenomenon creation.",
    baseline: "No same-formula pre-adoption observation is established; no exhausted-history or adoption-improvement claim.",
    sourceEras: "Actual adoption is independent of reference-profile applicability. Incompatible original agent eras remain visible and unavailable.",
  },
  evidence: {
    key: "smoke-ci-native-effects-v1", repositories: ["github/gh-aw"],
    opportunity: contract.population,
    filters: [
      "Exact source-bound original run attempt and stable target identities",
      "Retrospective reference profile; incompatible source eras are unavailable",
      "No job-success, output-count, fixture or agent-explanation acceptance",
    ],
    collection: "Offline byte/digest-verified original GitHub receipts and persisted state; bounded two-attempt partial population. No API calls or target code execution.",
    measurementKind: "interval", window: { durationDays: 1, cadenceDays: 1, maturationDays: 0 },
  },
  model: {
    architecture: "Source-specific deterministic native oracle; authoring once per frozen contract, routine intake/scoring/rendering without models.",
    recommendation: "Not rated; partial effects do not establish complete safe-output semantics or sole causation.",
    presentation: { label: "Native sample effects", betterLabel: "More verified effects" },
  },
  summary: { nativeLabel: "Independently verified persisted sample effects" },
  metrics: [
    metric("persisted-effects", "Persisted effects", "Number of distinct source-defined sample effects established independently in this interval; unknown population remains partial.", "primary"),
    metric("receipt-linked-effects", "Receipt-linked effects", "Subset of persisted effects linked by original protected processing receipts to this workflow attempt."),
    metric("cli-comments", "Historical CLI comments", "Additive historical partial facet: independently verified exact CLI comment on the original triggering PR. Never relabeled as a five-sample reference effect.", "diagnostic", "comments"),
    metric("message-lines", "Persisted message lines", "Additive v3 native postcondition: unchanged PR comment contains one complete exact source-defined CLI message line; no protected execution/trigger-target claim.", "diagnostic", "message lines"),
  ],
  validationExamples: {
    targetAttained: { persistedEffects: 2, receiptLinkedEffects: 1, cliComments: 1, messageLines: 1, nativeEvidenceValid: true },
    targetMissed: { persistedEffects: 0, receiptLinkedEffects: 0, cliComments: 0, messageLines: 0, nativeEvidenceValid: true },
    missing: { persistedEffects: null, receiptLinkedEffects: null, cliComments: null, messageLines: null },
    malformed: { persistedEffects: "2", receiptLinkedEffects: -1, cliComments: "1", messageLines: "1" },
  },
};

export function scoreMetric(id, evidence) {
  const field = {
    "persisted-effects": "persistedEffects",
    "receipt-linked-effects": "receiptLinkedEffects",
    "cli-comments": "cliComments",
    "message-lines": "messageLines",
  }[id];
  if (!field || evidence?.nativeEvidenceValid !== true
    || ![evidence.persistedEffects, evidence.receiptLinkedEffects, evidence.cliComments ?? null, evidence.messageLines ?? null].every(value =>
      value === null || Number.isSafeInteger(value) && value >= 0)
    || evidence.receiptLinkedEffects > evidence.persistedEffects) return null;
  return evidence[field] ?? null;
}

export async function collectBatch(requests) {
  if (!Array.isArray(requests)) throw new TypeError("Expected production request array");
  const native = evaluateNative();
  return requests.map(request => {
    if (request.repository !== undefined && request.repository.toLowerCase() !== definition.repository) {
      throw new Error("Unsupported repository");
    }
    operationalValuePeriod({ ...request, measurementKind: "interval", coverageStatus: "partial" },
      request.observedAt, "smoke-ci collector");
    if (timestamp(request.observedAt) > timestamp(contract.cutoff)) {
      throw new Error("Requested clock exceeds frozen evidence cutoff");
    }
    const inside = at => timestamp(at) >= timestamp(request.windowStart)
      && timestamp(at) < timestamp(request.windowEnd);
    const events = native.effects.filter(effect => inside(effect.timestamp));
    const samples = events.filter(effect => !effect.profile || effect.profile === "samples");
    const cli = events.filter(effect => effect.profile === "historical-cli-contract-v2");
    const postconditions = events.filter(effect => effect.profile === "persisted-postcondition-contract-v3");
    const hasObservedNativeOpportunity = native.attempts.some(attempt => attempt.profile === "samples"
      && inside(attempt.timestamp)
      && attempt.nativeObservationComplete);
    const hasObservedCliOpportunity = native.attempts.some(attempt => attempt.profile === "historical-cli-contract-v2"
      && inside(attempt.timestamp) && attempt.nativeObservationComplete);
    const sampleAvailable = samples.length > 0 || hasObservedNativeOpportunity;
    const cliAvailable = cli.length > 0 || hasObservedCliOpportunity;
    const available = sampleAvailable || cliAvailable || postconditions.length > 0;
    const selected = native.attempts.filter(attempt => inside(attempt.timestamp));
    return {
      evidence: {
        ...definition.evidence, ...request,
        nativeEvidenceValid: true, coverageStatus: available || selected.length ? "partial" : "missing",
        maturityStatus: available ? "matured" : "unavailable",
        persistedEffects: sampleAvailable ? samples.length : null,
        receiptLinkedEffects: sampleAvailable ? samples.filter(event => event.receiptLinked).length : null,
        cliComments: cliAvailable ? cli.length : null,
        cliReceiptLinkedComments: cliAvailable ? cli.filter(event => event.receiptLinked).length : null,
        messageLines: postconditions.length > 0 ? postconditions.length : null,
        selectedAttemptCount: selected.length,
        nativeAssessments: selected.map(({ effects: _effects, ...assessment }) => assessment),
        completePopulationEligibleCount: null,
        populationScope: "Selected native attempts only, never all discovered issues or all workflow runs",
        fullAcceptance: null, costs: null, decision: "not rated",
        missingReason: available
          ? "Partial bounded acquisition; full semantics and complete period population are not established."
          : "No independently observed applicable native effect/opportunity in this period; missing is not zero.",
        events,
      },
      provenance: [
        { repository: definition.repository, kind: "frozen-retrospective-contract", ref: `sha256:${contractDigest}` },
        { repository: definition.repository, kind: "additive-historical-cli-contract", ref: `sha256:${cliContractDigest}` },
        { repository: definition.repository, kind: "additive-native-postcondition-contract", ref: `sha256:${postconditionDigest}` },
        ...native.provenance,
      ],
    };
  });
}
