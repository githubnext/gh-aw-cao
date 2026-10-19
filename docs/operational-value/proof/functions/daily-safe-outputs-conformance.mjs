import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";

const key = "safe-output-independent-native-conformance-v2";
const sha256 = value => createHash("sha256").update(value).digest("hex");
const evidenceUrl = new URL("../daily-safe-outputs-conformance/native-evidence-v2.json.gz", import.meta.url);
const instrumentUrl = new URL("../daily-safe-outputs-conformance/native-checker.mjs", import.meta.url);
const comparatorUrl = new URL("../daily-safe-outputs-conformance/compare-v2.mjs", import.meta.url);
const sourceReviewUrl = new URL("../daily-safe-outputs-conformance/source-review.json", import.meta.url);
const metric = (id, name, role, formula, direction, unit, legendLabel) => ({
  id, name, role, formula, direction, unit,
  presentation: { name, legendLabel, transform: "identity" },
});

export const definition = {
  schemaVersion: 3,
  slug: "daily-safe-outputs-conformance",
  repository: "github/gh-aw",
  workflowName: "Daily Safe Outputs Conformance",
  sourcePath: ".github/workflows/daily-safe-outputs-conformance.md",
  intent: {
    goal: "For repository Safe Outputs implementations, make conformance failures actionable and advance their remediation, independently verified against the native checker and specification.",
    acceptance: "Count only an independently replayed, stable checker predicate on the same surviving file changing from fail to pass across immutable period boundaries without a waiver or eligibility escape. This establishes partial structural improvement, not full behavioral conformance. Full acceptance additionally requires all specification obligations and regression evidence.",
    temporalAnchor: "workflow-adoption",
  },
  adoption: {
    commit: "eac9b15f9c3cc468652ef88dd18194d69e695046",
    adoptedAt: "2026-02-14T18:30:09Z",
    baselineCommit: "5b953fa1ef92edd37b5b8202e827e9fbe159462f",
    baselineAt: "2026-02-14T18:17:28Z",
  },
  evaluation: {
    mode: "attainment-only",
    reason: "Provisional reporting mode, not an endorsed final historical classification: the problem and native condition can predate adoption. A comparable pre-adoption reference has not been established; bounded immutable reconstruction and provider acquisition remain open. This is not a claim that history is unreconstructable or that the phenomenon began at adoption.",
  },
  evidence: {
    key,
    repositories: ["github/gh-aw"],
    opportunity: "Stable native checker condition and affected repository-relative file at both cutoffs; eligible handlers follow the frozen native loop, exclusions and per-check conditions. All 55 rules remain in the evidence ledger; incomplete predicates are not silently complete.",
    filters: [
      "Repository ID 1036865607; source revision c86377ec47b38f0b5af463277ee55d1d03d08da8; exclusive cutoff 2026-10-18T15:00:12Z.",
      "Issues, PR creation, merge alone, expiry closure, agent summaries and successful runs are never accepted conformance or remediation evidence.",
      "Native grep/awk predicates are replayed over immutable source bytes, never by executing fetched application/workflow code.",
      "Suppressed diagnostics remain raw failures; adding an exemption, removing a file, or leaving a rule's eligibility cannot count as remediation.",
      "Both immutable boundaries must contain the same repository-relative file with independently available verified source bytes; creating a previously absent required file cannot count under this surviving-file contract.",
      "The same frozen instrument applies to every observation; changing native source profiles and toolchain are retained as provenance, not interpreted as improved behavior.",
      "Partial positive subtotals survive missing scope; incomplete empty evidence is null, never zero or a clean bill of health.",
    ],
    collection: "One bounded offline producer reads the entire native handler inventory at six immutable weekly cutoffs, reuses blobs, retains lossless source archives, and independently replays declared predicates. The evaluator joins only preserved interval evidence; no API or Git acquisition per requested window. All absent historical periods and graph/check evidence remain explicitly unknown.",
    measurementKind: "interval",
    window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 },
  },
  model: {
    architecture: "Actor-independent native diagnostic-condition remediations in disjoint periods, with outstanding findings and workflow contribution separate. No quality score, weighted severity, invented keep bar or causal attribution.",
    recommendation: "Not rated: no source-derived or agreed keep bar. Investigate remaining native rules, behavioral/regression evidence and workflow contribution before judging the complete goal.",
    presentation: { label: "Independent checker-condition remediations", betterLabel: "More independently cleared conditions" },
  },
  summary: { nativeLabel: "checker conditions cleared per 7-day period" },
  metrics: [
    metric("cleared-findings", "Independently cleared checker conditions", "primary",
      "count(distinct(rule,file,predicate) failing at interval start and passing at interval end under identical frozen predicates, excluding suppression and scope exits); partial positive subtotal, otherwise null when incomplete",
      "increase", "checker conditions", "Cleared conditions"),
    metric("remaining-findings", "Known outstanding checker findings", "diagnostic",
      "count(independently replayed failing unsuppressed native predicates at interval end); positive partial lower bound, otherwise null when incomplete",
      "decrease", "checker findings", "Known findings"),
    metric("linked-remediations", "Demonstrated workflow-linked remediations", "diagnostic",
      "count(distinct accepted native remediations independently joined to workflow lineage); null when graph/receipt evidence is absent",
      "increase", "checker conditions", "Workflow-linked"),
  ],
  signal: { metricId: "cleared-findings", basis: "repository-outcome" },
  sourceAuthority: {
    repositoryId: 1036865607,
    revision: "c86377ec47b38f0b5af463277ee55d1d03d08da8",
    cutoff: "2026-10-18T15:00:12Z",
    workflowBlob: "c6e53bc51866009d78d03b17b7ba371bf9b38ad3",
    nativeCheckerVersion: "1.29.8",
    specificationVersion: "1.29.12",
    instrumentSha256: "c99bd121e341226c7a669fc575a837bbbfb85e358b6f1d0e45402f55fc52e56e",
    comparatorSha256: "071a0ef753d0860471742e11f134f6bdf266e0befeea75a38672b3fb54ff0ee2",
    sourceReviewSha256: "65304d615e83852d735b7a95742aeca59436dbc7074ca0a90d4c199aba37ec34",
  },
  measurementDisposition: {
    primary: "Independent native structural diagnostic clearance, regardless of actor; behavioral conformance remains unknown.",
    diagnostic: "Known outstanding native findings; independently linked workflow contribution when evidence permits.",
    rejected: ["Issues created", "Daily report count", "Issue closure without native acceptance", "Merged PR count without independent before/after verification", "Agent self-assessment", "Successful workflow/checker exit", "Weighted severity score"],
    fullAcceptance: "Unknown until all security, protocol, configuration, content, execution and cache obligations plus protected regression evidence are established.",
    antecedent: "The same code/specification condition and actor-independent remediation can exist without this workflow; no created-at-adoption inference.",
  },
  validationExamples: {
    targetAttained: { key, cleared: ["SEC-003|a|limit"], remaining: 0, linked: ["SEC-003|a|limit"], coverageStatus: "complete" },
    targetMissed: { key, cleared: [], remaining: 2, linked: [], coverageStatus: "complete" },
    missing: { key, cleared: null, remaining: null, linked: null, coverageStatus: "missing" },
    malformed: { key, cleared: ["duplicate", "duplicate"], remaining: -1, linked: [], coverageStatus: "complete" },
  },
};

