import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import test from "node:test";
import { readJsonArchive } from "../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { definition } from "../../docs/operational-value/proof/functions/daily-observability-report.mjs";
import { readFileSync } from "node:fs";

const root = "docs/operational-value/proof/daily-observability-report";
const readiness = readJsonArchive(`${root}/readiness.json`);
const closure = readJsonArchive(`${root}/source-closure.json.gz`);

test("retained complete source bytes round-trip with Git and SHA-256 identities", () => {
  assert.equal(closure.sources.length, 12);
  for (const source of closure.sources) {
    const bytes = Buffer.from(source.content, source.encoding);
    assert.equal(bytes.length, source.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), source.sha256);
    assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), source.gitBlob);
  }
  assert.equal(closure.sources[0].gitBlob, "96a8de8af62e2e84d0a1f54c6e0cfdafc132daf1");
  assert.ok(statSync(`${root}/source-closure.json.gz`).size <= 256 * 1024);
  assert.equal(createHash("sha256").update(readFileSync(`${root}/source-closure.json.gz`)).digest("hex"),
    definition.profile.sourceClosureSha256);
});

test("source readiness does not masquerade as native outcome readiness", () => {
  assert.equal(readiness.status, "current-native-function-evidence-blocked");
  assert.equal(readiness.ready.nativeEvidence, false);
  assert.equal(readiness.ready.historicalSourceClosure, true);
  assert.equal(readiness.ready.historicalMetricCompatibility, false);
  assert.equal(readiness.ready.function, true);
  assert.equal(readiness.adoption.additionVerifiedAgainstRealParent, true);
  assert.equal(readiness.adoption.sourceBytesAvailable, true);
  assert.equal(readiness.adoption.importClosureAvailable, true);
  assert.equal(readiness.boundaries.outcomesInspectedBeforeFreeze, false);
  for (const key of ["nativeValue", "fullAcceptance", "contribution"]) {
    assert.equal(readiness.boundaries[key], null);
  }
  assert.equal(readiness.boundaries.costs, "not measured");
  assert.equal(readiness.boundaries.decision, "not rated");
});

test("remaining acquisition scope is native evidence, not already retained source", () => {
  const [request] = readiness.acquisitionRequests;
  assert.equal(request.kind, "native-producer");
  assert.equal(request.allowedNow, false);
  assert.ok(readiness.acquisitionRequests.every(item => item.kind !== "immutable-source"));
  assert.equal(closure.optionalRuntimeImport.present, false);
  assert.equal(closure.optionalRuntimeImport.optional, true);
});

test("shared adoption reporting import preserves its original receipt and adds no acceptance rules", () => {
  const source = readJsonArchive(`${root}/adoption-reporting-import.json`);
  const blob = Buffer.from(source.originalBlob, "base64");
  const response = Buffer.from(source.originalResponse, "base64");
  assert.equal(blob.length, 458);
  assert.equal(createHash("sha256").update(blob).digest("hex"),
    "6a4e09cefde06d6bcb8b9501e0b24ec9b071dced89add449492b42722c47fc1d");
  assert.equal(createHash("sha1").update(`blob ${blob.length}\0`).update(blob).digest("hex"), source.gitBlob);
  assert.equal(createHash("sha256").update(response).digest("hex"), source.originalResponseSha256);
  assert.deepEqual(Buffer.from(JSON.parse(response).content, "base64"), blob);
  assert.equal(source.receipt.workflow, "daily-cli-performance");
  assert.equal(source.review.changesAcceptance, false);
  assert.equal(source.review.historicalCompatibility, false);
  assert.equal(readiness.resolvedSourceRequests.length, 4);
});

test("supplied source response and decoded originals retain exact identities", () => {
  const supplementPath = `${root}/source-supplement.json.gz`;
  assert.equal(createHash("sha256").update(readFileSync(supplementPath)).digest("hex"),
    definition.profile.sourceSupplementSha256);
  const supplement = readJsonArchive(supplementPath);
  assert.equal(supplement.sources.length, 3);
  for (const source of supplement.sources) {
    const response = Buffer.from(source.originalResponse, "base64");
    const blob = Buffer.from(source.originalBlob, "base64");
    assert.equal(createHash("sha256").update(response).digest("hex"), source.receipt.bodySha256);
    assert.equal(createHash("sha256").update(blob).digest("hex"), source.receipt.blobSha256);
    assert.equal(createHash("sha1").update(`blob ${blob.length}\0`).update(blob).digest("hex"), source.receipt.sha);
    assert.deepEqual(Buffer.from(JSON.parse(response).content, "base64"), blob);
  }
  assert.equal(supplement.review.historicalCompatibility, false);
});

test("standard evaluation preserves disjoint missing periods and exact frozen function", () => {
  const timeline = readJsonArchive(`${root}/reports/github-gh-aw/daily-observability-report-timeline.json`);
  const expected = createHash("sha256")
    .update(readFileSync("docs/operational-value/proof/functions/daily-observability-report.mjs")).digest("hex");
  assert.equal(timeline.valueFunction.sha256, expected);
  assert.equal(readiness.verification.functionSha256, expected);
  assert.equal(readiness.ready.collectorVerified, true);
  assert.equal(timeline.snapshots.length, 40);
  for (const [i, snapshot] of timeline.snapshots.entries()) {
    if (i) assert.equal(snapshot.window.startAt, timeline.snapshots[i - 1].window.endAt);
    assert.equal(snapshot.evidence.coverageStatus, "missing");
    assert.ok(Object.values(snapshot.metrics).every(value => value === null));
  }
  assert.equal(timeline.snapshots.at(-1).window.endAt, "2026-10-18T15:00:12Z");
});
