import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { assessNativeRepairs, gitBlob, fixtureIssue, sha256 } from "../workflow-normalizer/native.mjs";

const scopeUrl = new URL("../workflow-normalizer/native-scope.json.gz", import.meta.url);
const scopeSha256 = "058930ff8019e97af8da32125c4cf01cdbd711052b8428fb4dddafa57d107de3";
const checkerSha256 = "1091d2b2084676084d5327345a2b9849c6629bcbcb5e388af41217223b9e1fa3";
const codecSha256 = "18045c03ca00fc5f8cccf2a02486255e03a0df22adddf0c426c9182fc6e2554b";
const repository = "github/gh-aw";
const key = "workflow-normalizer-content-preserving-report-style-v1";
const activation = "2026-10-19T10:31:43Z";
const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
const metricId = "native-style-repaired-reports";

const goodBody = "### Summary\n\nReview the failed run.\n\n<details>\n<summary><b>Run details</b></summary>\n\n[§12345](https://github.com/github/gh-aw/actions/runs/12345)\n\n</details>\n\n### Next actions\n\n- [ ] Investigate the failure.\n";
const badBody = goodBody.replaceAll("### ", "# ").replace("<b>Run details</b>", "Run details")
  .replace("[§12345]", "[run 12345]");
const fixture = (before, after) => ({
  key, kind: "validation-fixture-only",
  windowStart: activation, windowEnd: "2026-10-20T10:31:43Z",
  records: [{ editedAt: "2026-10-19T12:00:00Z",
    before: fixtureIssue(before), after: fixtureIssue(after) }],
});
const examples = {
  targetAttained: fixture(badBody, goodBody),
  targetMissed: fixture(goodBody, goodBody),
  missing: { key, coverageStatus: "unknown", missingReason: "unacquired-native-report-history" },
  malformed: { key, before: { body: "# Incorrect native subject" }, accepted: true },
};
const fixtureDigests = [examples.targetAttained, examples.targetMissed]
  .map(example => sha256(JSON.stringify(example)));

