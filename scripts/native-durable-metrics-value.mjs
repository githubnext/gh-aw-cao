import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const root = new URL("../", import.meta.url);
const directory = new URL("docs/operational-value/proof/durable-metrics/", root);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const unknown = reason => ({ status: "unknown", reason });
const utc = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)
  && Number.isFinite(Date.parse(value));
const fields = ["total", "successful", "failed", "skipped", "action_required", "executed"];

export function verifyRunRecord({ record, window, snapshotAt, workflow, pages, repositoryId }) {
  if (!record || !window || !utc(window.start) || !utc(window.end) || !utc(snapshotAt)
    || window.start >= window.end || window.end > snapshotAt) return unknown("Missing explicit mature collection window");
  if (record.data_available === false || record.data_source === "unavailable"
    || record.outcome_classification_available === false || record.total_is_lower_bound === true) {
    return unknown("Explicit unavailable classifications or lower-bound counts are not full-window factual records");
  }
  if (!fields.every(key => Number.isSafeInteger(record[key]) && record[key] >= 0)) {
    return unknown("Missing or malformed six-field run classification");
  }
  if (!Array.isArray(pages) || !pages.length || !workflow) return unknown("Missing independent run population");
  const ids = new Set(), runs = [];
  const total = pages[0].total_count;
  assert.ok(Number.isSafeInteger(total) && total >= 0, "Invalid provider population");
  for (const page of pages) {
    assert.equal(page.total_count, total, "Provider population changed during pagination");
    assert.ok(Array.isArray(page.workflow_runs), "Missing original run rows");
    for (const run of page.workflow_runs) {
      assert.ok(Number.isSafeInteger(run.id) && !ids.has(run.id), "Duplicate or malformed run identity");
      ids.add(run.id);
      assert.equal(run.workflow_id, workflow.id, "Foreign workflow run");
      assert.equal(run.path, workflow.path, "Foreign workflow path");
      assert.equal(run.repository?.id, repositoryId, "Foreign repository run");
      assert.equal(run.repository.private, false, "Nonpublic run");
      assert.ok(utc(run.created_at) && run.created_at >= window.start && run.created_at <= window.end,
        "Provider returned a run outside the requested inclusive API range");
      if (run.created_at < window.end) runs.push(run);
    }
  }
  if (ids.size !== total) return unknown("Independent pagination is incomplete");
  if (record.total !== runs.length) return { status: "rejected", reason: "Full-window run total differs", actualTotal: runs.length };
  if (runs.some(run => !utc(run.updated_at) || run.updated_at > snapshotAt)) {
    return unknown("Later run updates prevent contemporaneous conclusion reconstruction");
  }
  const expected = { total: runs.length, successful: 0, failed: 0, skipped: 0, action_required: 0, executed: 0 };
  for (const run of runs) {
    if (run.conclusion === "success") expected.successful++;
    else if (["failure", "cancelled", "timed_out"].includes(run.conclusion)) expected.failed++;
    else if (["skipped", "action_required"].includes(run.conclusion)) expected[run.conclusion]++;
  }
  expected.executed = expected.successful + expected.failed;
  return fields.every(key => record[key] === expected[key])
    ? { status: "accepted", expected }
    : { status: "rejected", reason: "Run classifications differ from original host facts", expected };
}

