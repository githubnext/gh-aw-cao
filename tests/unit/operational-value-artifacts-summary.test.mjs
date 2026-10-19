import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { definition, collectBatch, scoreMetric } from "../../docs/operational-value/proof/functions/artifacts-summary.mjs";
import { decodeResponse, nativePages, reconcileInventory, reportWindow } from "../../scripts/native-artifacts-summary.mjs";
import { discoveryClosure } from "../../scripts/collect-artifacts-summary.mjs";
import { readOutputHistory } from "../../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { readJson } from "../../.github/skills/add-operational-value/scripts/common.mjs";

const good = () => structuredClone(definition.validationExamples.targetAttained);
const packet = () => good().packets[0];
const replace = (response, mutate) => {
  const value = JSON.parse(Buffer.from(response.bodyBase64, "base64"));
  mutate(value);
  response.bodyBase64 = Buffer.from(JSON.stringify(value)).toString("base64");
};
const score = evidence => scoreMetric("accurate-inventory-reports", evidence);

test("schema3 native examples improve all metrics without caller acceptance flags", () => {
  assert.equal(definition.schemaVersion, 3);
  for (const metric of definition.metrics) {
    assert.ok(scoreMetric(metric.id, definition.validationExamples.targetAttained)
      > scoreMetric(metric.id, definition.validationExamples.targetMissed));
    assert.equal(scoreMetric(metric.id, definition.validationExamples.missing), null);
    assert.equal(scoreMetric(metric.id, definition.validationExamples.malformed), null);
  }
  const e = good();
  e.accepted = false;
  e.score = -999;
  assert.equal(score(e), 1);
  assert.equal(score({ accepted: true, score: 100 }), null);
});

test("native counts and bytes are not normalized quality scores", () => {
  const result = reconcileInventory(packet());
  assert.equal(result.accuracy, "accurate");
  assert.equal(result.verifiedWorkflows, 1);
  assert.equal(result.verifiedStorageBytes, 2000000);
  assert.equal(scoreMetric("verified-storage-bytes", good()), 2000000);
  assert.equal(result.costs, "unmeasured");
  assert.equal(result.safeguards.optimizationBenefit, "unknown");
});

test("fixed report_date determines exact UTC thirty-day analysis window", () => {
  assert.deepEqual(reportWindow("2026-10-19"), {
    start: Date.parse("2026-09-20T00:00:00Z"), end: Date.parse("2026-10-20T00:00:00Z"),
  });
  assert.throws(() => reportWindow("2026-02-30"), /Invalid assigned/);
});

test("wrong count, bytes, average, latest date and status fail independently", () => {
  for (const [before, after] of [
    ["| 1 |", "| 2 |"], ["| 2 MB |", "| 3 MB |"],
    ["2 MB | 2026", "3 MB | 2026"], ["2026-10-19 | Active", "2026-10-18 | Active"],
    ["| Active |", "| Inactive |"],
  ]) {
    const e = good();
    replace(e.packets[0].report, value => { value.body = value.body.replace(before, after); });
    assert.equal(score(e), 0, `${before} -> ${after}`);
  }
});

test("both failed and successful runs count; cancelled and exact end runs do not", () => {
  const p = packet();
  replace(p.runPages[1][0], value => {
    value.total_count = 3;
    value.workflow_runs.push(
      { ...value.workflow_runs[0], id: 7, conclusion: "cancelled" },
      { ...value.workflow_runs[0], id: 8, created_at: "2026-10-20T00:00:00Z" },
    );
  });
  assert.equal(reconcileInventory(p).accuracy, "accurate");
  replace(p.runPages[1][0], value => { value.workflow_runs[0].conclusion = "success"; });
  assert.equal(reconcileInventory(p).accuracy, "accurate");
});

test("missing pagination cannot establish an all-clear", () => {
  const p = packet();
  replace(p.artifactPages[2][0], value => { value.total_count = 2; });
  const result = reconcileInventory(p);
  assert.equal(result.accuracy, "unknown");
  assert.equal(result.nativeFacts[0].count, 1);
  assert.equal(result.nativeFacts[0].bytes, 2000000);
  assert.equal(result.verifiedWorkflows, null);
});