export const definition = {
  schemaVersion: 3,
  slug: "workflow-normalizer",
  repository,
  workflowName: "Workflow Normalizer",
  sourcePath: ".github/workflows/workflow-normalizer.md",
  intent: {
    goal: "Active reporting workflows follow project Markdown conventions and produce clear, decision-useful reports with appropriate progressive disclosure.",
    acceptance: "Count content-preserving native report-style repairs only after independent original/revised bytes, edit time and active reporting membership are established. Syntax improvement is partial value, not readability or full goal completion.",
    temporalAnchor: "contract-activation",
  },
  adoption: { commit: revision, adoptedAt: activation, baselineCommit: null, baselineAt: null },
  evaluation: {
    mode: "attainment-only",
    reason: "Prospective current-source instrument. Historical producer evidence is unacquired, not exhausted. This timestamp is not workflow adoption.",
  },
  evidence: {
    key, repositories: [repository],
    opportunity: "A stable, independently identified issue report of a workflow active in the preceding 24 hours with report-producing safe outputs; native body-edit improvements are delivered once in [windowStart,windowEnd). Comments, Discussions and prompt-guidance edits require additional native decoders and are not silently treated as issues.",
    filters: [
      "Current frozen source profile only; do not apply it retrospectively.",
      "Activity membership and original output identity need independent protected producer evidence, not editable tracking markers or agent claims.",
      "Original and changed report bytes must preserve all non-style content and relative heading hierarchy within the closed supported syntax.",
      "Count each underlying report once per interval; repeated references or several repaired facets do not multiply delivery.",
      "No facet may regress; unsupported syntax and unverified edit dates are unknown, not clean.",
      "Actor independent. Full readability and normalizer contribution are separately unknown.",
    ],
    collection: "Offline, digest-checked full immutable source closure plus production readOutputHistory discovery. No native report history or protected active-cohort producer was acquired. No network, source execution or per-window Git acquisition.",
    measurementKind: "interval",
    window: { durationDays: 1, cadenceDays: 1, maturationDays: 0 },
    zeroVersusMissing: "Zero requires complete independently verified cohort and repair histories. Missing original bytes, edit chronology, cohort or producer stays null, including an empty inventory of accepted records.",
  },
  model: {
    architecture: "Native source-defined, content-preserving Markdown style-repair check; immutable evidence seal precedes scoring. No LLM, agent grades, generic quality score or discovery-count proxy.",
    recommendation: "not rated: no keep bar or complete outcome history was supplied",
    presentation: { label: "Demonstrated native style repairs", betterLabel: "More independently verified repairs" },
  },
  summary: { nativeLabel: "Content-preserving style-repaired reports per day" },
  metrics: [{
    id: metricId, name: "Independently verified native style-repaired reports", role: "primary",
    formula: "Distinct eligible native report subjects with a protected, dated, content-preserving before/after repair of at least one supported source-defined style facet and no facet regression in the disjoint period. Unknown producer/cohort/history => null.",
    direction: "increase", unit: "reports",
    presentation: { name: "Native style repairs", legendLabel: "Style-repaired reports", transform: "identity" },
  }],
  nativeContract: {
    scopeSha256, checkerSha256, codecSha256,
    producerSha256: "55dbd3e24bf165601071e8c959978560ef2b72e41ae947cc8590e8c306604e23",
    frozenRepositoryId: 1036865607, revision, cutoff: "2026-10-18T15:00:12Z",
    workflowBlob: "abfac1d367ff164b08c7184ef9b24174373fb91e",
    validationFixtureDigests: fixtureDigests,
    protectedProductionInputs: [],
    partialFacets: [
      "Restore h3-or-lower headers without changing relative heading hierarchy or text.",
      "Bold an existing details summary without changing its words or disclosure contents.",
      "Use [§ID](identical canonical run URL) for the same native run identity without changing other content.",
    ],
    unsupported: [
      "General Markdown/HTML rendering, checkbox repairs, nested disclosure, escaped/reference links, indented code, multiline summaries and malformed syntax are not certified.",
      "No count of headers, suggestions, imports, created issues, merged PRs or successful runs proves readable reports.",
    ],
    fullAcceptance: {
      status: "unknown",
      required: [
        "Complete active reporting population, including missing/malformed logs and count/storage continuation.",
        "All source-native Markdown conventions, including proper checkbox syntax and consistent report structure.",
        "Summary and critical actions remain visible; long detail is appropriately selected and collapsed, with no invented numerical length bar.",
        "Overview, key metrics/issues, detail and next actions are clear and decision-useful; context, trends and recommendations are appropriate.",
        "Actual report content is correct and retained, readable and user-focused; no source-defined deterministic readability rubric or protected full-acceptance producer is available.",
      ],
    },
    readiness: {
      definition: "implemented-current-source",
      checker: "implemented-closed-partial-style-facets",
      nativeProducer: "unacquired",
      productionEvidence: "discovery-only",
      fullAcceptance: "unknown",
    },
    antecedent: "The same repository report-style problems and repairs can exist without this workflow. No historical reconstruction has been exhausted and no adoption comparison is claimed.",
    retainedAndRejected: {
      retainedPartial: "Native style-repaired reports with independent byte, time and population evidence.",
      diagnosticsOnly: "Prompt header_guidelines, progressive_disclosure and report_structure classifications; total workflows reviewed and skipped logs.",
      rejectedPrimary: "Suggestions, style issues opened, issue closure, PR merge, run success and h3/regex counts alone.",
      contribution: "Separate and unknown. Need original workflow receipt or explicit independently verified downstream linkage; no attribution is inferred from discovery markers.",
    },
  },
  validationExamples: examples,
};

