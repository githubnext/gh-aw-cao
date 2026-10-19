import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readJson } from "../../../../.github/skills/add-operational-value/scripts/common.mjs";
import { NativeEvidenceError, reconcileInventory } from "../../../../scripts/native-artifacts-summary.mjs";

const contractFile = new URL("../artifacts-summary/contract.json", import.meta.url);
const contractBytes = readFileSync(contractFile);
if (hashBytes(contractBytes) !== "cef35932cf3239d029d089c941221f7fefb64aceac2820f4415ba920f2c1b96b") {
  throw new Error("Frozen artifact contract changed without versioning the module");
}
const contract = JSON.parse(contractBytes);
function hashBytes(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
const hash = hashBytes;
const nativeSha256 = "4b5bd575ae34271249db9609dca9f8ab8e506529473eed46873c4065bee0c689";
if (hash(readFileSync(new URL("../../../../scripts/native-artifacts-summary.mjs", import.meta.url))) !== nativeSha256) {
  throw new Error("Frozen native instrument changed without versioning the module");
}
const contractSha256 = hash(contractBytes);
const repository = contract.repository;
const activation = contract.contractFrozenAt;
const metric = (id, name, role, unit, formula) => ({
  id, name, role, formula, direction: "increase", unit,
  presentation: { name, legendLabel: id === "verified-storage-bytes" ? "Verified storage bytes"
    : id === "verified-workflows" ? "Verified workflows"
      : id === "linked-accurate-reports" ? "Linked accurate reports" : "Accurate reports", transform: "identity" },
});
const response = (endpoint, value) => ({
  endpoint, status: 200, acquiredAt: "2026-10-20T00:00:01Z",
  bodyBase64: Buffer.from(JSON.stringify(value)).toString("base64"),
});
const examplePacket = incorrect => ({
  purpose: "synthetic validation example, never production history",
  reportDate: "2026-10-19",
  workflowPages: [response("repos/github/gh-aw/actions/workflows?per_page=100&page=1",
    { total_count: 1, workflows: [{ id: 1, name: "Build", path: ".github/workflows/build.yml" }] })],
  runPages: { 1: [response("repos/github/gh-aw/actions/workflows/1/runs?created=2026-09-20T00%3A00%3A00Z..2026-10-20T00%3A00%3A00Z&per_page=100&page=1",
    { total_count: 1, workflow_runs: [{ id: 2, workflow_id: 1,
      repository: { id: 1036865607, full_name: repository }, created_at: "2026-10-19T01:00:00Z",
      conclusion: "failure" }] })] },
  artifactPages: { 2: [response("repos/github/gh-aw/actions/runs/2/artifacts?per_page=100&page=1",
    { total_count: 1, artifacts: [{ id: 3, size_in_bytes: 2000000, expired: false,
      workflow_run: { id: 2, repository_id: 1036865607 } }] })] },
  report: response("repos/github/gh-aw/issues/4", {
    number: 4, node_id: "validation-report-4", html_url: `https://github.com/${repository}/issues/4`,
    title: "Artifacts Usage Report - 2026-10-19", created_at: "2026-10-20T00:00:01Z",
    updated_at: "2026-10-20T00:00:01Z",
    body: `| Workflow Name | Artifacts Count | Total Size | Avg Size | Latest Run | Status |
|---|---|---|---|---|---|
| Build | 1 | ${incorrect ? "3" : "2"} MB | 2 MB | 2026-10-19 | Active |`,
  }),
});
const example = incorrect => ({
  contractSha256, windowStart: activation, windowEnd: "2026-10-21T00:00:00Z",
  observedAt: "2026-10-21T00:00:00Z", packets: [examplePacket(incorrect)],
});

export const definition = {
  schemaVersion: 3, slug: "artifacts-summary", repository,
  workflowName: "Artifacts Summary", sourcePath: ".github/workflows/artifacts-summary.md",
  intent: {
    goal: contract.goal,
    acceptance: "Independent exhaustive native workflow/run/artifact pages must reconcile each original published report's count, size, average, latest eligible run and status under the frozen report-date window.",
    temporalAnchor: "contract-activation",
  },
  adoption: { commit: contract.sourceRevision, adoptedAt: activation, baselineCommit: null, baselineAt: null },
  evaluation: { mode: "attainment-only" },
  evidence: {
    key: "independently-reconciled-artifact-inventory",
    repositories: [repository], opportunity: contract.population,
    filters: ["Thirty days anchored at assigned report_date, exclude cancelled runs",
      "Complete independent native API pages; raw published report rows; no invented historical zero",
      "Disjoint completion periods; deduplicate published report identity",
      "Current source only; unknown historical eras remain inapplicable"],
    collection: "Offline digest-checked source closure and original native API/report bytes; no APIs during evaluation.",
    measurementKind: "interval", window: contract.window,
  },
  model: {
    architecture: "Native original-byte decoder and independent count/byte/time/coverage reconciliation",
    recommendation: "Preserve verified workflow-level progress separately from full inventory acceptance and attribution.",
    presentation: { label: "Artifact inventory accuracy", betterLabel: "More independently accurate delivered views" },
  },
  summary: { nativeLabel: "Independently accurate inventory reports" },
  metrics: [
    metric("accurate-inventory-reports", "Accurate delivered inventories", "primary", "reports",
      "Distinct completed report identities with complete independently reconciled count/byte/average/time/status inventory"),
    metric("verified-workflows", "Verified workflow rows", "diagnostic", "workflows",
      "Sum of independently reconciled artifact-bearing workflow rows on distinct delivered report identities"),
    metric("verified-storage-bytes", "Verified inventoried storage", "diagnostic", "bytes",
      "Exact native size_in_bytes sum on independently reconciled workflow rows, not bytes saved or fresh artifact production"),
  ],
  contractSha256,
  nativeSha256,
  nativeSourceRevision: contract.sourceRevision,
  interpretation: {
    activation: "Actual contract freeze time, not workflow adoption or the source commit time.",
    historical: contract.historicalApplicability,
    fullGoal: "Inventory accuracy is measured; narrative insight/retention/optimization safeguards remain separately unknown.",
    workflowContribution: "Unavailable without original protected publication/run/Claim receipts; editable markers are discovery only.",
    costs: "unmeasured", keepDecision: "not-rated; no approved keep bar",
  },
  validationExamples: {
    targetAttained: example(false), targetMissed: example(true),
    missing: { contractSha256 }, malformed: { contractSha256, packets: [{ accepted: true, score: 100 }] },
  },
};

export function assessEvidence(evidence) {
  if (!evidence || evidence.contractSha256 !== contractSha256 || !Array.isArray(evidence.packets)
    || !Number.isFinite(Date.parse(evidence.windowStart)) || !Number.isFinite(Date.parse(evidence.windowEnd))
    || !Number.isFinite(Date.parse(evidence.observedAt))
    || Date.parse(evidence.windowStart) < Date.parse(activation)
    || Date.parse(evidence.windowStart) >= Date.parse(evidence.windowEnd)
    || Date.parse(evidence.windowEnd) > Date.parse(evidence.observedAt)) return null;
  const reports = new Map();
  for (const packet of evidence.packets) {
    const result = reconcileInventory(packet);
    if (!result.report) continue;
    const at = Date.parse(result.report.createdAt);
    const end = Date.parse(evidence.windowEnd);
    if (at < Date.parse(evidence.windowStart) || at >= end
      || Date.parse(result.report.observedAt) > Date.parse(evidence.observedAt)) continue;
    const prior = reports.get(result.report.id);
    if (prior && prior.report.bodySha256 !== result.report.bodySha256) {
      throw new Error("Conflicting versions of the same delivered report");
    }
    reports.set(result.report.id, result);
  }
  if (!reports.size) return null;
  return [...reports.values()];
}

export function scoreMetric(id, evidence) {
  if (!definition.metrics.some(metric => metric.id === id)) return null;
  let results;
  try { results = assessEvidence(evidence); } catch (error) {
    if (error instanceof NativeEvidenceError) return null;
    throw error;
  }
  if (!results) return null;
  if (id === "accurate-inventory-reports") {
    const known = results.filter(row => row.accuracy !== "unknown"
      && row.contemporaneousInventory && row.report.originalContentKnown);
    return known.length ? known.filter(row => row.accuracy === "accurate").length : null;
  }
  const field = id === "verified-workflows" ? "verifiedWorkflows" : "verifiedStorageBytes";
  const known = results.filter(row => row.contemporaneousInventory && row[field] !== null);
  return known.length ? known.reduce((sum, row) => sum + row[field], 0) : null;
}

export async function collectBatch(requests) {
  const acquisitionPath = new URL("../artifacts-summary/acquisition.json.gz", import.meta.url);
  const acquisition = readJson(fileURLToPath(acquisitionPath));
  if (acquisition.contractSha256 !== contractSha256 || acquisition.sourceRevision !== contract.sourceRevision
    || acquisition.repositoryId !== contract.repositoryId || !Array.isArray(acquisition.nativePackets)) {
    throw new Error("Native evidence archive scope or frozen contract mismatch");
  }
  for (const source of acquisition.sources) {
    const bytes = Buffer.from(source.base64, "base64");
    if (bytes.toString("base64") !== source.base64 || hash(bytes) !== source.sha256
      || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== source.blob) {
      throw new Error("Immutable source content integrity mismatch");
    }
  }
  return requests.map(request => {
    const { windowStart, windowEnd, observedAt } = request;
    if (![windowStart, windowEnd, observedAt].every(at => typeof at === "string"
      && Number.isFinite(Date.parse(at))) || Date.parse(windowStart) >= Date.parse(windowEnd)
      || Date.parse(windowEnd) > Date.parse(observedAt)
      || request.repository && request.repository.toLowerCase() !== repository.toLowerCase()) {
      throw new Error("Invalid bounded inventory assessment request");
    }
    const applicable = Date.parse(windowStart) >= Date.parse(activation);
    const evidence = {
      contractSha256, windowStart, windowEnd, observedAt,
      packets: applicable ? acquisition.nativePackets : [],
      coverageStatus: "unknown",
      maturityStatus: "unavailable",
      missingReason: applicable
        ? "Independent complete native API pages, original report content and delivery census are not preserved."
        : "Frozen prospective contract is not applicable to this historical window; no contemporaneous historical profile is established.",
      discoveryCandidates: acquisition.discovery.directCandidates.length,
      partialFacts: acquisition.retainedRunMetadata,
      costs: "unmeasured", fullGoalAttainment: "unknown", workflowAttribution: "unknown",
    };
    // Decode all available packets even if the primary remains unknown.
    assessEvidence(evidence);
    return { evidence, commit: contract.sourceRevision, provenance: [
      { repository, kind: "immutable-workflow-source",
        ref: `https://github.com/${repository}/blob/${contract.sourceRevision}/.github/workflows/artifacts-summary.md` },
      { repository, kind: "sealed-offline-acquisition", ref: `sha256:${hash(readFileSync(acquisitionPath))}` },
    ] };
  });
}
