import { readFileSync } from "node:fs";
import path from "node:path";
import {
  digest, interpreterSha256, interpretRawProbe, productionAssessment, proofDirectory,
  readAdmittedNativeReceipts, measureNativeReceipts,
} from "../../../../scripts/native-smoke-copilot-sdk.mjs";

const pins = {
  interpreter: "8a93f1b10c495dc44d54acfa764ff0c05181c199d0392aa7a216002ca4195317",
  acceptance: "e2d612e2cc6d2e35ec4ad4fe5da628be15adb4427e5eb3f9701cd943084e45d0",
  source: "b09d0b9c08229f625f2cd90ea5da7c0f98d4ad58d45ca959f91f4f098c10de16",
  discovery: "b75280a6bd521ede68c771fa4dac364ebb25aa40eaf6968dc7a4af4f9ce11a26",
  compiled: "a705a2f3d20873719e89ef81774fa56f4154b55a17b2f1e2bcb83504a1ee4fab",
  candidate: "ffbb8cd2973b4169eb23473d75ec8fc964c7495accb40fa967c8dba467b50384",
  adoption: "0531d1ee819a211e6a5eb2266d93c5617a0e92fdbfba6b555634785f76382096",
  runCompiled: "ee0bb52de522533b7958bbfe37224bb0d1ff25e2f6f4808b8d9718c2b211c065",
  host: "1b9132467abefee8e09de8c00dc1e977f26405cf0ad56e72f13887e6ecb78971",
};
const encode = value => Buffer.from(value).toString("base64");
const file = "/tmp/gh-aw/agent/smoke-copilot-sdk-1.txt";
const content = "Copilot SDK smoke test passed at independently-unresolved-clock-text\n";
function fixture(success) {
  return {
    kind: "validation-only-not-production", raw: {
      runId: 1, deliveredAt: "2026-10-19T11:13:03Z",
      fileBefore: { path: file, exists: false },
      fileAfter: { path: file, kind: "regular", bytesBase64: encode(success ? content : "incorrect\n") },
      cat: { argv: ["cat", file], exitCode: 0, stdoutBase64: encode(success ? content : "incorrect\n") },
      bash: { program: "/bin/bash", argv: ["-c", "echo $((6 * 7))"],
        exitCode: 0, stdoutBase64: encode(success ? "42\n" : "41\n") },
    },
  };
}
const examples = { targetAttained: fixture(true), targetMissed: fixture(false), missing: {}, malformed: { raw: "invalid" } };
const metric = (id, name, role, formula, unit) => ({
  id, name, role, formula, unit, direction: "increase",
  presentation: { name, legendLabel: id, transform: "identity" },
});