function checkedScope() {
  if (sha256(readFileSync(scopeUrl)) !== scopeSha256
    || sha256(readFileSync(new URL("../workflow-normalizer/native.mjs", import.meta.url))) !== checkerSha256
    || sha256(readFileSync(new URL("../../../../.github/skills/add-operational-value/scripts/json-archive.mjs", import.meta.url))) !== codecSha256) {
    throw new Error("Frozen normalizer source/checker/codec identity mismatch");
  }
  const scope = readJsonArchive(fileURLToPath(scopeUrl));
  if (scope.kind !== "workflow-normalizer-native-scope" || scope.schemaVersion !== 1
    || scope.repository !== repository || scope.repositoryId !== 1036865607 || scope.revision !== revision
    || scope.cutoff !== definition.nativeContract.cutoff || scope.activatedAt !== activation
    || scope.sources.length !== 6 || scope.production.coverageStatus !== "unknown"
    || !Array.isArray(scope.production.records) || scope.production.records.length !== 0) {
    throw new Error("Unsupported frozen normalizer evidence scope");
  }
  for (const source of scope.sources) {
    const bytes = Buffer.from(source.content, "base64");
    if (source.encoding !== "base64" || bytes.toString("base64") !== source.content
      || bytes.length !== source.bytes || sha256(bytes) !== source.sha256 || gitBlob(bytes) !== source.gitBlob) {
      throw new Error("Frozen original source bytes are corrupted");
    }
  }
  return scope;
}

const sealedScope = checkedScope();

export function collectBatch(requests, context = {}) {
  if (!Array.isArray(requests) || requests.length > 10000 || !context || typeof context !== "object") {
    throw new Error("Expected a bounded normalizer collection batch");
  }
  const scope = sealedScope;
  const provenance = [
    { repository, kind: "immutable-current-intent-source", ref: `git:${revision}:${definition.sourcePath}#${definition.nativeContract.workflowBlob}` },
    { repository, kind: "retained-source-and-discovery-seal", ref: `sha256:${scopeSha256}` },
    { repository, kind: "verified-output-history-discovery-only", ref: `sha256:${scope.discovery.indexSha256}` },
  ];
  return requests.map(request => {
    if (!request || request.repository !== undefined && request.repository !== repository
      || !["windowStart", "windowEnd", "observedAt"].every(field =>
        typeof request[field] === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(request[field])
        && Number.isFinite(Date.parse(request[field])))
      || Date.parse(request.windowStart) >= Date.parse(request.windowEnd)
      || Date.parse(request.observedAt) < Date.parse(request.windowEnd)) {
      throw new Error("Invalid native normalizer repository/window");
    }
    const historical = Date.parse(request.windowStart) < Date.parse(activation);
    return {
      evidence: {
        ...definition.evidence,
        windowStart: request.windowStart, windowEnd: request.windowEnd, observedAt: request.observedAt,
        scopeSha256, coverageStatus: "unknown", maturityStatus: "unavailable",
        eligibleCount: null, populationDigest: null,
        missingReason: historical ? "current-source-profile-not-a-historical-contract"
          : scope.production.missingReason,
        discovery: { selectedCandidates: scope.discovery.selected.length,
          partitions: scope.discovery.partitions, totalEntities: scope.discovery.totalEntities,
          interpretation: "Discovery only, not eligibleCount, accepted work or contribution" },
        independentNativeFacts: {
          completeOriginalSourceFiles: scope.sources.length,
          reportBodies: "unacquired", activePopulation: "unacquired", nativeEditTimes: "unacquired",
        },
        partialStyleRepairs: null,
        fullAcceptance: { status: "unknown", value: null },
        contribution: { status: "unverified", value: null, originalWorkflow: null, implementer: null },
        requiredInputs: scope.production.requiredInputs,
      },
      provenance,
      commit: revision,
    };
  });
}

export function scoreMetric(id, evidence) {
  if (id !== metricId || !evidence || typeof evidence !== "object" || evidence.key !== key) return null;
  // A digest seal establishes which independently acquired inputs were reviewed;
  // a self-described receipt or hash supplied by the caller establishes nothing.
  // The only report-byte bindings currently available are explicit test fixtures.
  if (evidence.kind !== "validation-fixture-only"
    || !fixtureDigests.includes(sha256(JSON.stringify(evidence)))) return null;
  const result = assessNativeRepairs(evidence.records, evidence.windowStart, evidence.windowEnd);
  return result.unassessedEdits === 0 ? result.demonstratedReports : null;
}
