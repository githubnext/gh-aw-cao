import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const repository = "github/gh-aw";
const currentProfileAt = "2026-10-18T06:32:44Z";
const sourceBlob = "3471ba651640eddacc0d18bab008bba570a347d6";
const profile = "a07f8145b20b75cccb8c383d408b8cbfafbf0827ecc8328868d9fdcc649c18db";
const text = value => typeof value === "string" && value.trim().length > 0;
const sha = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const iso = value => typeof value === "string"
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)
  && Number.isFinite(Date.parse(value));
const metric = (id, name, role, formula, unit) => ({
  id, name, role, formula, unit, direction: "increase",
  presentation: { name, legendLabel: id === "verified-correct" ? "Verified children" : name, transform: "identity" },
});
const example = (correct, mismatched) => ({
  sourceProfile: profile, eligibleCount: correct + mismatched, correctCount: correct,
  mismatchCount: mismatched, unknownCount: 0, coverageStatus: "complete",
  nativeRecordsPresent: true, classificationScope: "explicit-model-size",
});

export const definition = {
  schemaVersion: 3, slug: "daily-model-resolution", repository,
  workflowName: "Daily Sub-Agent Model Resolution Audit",
  sourcePath: ".github/workflows/daily-model-resolution.md",
  intent: {
    goal: "Verify that dispatched sub-agents receive models of the size declared by their immutable workflow source.",
    acceptance: "Source-bound declarations and independent native child-dispatch identities join uniquely to api-proxy model records; every request of a completed child trace matches the explicit declared size.",
    temporalAnchor: "workflow-adoption",
  },
  adoption: {
    commit: "548c141635dc069a4d17f49f4342859dcc91baf3",
    adoptedAt: "2026-06-24T01:15:59Z",
    baselineCommit: "1b8bc51787713467a966e0c842672fb996763806",
    baselineAt: "2026-06-24T01:07:56Z",
  },
  evaluation: {
    mode: "attainment-only",
    reason: "No comparable baseline has been established. Source history and native reconstruction remain open, not exhausted.",
  },
  sourceProfile: {
    revision: "c86377ec47b38f0b5af463277ee55d1d03d08da8",
    gitBlob: sourceBlob, sha256: profile, validFrom: currentProfileAt,
    scope: "Frozen-current-source explicit-size facet only; never applied before this profile cutoff.",
    sourceReadiness: "current-and-adoption-workflow-imports-reviewed; native-producer-closure-incomplete",
    compiledGitBlob: "fe49cac313067559ff1fd25e10e24d3af8a9587e",
    compiledSha256: "ee00e7482c097be8f2234b47f12dba18f229e9962fb633accb2b3221cb9bf941",
    adoptionSourceGitBlob: "02317ee742842849af4716368c5ac55afdd9cfc6",
    adoptionSourceSha256: "57dbeba422fbc93766b4017afab7e770472ca5f6fc1e301583ba4281ec8f870a",
    adoptionCompiledGitBlob: "01f4d457a15cfa538c22fd505167ede1126809f0",
    adoptionCompiledSha256: "150fcff8eb20b1ce2dcf19c2c6c9f03a8596a120567bb0ee1f4ddeecb609d59d",
    nativeIdentitySource: "686b851c954f7f75d85cf04b1ef44d685f2c6e8d",
    nativeIdentitySha256: "9007a6ae04d5296f11ab388892c1753714c3d0ac6d784a1ab3ac681ab9ffc8a3",
    nativeSpecificationSource: "542c39ef1014387d0d186dc1065f07629c2940c9",
    nativeSpecificationSha256: "9ad62151eb1241157e9dbb33352b1e020b946c0cc272712e9e4a7d307b2479be",
    historicalReadiness: "adoption-addition-and-intent-verified; intermediate-source-era-and-native-history-unknown",
    predecessorFunctionSha256: "24b6e9a21c36cebfa48d41b96fb9f8c5ff992e893227b905a5007bcc673d5b41",
  },
  evidence: {
    key: "daily-model-resolution-current-explicit-size",
    repositories: [repository],
    opportunity: "Actual independently evidenced child invocations in the source-declared bounded analyzed log cohort, not regex-like text or all repository traffic.",
    filters: [
      "Run/attempt/session/agent/tool-call identities must agree across protected dispatch and proxy receipts.",
      "Declaration is bound by a protected source-metadata receipt to the subject workflow at the run's immutable source blob.",
      "small/mini/haiku expect small; large/sonnet/opus expect large; explicit model IDs use /(mini|haiku|flash|nano)/i.",
      "Inherited/unknown declarations remain unknown: the top-level and embedded-analyzer instructions disagree.",
      "A correct child needs a closed independently reconciled request set. Any bound wrong request establishes a mismatch.",
      "No parent traffic substitution, run-success proxy, agent claim, report count or synthetic history.",
    ],
    collection: "One offline read of retained-native.json per batch. A separately approved producer must preserve protected source/dispatch/proxy receipts and complete cohort coverage. No APIs or checkout execution.",
    measurementKind: "interval",
    window: { durationDays: 2, cadenceDays: 2, maturationDays: 0 },
    zeroVsMissing: "No authoritative native cohort is null, not zero. A covered empty cohort has diagnostic zero and undefined share. Partial validated native subtotals survive missing full acceptance.",
    antecedent: "Correct model routing predates the audit; no same-formula baseline has been established and historical reconstruction remains open.",
    sampling: "Source bounds: recent 2-day logs, initial count 30, at most one continuation, at most 20 qualifying runs. A producer must retain selected run identities and actual selection/coverage; no population-wide inference.",
    producerStatus: "not implemented or acquired; normalized receipt boundary is specified, not historical proof",
  },
  model: {
    architecture: "Native alias classifier and independent child-request join; source-scoped offline interval assessment.",
    recommendation: "Not rated: no source-derived keep bar, cost evidence or measured native history.",
    presentation: { label: "Verified model-size routing", betterLabel: "More declared sizes verified" },
  },
  summary: { nativeLabel: "Correct model-size resolution among fully assessed eligible child invocations" },
  metrics: [
    metric("correct-resolution-share", "Correct resolution share", "primary",
      "100 * correctCount / eligibleCount, only for complete nonempty explicit-size cohorts with no unknown invocations", "percent"),
    metric("verified-correct", "Verified correct children", "diagnostic",
      "correctCount; validated observed subtotal even when broader acceptance is unavailable", "child invocations"),
  ],
  limitations: [
    "The native producer and protected receipt decoder are unimplemented; retained evaluation cannot establish accepted outcomes.",
    "The function checks a naming-based explicit-size facet, not capability, task correctness, optimality or complete inherited-model acceptance.",
    "Adoption and frozen compiled sources are retained; intermediate source eras, protected native producer closure and pre-adoption evidence remain unknown. No current predicate is backdated.",
    "Workflow contribution and costs remain separately unknown; no causal credit is inferred from correct runtime behavior.",
  ],
  validationExamples: {
    targetAttained: example(2, 0), targetMissed: example(0, 2),
    missing: {}, malformed: { ...example(2, 0), eligibleCount: -1 },
  },
};