export function durableMetricsModule(pins) {
  for (const [relative, expected] of Object.entries(pins)) {
    assert.equal(hash(readFileSync(new URL(relative, root))), expected, `Dependency changed: ${relative}`);
  }
  const contractFile = new URL("frozen-contract-v1.json", directory);
  const contract = JSON.parse(readFileSync(contractFile));
  const index = readJsonArchive(fileURLToPath(new URL("index.json.gz", directory)));
  assert.equal(hash(readFileSync(contractFile)), index.contractSha256);
  const originals = {};
  for (const [label, receipt] of Object.entries(index.receipts)) {
    assert.match(receipt.file, /^originals\/[a-z0-9-]+\.json\.gz$/);
    const filename = new URL(receipt.file, directory);
    assert.equal(hash(readFileSync(filename)), receipt.archiveSha256, `Archive changed: ${label}`);
    const packet = readJsonArchive(fileURLToPath(filename));
    assert.equal(hash(packet.body), packet.sha256, `Original changed: ${label}`);
    assert.equal(packet.sha256, receipt.bodySha256);
    originals[label] = JSON.parse(packet.body);
  }
  assert.equal(originals.repository.id, contract.repositoryId);
  assert.equal(originals.repository.full_name, contract.repository);
  assert.equal(originals.repository.private, false);
  assert.equal(originals["backing-ref"].object.sha, index.backingCommit);
  assert.equal(originals.adoption.sha, contract.adoption.commit);
  assert.equal(originals.adoption.parents[0].sha, contract.adoption.parent);
  assert.equal(originals.adoption.commit.committer.date, contract.adoption.adoptedAt);
  assert.equal(originals.baseline.sha, contract.adoption.parent);
  const assessments = [];
  for (const selected of index.records) {
    assert.ok(originals["daily-directory"].some(row => row.path === selected.path && row.sha === selected.gitBlob),
      "Snapshot is not bound to the acquired backing-directory entry");
    const label = `snapshot-${selected.path.split("/").at(-1).slice(0, 10)}`, blob = originals[label];
    assert.equal(blob.sha, selected.gitBlob);
    const bytes = Buffer.from(blob.content, "base64");
    assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), blob.sha);
    const snapshot = JSON.parse(bytes.toString("utf8"));
    for (const slug of contract.selection.workflows) {
      assert.equal(originals[`workflow-${slug}`].id, index.workflows[slug].id);
      assert.equal(originals[`workflow-${slug}`].path, index.workflows[slug].path);
      const pageIndex = selected.runPages[slug];
      const result = verifyRunRecord({ record: snapshot.workflows?.[slug]?.workflow_runs,
        window: snapshot.collection_window, snapshotAt: snapshot.timestamp, workflow: index.workflows[slug],
        pages: pageIndex?.labels.map(label => originals[label]), repositoryId: contract.repositoryId });
      assessments.push({ snapshot: selected.path, gitBlob: selected.gitBlob, timestamp: snapshot.timestamp, slug, ...result });
    }
  }
  const metric = {
    id: contract.nativePartial.id, name: "Verified run-statistic records", role: "primary",
    formula: contract.nativePartial.formula, direction: "increase", unit: contract.nativePartial.unit,
    presentation: { name: "Verified run-statistic records", legendLabel: "Verified records", transform: "identity" },
  };
  const definition = {
    schemaVersion: 3, slug: contract.workflow, repository: contract.repository, workflowName: "Metrics Collector",
    sourcePath: ".github/workflows/metrics-collector.md",
    intent: { goal: contract.goal, acceptance: contract.nativePartial.formula, temporalAnchor: "workflow-adoption" },
    adoption: { commit: contract.adoption.commit, adoptedAt: contract.adoption.adoptedAt,
      baselineCommit: contract.adoption.parent, baselineAt: originals.baseline.commit.committer.date },
    evaluation: { mode: "attainment-only" },
    evidence: { key: "durable-metrics-v1", repositories: [contract.repository],
      opportunity: "Fixed three backing snapshots and three source-specified workflow records per snapshot",
      filters: ["Half-open explicit collection windows", "No unavailable zero stubs", "No inferred matching subsets", "No backdated later run conclusions"],
      collection: "Digest-checked immutable backing blobs and independently exhausted original public Actions run pages",
      measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Immutable original acquisition, deterministic host-population reconciliation and standard schema-3 reports",
      recommendation: "Not rated; no agreed keep bar, full acceptance or cost evidence",
      presentation: { label: contract.nativePartial.unit, betterLabel: "More independently corroborated records" } },
    summary: { nativeLabel: contract.nativePartial.unit }, metrics: [metric],
    validationExamples: { targetAttained: { schemaVersion: 1, native: 1 }, targetMissed: { schemaVersion: 1, native: 0 },
      missing: {}, malformed: { schemaVersion: 1, native: -1 } },
    originalAcceptance: contract.fullAcceptance, limitations: contract.separateUnknowns,
    frozenSource: { revision: contract.revision, sourceBlob: originals["frozen-source"].sha, cutoff: contract.cutoff },
    assessmentPolicy: "Fixed-cutoff source-reference factual assessment, not backdated source-conformance or original-publication accuracy",
    nativeAssessments: assessments, dependencyIdentity: pins,
  };
  return {
    definition,
    collectBatch(requests) {
      assert.ok(Array.isArray(requests));
      return requests.map(request => {
        assert.ok(request.repository === undefined || request.repository.toLowerCase() === contract.repository);
        assert.ok(utc(request.windowStart) && utc(request.windowEnd) && utc(request.observedAt)
          && request.windowStart < request.windowEnd && request.windowEnd <= request.observedAt
          && request.windowEnd <= contract.cutoff, "Invalid, immature or out-of-cutoff interval");
        const selected = assessments.filter(row => utc(row.timestamp)
          && row.timestamp >= request.windowStart && row.timestamp < request.windowEnd);
        const accepted = selected.filter(row => row.status === "accepted");
        return { commit: contract.revision, evidence: { schemaVersion: 1,
          native: accepted.length ? accepted.length : null, knownSubtotal: accepted.length,
          coverageStatus: "partial", assessments: selected, fullAcceptance: null, contribution: null, costs: null },
        provenance: [{ repository: contract.repository, kind: "immutable-backing-branch",
          ref: `https://github.com/${contract.repository}/tree/${index.backingCommit}/metrics` }] };
      });
    },
    scoreMetric(id, evidence) {
      assert.equal(id, metric.id, "Unknown metric");
      return evidence?.schemaVersion === 1 && Number.isSafeInteger(evidence.native) && evidence.native >= 0 ? evidence.native : null;
    },
  };
}