test("known reconciled workflow rows survive missing broader inventory", () => {
  const e = good();
  replace(e.packets[0].workflowPages[0], value => {
    value.total_count = 2;
    value.workflows.push({ id: 6, name: "Missing", path: ".github/workflows/missing.yml" });
  });
  assert.equal(score(e), null);
  assert.equal(scoreMetric("verified-workflows", e), 1);
  assert.equal(scoreMetric("verified-storage-bytes", e), 2000000);
});

test("published artifact-free workflows are omitted, with no invented inactive threshold", () => {
  const p = packet();
  replace(p.workflowPages[0], value => {
    value.total_count = 2;
    value.workflows.push({ id: 6, name: "Empty", path: ".github/workflows/empty.yml" });
  });
  const endpoint = p.runPages[1][0].endpoint.replace("/1/runs", "/6/runs");
  p.runPages[6] = [{ ...p.runPages[1][0], endpoint,
    bodyBase64: Buffer.from(JSON.stringify({ total_count: 0, workflow_runs: [] })).toString("base64") }];
  assert.equal(reconcileInventory(p).accuracy, "accurate");
});

test("malformed byte sizes, foreign repository and duplicate native IDs fail closed", () => {
  for (const mutate of [
    value => { value.artifacts[0].size_in_bytes = -1; },
    value => { value.artifacts[0].size_in_bytes = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.artifacts[0].workflow_run.repository_id = 1; },
    value => { value.artifacts[0].workflow_run.id = 9; },
    value => { value.total_count = 2; value.artifacts.push(value.artifacts[0]); },
  ]) {
    const p = packet();
    replace(p.artifactPages[2][0], mutate);
    assert.throws(() => reconcileInventory(p));
  }
});

test("explicit native pagination rejects missing, repeated or foreign pages", () => {
  const p = packet().workflowPages;
  const endpoint = "repos/github/gh-aw/actions/workflows";
  assert.equal(nativePages([], endpoint, "workflows").complete, false);
  assert.throws(() => nativePages([p[0], p[0]], endpoint, "workflows"));
  p[0].endpoint = p[0].endpoint.replace("github/gh-aw", "github/other");
  assert.throws(() => nativePages(p, endpoint, "workflows"));
});

test("original byte decoder rejects fabricated flags, wrong status and noncanonical encoding", () => {
  assert.throws(() => decodeResponse({ accepted: true }));
  const r = packet().report;
  r.status = 403;
  assert.throws(() => decodeResponse(r));
  r.status = 200;
  r.bodyBase64 += "!";
  assert.throws(() => decodeResponse(r));
});

test("rounded sizes accept decimal or binary but require consistent global interpretation", () => {
  const p = packet();
  replace(p.report, value => { value.body = value.body.replaceAll("2 MB", "1.91 MB"); });
  assert.equal(reconcileInventory(p).accuracy, "accurate");
  replace(p.report, value => { value.body = value.body.replace("1.91 MB", "2.00 MB"); });
  assert.equal(reconcileInventory(p).accuracy, "incorrect");
});

test("same report in retained snapshots is never fresh delivery", () => {
  const e = good();
  e.packets.push(structuredClone(e.packets[0]));
  assert.equal(score(e), 1);
  e.windowStart = "2026-10-20T00:00:02Z";
  assert.equal(score(e), null);
});

test("later edits cannot become a second original delivery or establish original accuracy", () => {
  const e = good();
  replace(e.packets[0].report, value => {
    value.updated_at = "2026-10-20T00:00:02Z";
    e.packets[0].report.acquiredAt = "2026-10-20T00:00:02Z";
  });
  assert.equal(score(e), null);
  assert.equal(scoreMetric("verified-workflows", e), 1);
  e.windowStart = "2026-10-20T00:00:02Z";
  assert.equal(scoreMetric("verified-workflows", e), null);
});

test("later mutable native inventory is not backdated to original report delivery", () => {
  const e = good();
  e.packets[0].report.acquiredAt = "2026-10-20T00:00:03Z";
  e.packets[0].artifactPages[2][0].acquiredAt = "2026-10-20T00:00:02Z";
  const native = reconcileInventory(e.packets[0]);
  assert.equal(native.accuracy, "accurate");
  assert.equal(native.contemporaneousInventory, false);
  assert.equal(native.nativeFacts[0].bytes, 2000000);
  assert.equal(score(e), null);
  assert.equal(scoreMetric("verified-storage-bytes", e), null);
});