export function classifyExpected(model) {
  if (!text(model)) return null;
  const value = model.toLowerCase();
  if (["inherited", "unknown"].includes(value)) return null;
  if (["small", "mini", "haiku"].includes(value)) return "small";
  if (["large", "sonnet", "opus"].includes(value)) return "large";
  return /(mini|haiku|flash|nano)/i.test(model) ? "small" : "large";
}

// This boundary consumes safe, independently produced receipt projections.
// Its producer must not manufacture these rows from the auditor's report.
export function assessDispatches(records) {
  if (!Array.isArray(records)) throw new Error("Native child records must be an array");
  const seen = new Set();
  let correctCount = 0, mismatchCount = 0, unknownCount = 0;
  for (const row of records) {
    const d = row.dispatch;
    if (!d || ![d.runId, d.attempt, d.sessionId, d.agentId, d.toolCallId, d.parentAgentId].every(text)
      || d.agentId === d.parentAgentId || !iso(d.at)
      || !/^[0-9a-f]{40}$/.test(d.sourceBlob) || !sha(d.receiptSha256)
      || !sha(row.declaration?.receiptSha256)
      || row.declaration.sourceBlob !== d.sourceBlob || row.declaration.agentName !== d.agentName
      || !text(d.agentName)) throw new Error("Invalid native child/source identity");
    const key = JSON.stringify([d.runId, d.attempt, d.sessionId, d.agentId, d.toolCallId]);
    if (seen.has(key)) throw new Error("Duplicate or conflicting child identity");
    seen.add(key);
    const expected = classifyExpected(row.declaration.model);
    if (!Array.isArray(row.proxyRequests)) throw new Error("Missing explicit proxy request set");
    const ids = new Set();
    for (const request of row.proxyRequests) {
      if (!text(request.requestId) || ids.has(request.requestId) || !text(request.model)
        || ["small", "mini", "large", "sonnet", "opus", "haiku", "inherited", "unknown"]
          .includes(request.model.toLowerCase())
        || !sha(request.receiptSha256) || request.receiptSha256 === d.receiptSha256
        || !["runId", "attempt", "sessionId", "agentId", "toolCallId"].every(field => request[field] === d[field])) {
        throw new Error("Ambiguous, duplicate, parent-only or unbound proxy request");
      }
      ids.add(request.requestId);
    }
    if (expected === null || !row.proxyRequests.length) unknownCount++;
    else if (row.proxyRequests.some(request =>
      (/(mini|haiku|flash|nano)/i.test(request.model) ? "small" : "large") !== expected)) mismatchCount++;
    else if (row.requestSetComplete === true && sha(row.completenessReceiptSha256)) correctCount++;
    else unknownCount++;
  }
  return { eligibleCount: records.length, correctCount, mismatchCount, unknownCount };
}