let archive;
function load() {
  if (archive) return archive;
  const value = readJsonArchive(evidenceUrl.pathname);
  if (value.frozen?.revision !== definition.sourceAuthority.revision
    || value.frozen?.sourceBlob !== definition.sourceAuthority.workflowBlob
    || value.toolchain?.instrumentSha256 !== definition.sourceAuthority.instrumentSha256
    || value.toolchain.instrumentSha256 !== sha256(readFileSync(instrumentUrl))
    || value.toolchain.comparatorSha256 !== definition.sourceAuthority.comparatorSha256
    || value.toolchain.comparatorSha256 !== sha256(readFileSync(comparatorUrl))
    || value.toolchain.sourceReviewSha256 !== definition.sourceAuthority.sourceReviewSha256
    || value.toolchain.sourceReviewSha256 !== sha256(readFileSync(sourceReviewUrl))
    || !Array.isArray(value.snapshots) || !Array.isArray(value.intervals)) {
    throw new Error("Native evidence authority or instrument identity mismatch");
  }
  archive = value;
  return value;
}

function validIds(value) {
  return Array.isArray(value) && value.every(id => typeof id === "string" && id.length > 0)
    && new Set(value).size === value.length;
}

export function scoreMetric(id, evidence) {
  if (!definition.metrics.some(metric => metric.id === id) || evidence?.key !== key
    || !["complete", "partial", "missing"].includes(evidence.coverageStatus)) return null;
  if (evidence.cleared !== null && !validIds(evidence.cleared)
    || evidence.linked !== null && !validIds(evidence.linked)
    || evidence.remaining !== null && (!Number.isSafeInteger(evidence.remaining) || evidence.remaining < 0)) return null;
  const quantity = id === "remaining-findings" ? evidence.remaining
    : (id === "cleared-findings" ? evidence.cleared : evidence.linked)?.length ?? null;
  if (quantity === null || evidence.coverageStatus === "missing"
    || quantity === 0 && evidence.coverageStatus !== "complete") return null;
  return quantity;
}