export const definition = {
  schemaVersion: 3, slug: "smoke-copilot-sdk", repository: "github/gh-aw",
  workflowName: "Smoke Copilot SDK", sourcePath: ".github/workflows/smoke-copilot-sdk.md",
  intent: {
    goal: "Verify SDK file writing/read-back and shell calculation capabilities.",
    acceptance: "Protected independent native file and process observations establish source-prescribed effects. Partial byte/operation facets, full task conjunction, required issue reporting and SDK contribution are separate.",
    temporalAnchor: "workflow-adoption",
  },
  adoption: { commit: "bb8c9da4da014da05cecdea2e148eb596b50b7b2", adoptedAt: "2026-02-14T17:16:36Z",
    baselineCommit: null, baselineAt: null },
  instrumentAuthoredAt: "2026-10-19T11:13:02Z",
  historicalContext: {
    workflowAdoption: "source-and-real-parent-verified", sourceApplicability: "exact-2026-10-17-run-profile-only",
    reason: "Actual introduction Markdown/compiled originals and real-parent addition establish adoption, not applicability of the later goal. Introduction tested repository analysis/issue/label/comment work. Only the October17 run has verified matching file/readback/arithmetic source/import/SDK capture originals; every other era remains unknown.",
    frozenCutoff: "2026-10-18T15:00:12Z",
    predecessor: "predecessor-v1.json.gz retains the complete prior instrument, actual frozen standard rejection and prospective null report; no historical activation date was invented.",
  },
  evaluation: { mode: "attainment-only" },
  evidence: {
    key: "github-gh-aw-smoke-copilot-sdk-protected-native-effects",
    repositories: ["github/gh-aw"],
    opportunity: "Source-prescribed, independently identified run-specific file/readback/arithmetic challenge executions, regardless of actor.",
    filters: [
      "Exact source/rule applicability and independently protected host receipt custody are required.",
      "A newly observed file with required content is a narrower facet until current-date/time correctness is established.",
      "No agent claims, caller trust flags, successful jobs or editable issue markers establish effects.",
      "Count operation delivery once in inclusive-start/exclusive-end non-overlapping periods.",
      "Validation examples never enter production collection or reports.",
    ],
    collection: "Offline digest-checked preserved source, complete related discovery, original provider artifact and protected attempt-log archives. One exact run/attempt native operation is admitted for its two independently demonstrated facets only.",
    measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 },
  },
  sourceIdentity: {
    repositoryId: 1036865607, revision: "c86377ec47b38f0b5af463277ee55d1d03d08da8",
    workflowBlob: "baf972d19ce8044f2c3b4eecf127aa0ab7db74ec", pins,
    nativeAdmission: "Run38984382289 attempt1: protected provider host log lines2058/2062 corroborate original SDK native events in agent step30, with exact contemporaneous compiled/driver/session source. No caller-provided receipt or synthetic digest grants acceptance.",
  },
  model: {
    architecture: "Raw native byte/operation interpretation, separately protected custody admission, source/version binding and disjoint delivery periods.",
    recommendation: "Preserve demonstrated partial native effects; keep missing complete-goal, contribution and historical evidence unknown. No agreed native keep bar.",
    presentation: { label: "Independently verified native capability facets", betterLabel: "More demonstrated native facets" },
  },
  summary: { nativeLabel: "Verified native operations per disjoint period; not generic quality or full SDK certification." },
  metrics: [
    metric("native-facets", "Verified native capability facets", "primary",
      "Count independently proven file-content creation, cat phrase-readback and exact bash 6*7 result facets delivered once in the period.", "operations"),
    metric("file-effects", "New files with prescribed content", "diagnostic",
      "Count independent absent-before/regular-file-after observations at the exact run path with prescribed prefix and nonempty date/time text; current clock correctness remains separate.", "files"),
    metric("cat-readbacks", "Native cat phrase readbacks", "diagnostic",
      "Count independently executed cat operations reading the exact run path with exit 0 and stdout containing smoke test passed.", "reads"),
    metric("bash-calculations", "Exact native bash calculations", "diagnostic",
      "Count independently executed native bash echo $((6 * 7)) operations with exit0 and stdout bytes34 32 0a, standalone or as the exact successful chained command's unambiguous final stdout segment.", "calculations"),
  ],
  quality: {
    fullSourceConjunction: "All three full native tasks, including actual file creation/content and current time correctness.",
    fullWorkflowAcceptance: "Full native task conjunction plus required issue reporting; separate from the partial native effects and SDK linkage.",
    repositoryOutcome: "Actor-independent native operation effects; not repository code improvement.",
    contribution: "Separate protected SDK workflow/session linkage required; discovery candidates are insufficient.",
    costs: "not-measured", decision: "not-rated",
  },
  validationExamples: examples,
};

function verifyPins() {
  if (interpreterSha256 !== pins.interpreter) throw new Error("Native interpreter version mismatch");
  for (const [key, fileName] of [
    ["acceptance", "acceptance.json"], ["source", "source.json.gz"], ["discovery", "discovery.json.gz"],
    ["compiled", "compiled-source.json.gz"],
    ["candidate", "candidate-originals.json.gz"],
    ["adoption", "adoption-originals.json.gz"], ["runCompiled", "run-compiled-source.json.gz"],
    ["host", "protected-host-originals.json.gz"],
  ]) {
    if (digest(readFileSync(path.join(proofDirectory, fileName))) !== pins[key]) {
      throw new Error(`Frozen ${key} archive identity mismatch`);
    }
  }
}

const iso = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace(".000Z", "Z") === value;