function validCounts(evidence) {
  return evidence?.sourceProfile === profile && evidence.nativeRecordsPresent === true
    && evidence.classificationScope === "explicit-model-size"
    && ["complete", "partial"].includes(evidence.coverageStatus)
    && ["eligibleCount", "correctCount", "mismatchCount", "unknownCount"]
      .every(field => Number.isSafeInteger(evidence[field]) && evidence[field] >= 0)
    && evidence.correctCount + evidence.mismatchCount + evidence.unknownCount === evidence.eligibleCount;
}

export function scoreMetric(id, evidence) {
  if (!definition.metrics.some(metric => metric.id === id)) throw new Error(`Unknown metric: ${id}`);
  if (!validCounts(evidence)) return null;
  if (id === "verified-correct") return evidence.correctCount;
  if (evidence.coverageStatus !== "complete" || evidence.unknownCount > 0 || evidence.eligibleCount === 0) return null;
  return 100 * evidence.correctCount / evidence.eligibleCount;
}

export async function collectBatch(requests) {
  if (!Array.isArray(requests)) throw new Error("Requests must be an array");
  const file = new URL("../daily-model-resolution/retained-native.json", import.meta.url);
  const bytes = readFileSync(file);
  const retained = JSON.parse(bytes);
  if (retained.schemaVersion !== 1 || retained.sourceProfile !== profile
    || !Array.isArray(retained.records) || !Array.isArray(retained.coverage)) throw new Error("Invalid retained native archive");
  // No producer is released: accepting caller-authored projections would turn
  // assertion-shaped records into evidence. Fail closed until that boundary exists.
  if (retained.records.length || retained.coverage.length) throw new Error("Native producer/receipt decoder has not been approved or implemented");
  const archiveSha256 = createHash("sha256").update(bytes).digest("hex");
  return requests.map(request => {
    if (request.repository && request.repository.toLowerCase() !== repository.toLowerCase()
      || ![request.windowStart, request.windowEnd, request.observedAt].every(iso)
      || Date.parse(request.windowStart) >= Date.parse(request.windowEnd)
      || Date.parse(request.observedAt) < Date.parse(request.windowEnd)) throw new Error("Invalid observation request");
    const historical = Date.parse(request.windowStart) < Date.parse(currentProfileAt);
    return {
      evidence: {
        sourceProfile: profile, classificationScope: "explicit-model-size",
        ...definition.evidence, windowStart: request.windowStart, windowEnd: request.windowEnd,
        observedAt: request.observedAt, coverageStatus: "missing", maturityStatus: "unavailable",
        nativeRecordsPresent: false, eligibleCount: null, correctCount: null,
        mismatchCount: null, unknownCount: null, populationDigest: null,
        workflowContribution: null, costs: null, fullGoalAcceptance: null,
        missingReason: historical
          ? "Historical source era is unverified; current-source predicates are not backdated. No accepted native dispatch/proxy cohort is retained."
          : "No accepted native dispatch/proxy cohort is retained; protected native producer/receipt decoder remains unimplemented.",
      },
      provenance: [
        { repository, kind: "immutable-intent-source", ref: `git-blob:${sourceBlob};sha256:${profile}` },
        { repository, kind: "retained-native-inventory", ref: `sha256:${archiveSha256}` },
      ],
    };
  });
}