export async function collectBatch(requests) {
  const value = load();
  return requests.map(request => {
    for (const field of ["windowStart", "windowEnd", "observedAt"]) {
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(request[field] ?? "")
        || !Number.isFinite(Date.parse(request[field]))) throw new Error(`Invalid ${field}`);
    }
    if (Date.parse(request.windowEnd) <= Date.parse(request.windowStart)
      || Date.parse(request.observedAt) < Date.parse(request.windowEnd)
      || request.repository && request.repository.toLowerCase() !== definition.repository.toLowerCase()) {
      throw new Error("Invalid conformance observation scope");
    }
    const interval = value.intervals.find(row =>
      row.windowStart === request.windowStart && row.windowEnd === request.windowEnd);
    const after = interval && value.snapshots.find(row => row.at === interval.windowEnd);
    const available = Boolean(interval && after);
    const evidence = {
      key, measurementKind: "interval",
      windowStart: request.windowStart, windowEnd: request.windowEnd,
      coverageStatus: available ? "partial" : "missing",
      maturityStatus: available ? "mature" : "unavailable",
      cleared: available ? interval.remediated.map(row => row.id) : null,
      remaining: available ? after.assessment.rows.filter(row => row.status === "fail" && !row.suppressed).length : null,
      linked: null,
      eligibleCount: available ? after.assessment.rows.length : null,
      populationDigest: available ? after.populationDigest : null,
      missingReason: available
        ? "Known structural subtotal only; unimplemented native predicates, missing source, behavioral safeguards and workflow lineage remain unknown."
        : "No retained independent native assessment for these exact boundaries; acquisition and historical scope remain open.",
      fullGoalCompletion: null,
      workflowAttribution: "unknown",
      costs: "not-measured",
      ...(available ? { interval, sourceProfile: after.sourceProfile } : {}),
    };
    return {
      evidence,
      provenance: [
        { repository: definition.repository, kind: "immutable-source-authority",
          ref: `https://github.com/github/gh-aw/blob/${definition.sourceAuthority.revision}/${definition.sourcePath}` },
        { repository: definition.repository, kind: "independent-native-instrument-sha256", ref: value.toolchain.instrumentSha256 },
        { repository: definition.repository, kind: "native-evidence-file-sha256", ref: sha256(readFileSync(evidenceUrl)) },
      ],
      ...(available ? { commit: interval.afterCommit } : {}),
    };
  });
}