export async function collectBatch(requests, context = {}) {
  if (!Array.isArray(requests) || requests.some(request => !request || !iso(request.windowStart)
    || !iso(request.windowEnd) || !iso(request.observedAt)
    || request.windowStart >= request.windowEnd || request.observedAt < request.windowEnd
    || request.repository !== undefined && request.repository !== definition.repository)) {
    throw new Error("Invalid bounded native-effect collection request");
  }
  if (Object.keys(context).some(key => !["database"].includes(key))) {
    throw new Error("Caller-provided native evidence or trust flags cannot establish admission");
  }
  verifyPins();
  const assessment = productionAssessment();
  const receipts = readAdmittedNativeReceipts();
  return requests.map(request => {
    const measurement = measureNativeReceipts(receipts, request.windowStart, request.windowEnd);
    const partial = measurement.nativeCapabilityFacets !== null;
    return {
    evidence: {
      ...definition.evidence, kind: "protected-native-production", schemaVersion: 1,
      sourceRevision: definition.sourceIdentity.revision, interpreterSha256: pins.interpreter,
      windowStart: request.windowStart, windowEnd: request.windowEnd, observedAt: request.observedAt,
      coverageStatus: partial ? "partial" : "unknown", maturityStatus: partial ? "matured" : "unavailable", dubious: !partial,
      missingReason: assessment.missingReason,
      eligibleCount: null, populationDigest: null,
      ...measurement, fullSourceConjunction: null, fullWorkflowAcceptance: null, reporting: null,
      repositoryOutcome: partial ? { nativeOperations: measurement.nativeCapabilityFacets, fullGoal: null } : null,
      workflowContribution: partial ? { nativeOperations: measurement.nativeCapabilityFacets,
        runId: assessment.nativeProof.runId, attempt: 1, sourceRevision: assessment.nativeProof.headSha } : null,
      costs: null,
      discovery: { direct: assessment.directCandidates, relatedClosure: assessment.closureCandidates,
        absentReferences: assessment.absentReferences.length, interpretation: "Discovery only, not native acceptance" },
    },
    provenance: [
      { repository: definition.repository, kind: "immutable-workflow-source",
        ref: `${definition.sourceIdentity.revision}:${definition.sourcePath}:${definition.sourceIdentity.workflowBlob}` },
      { repository: definition.repository, kind: "digest-checked-native-source-archive", ref: `sha256:${pins.source}` },
      { repository: definition.repository, kind: "complete-history-related-discovery", ref: `sha256:${pins.discovery}` },
      { repository: "githubnext/gh-aw-cao", kind: "frozen-native-interpreter", ref: `sha256:${pins.interpreter}` },
      { repository: definition.repository, kind: "protected-attempt-log-original", ref: `sha256:${pins.host}` },
      { repository: definition.repository, kind: "contemporaneous-compiled-original", ref: `sha256:${pins.runCompiled}` },
      { repository: definition.repository, kind: "adoption-source-originals-real-parent", ref: `sha256:${pins.adoption}` },
    ],
  }; });
}

export function scoreMetric(id, evidence) {
  if (!definition.metrics.some(metric => metric.id === id)) throw new Error(`Unknown SDK native metric: ${id}`);
  if (evidence?.kind === "protected-native-production") {
    verifyPins();
    if (evidence.sourceRevision !== definition.sourceIdentity.revision || evidence.interpreterSha256 !== pins.interpreter
      || !iso(evidence.windowStart) || !iso(evidence.windowEnd) || evidence.windowStart >= evidence.windowEnd) return null;
    const measured = measureNativeReceipts(readAdmittedNativeReceipts(), evidence.windowStart, evidence.windowEnd);
    if (JSON.stringify(evidence.acceptedReceiptIds) !== JSON.stringify(measured.acceptedReceiptIds)) return null;
    return measured[{
      "native-facets": "nativeCapabilityFacets", "file-effects": "fileEffects",
      "cat-readbacks": "catReadbacks", "bash-calculations": "bashCalculations",
    }[id]];
  }
  // Exact in-module fixtures exercise predicates, not production custody.
  if (evidence !== examples.targetAttained && evidence !== examples.targetMissed) return null;
  const facts = interpretRawProbe(evidence.raw);
  if (!facts) return null;
  const values = {
    "file-effects": facts.fileContentFacet,
    "cat-readbacks": facts.catReadback,
    "bash-calculations": facts.bashCalculation,
  };
  if (id !== "native-facets") return values[id] === null ? null : Number(values[id]);
  return Object.values(values).some(value => value === null) ? null
    : Object.values(values).reduce((sum, value) => sum + Number(value), 0);
}