test("exclusive completion endpoint and observation cutoff are enforced", () => {
  const e = good();
  e.windowEnd = "2026-10-20T00:00:00Z";
  assert.equal(score(e), null);
  e.windowEnd = "2026-10-21T00:00:00Z";
  e.observedAt = "2026-10-20T00:00:00Z";
  assert.equal(score(e), null);
});

test("conflicting report versions are explicit errors, not silent missingness", () => {
  const e = good();
  e.packets.push(structuredClone(e.packets[0]));
  replace(e.packets[1].report, value => { value.body += "\nchanged"; });
  assert.throws(() => score(e), /Conflicting versions/);
});

test("discovery retains direct candidates and full forward/reverse transitive closure plus absent refs", () => {
  const rows = [
    { number: 1, workflowReference: { workflowId: "artifacts-summary" }, relatedCandidates: [2] },
    { number: 2, relatedCandidates: [3, 99] },
    { number: 3, relatedCandidates: [] },
    { number: 4, relatedCandidates: [3] },
    { number: 5, relatedCandidates: [] },
  ];
  const closure = discoveryClosure(rows);
  assert.deepEqual(closure.directCandidates, [1]);
  assert.deepEqual(closure.entities.map(row => row.number), [1, 2, 3, 4]);
  assert.deepEqual(closure.absentReferences, [99]);
  assert.deepEqual(discoveryClosure([{
    number: 7, workflowReference: { workflowId: "another",
      additionalRunReferences: [{ workflowId: "artifacts-summary" }] },
  }]).directCandidates, [7]);
});

test("actual production history independently replays all partitions without shared caches", () => {
  const { index, entities } = readOutputHistory("docs/operational-value/proof/artifacts-summary/history");
  assert.equal(index.partitions.length, 346);
  assert.equal(entities.length, 58048);
  const closure = discoveryClosure(entities);
  assert.equal(closure.entities.length, 11);
  assert.deepEqual(closure.absentReferences, []);
  const acquisition = readJson("docs/operational-value/proof/artifacts-summary/acquisition.json.gz");
  assert.deepEqual(closure, acquisition.discovery);
  assert.equal(acquisition.nativePackets.length, 0);
});

test("actual collector preserves frozen historical inapplicability and prospective missingness", async () => {
  const values = await collectBatch([
    { windowStart: "2026-09-18T15:00:12Z", windowEnd: "2026-10-18T15:00:12Z", observedAt: "2026-10-18T15:00:12Z" },
    { windowStart: definition.adoption.adoptedAt, windowEnd: "2026-10-20T00:00:00Z", observedAt: "2026-10-20T00:00:00Z" },
  ]);
  assert.equal(values.length, 2);
  assert.match(values[0].evidence.missingReason, /not applicable/);
  assert.match(values[1].evidence.missingReason, /not preserved/);
  assert.equal(values[0].evidence.discoveryCandidates, 11);
  for (const value of values) {
    assert.equal(score(value.evidence), null);
    assert.equal(value.evidence.coverageStatus, "unknown");
    assert.equal(value.evidence.costs, "unmeasured");
    assert.equal(value.evidence.workflowAttribution, "unknown");
    assert.ok(value.provenance.length > 0);
  }
});

test("collected partial run metadata is retained without being promoted to accuracy", async () => {
  const [value] = await collectBatch([{ windowStart: definition.adoption.adoptedAt,
    windowEnd: "2026-10-20T00:00:00Z", observedAt: "2026-10-20T00:00:00Z" }]);
  const row = value.evidence.partialFacts.rows[0];
  assert.equal(row.artifacts.total, 6);
  assert.equal(row.artifacts.items.length, 6);
  assert.equal(scoreMetric("verified-storage-bytes", value.evidence), null);
  const module = readFileSync("docs/operational-value/proof/functions/artifacts-summary.mjs", "utf8");
  assert.match(module, /nativeSha256/);
});

test("collector rejects invalid windows and unsupported repositories explicitly", async () => {
  for (const request of [
    { windowStart: "bad", windowEnd: "bad", observedAt: "bad" },
    { windowStart: "2026-10-21T00:00:00Z", windowEnd: "2026-10-20T00:00:00Z", observedAt: "2026-10-21T00:00:00Z" },
    { windowStart: "2026-10-20T00:00:00Z", windowEnd: "2026-10-21T00:00:00Z", observedAt: "2026-10-21T00:00:00Z", repository: "github/other" },
  ]) await assert.rejects(collectBatch([request]), /Invalid bounded/);
});
