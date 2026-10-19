import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = fileURLToPath(new URL("../../docs/operational-value/proof/daily-model-resolution/", import.meta.url));
const read = file => JSON.parse(readFileSync(path.join(root, file), "utf8"));
const inventory = read("source-inventory.json");
const request = read("acquisition-request.json");
const readiness = read("readiness.json");

test("retained original sources independently reproduce Git and SHA256 identities", () => {
  assert.equal(inventory.records.length, 23);
  for (const record of inventory.records) {
    const archive = path.join(root, record.file);
    assert.ok(statSync(archive).size <= 256 * 1024);
    const stored = JSON.parse(gunzipSync(readFileSync(archive)));
    assert.equal(stored.encoding, "base64");
    const bytes = Buffer.from(stored.content, "base64");
    assert.equal(bytes.length, record.bytes);
    assert.equal(bytes.toString("base64"), stored.content);
    assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), record.blob);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), record.sha256);
    assert.equal(stored.blob, record.blob);
    assert.equal(stored.sha256, record.sha256);
  }
});

test("original bounded acquisition request matches exactly the three centrally supplied blobs", () => {
  const receipts = read("acquisition/receipts.json").receipts;
  assert.equal(receipts.length, 3);
  assert.equal(request.scope.maxBlobs, 3);
  assert.deepEqual(request.requests.map(item => item.gitBlob).sort(), receipts.map(item => item.sha).sort());
  for (const item of request.requests) {
    assert.ok(inventory.records.some(candidate =>
      candidate.revision === item.revision && candidate.path === item.path && candidate.blob === item.gitBlob));
  }
});

test("adoption addition is distinguished from incomplete source review and unavailable values", () => {
  assert.equal(inventory.adoptionEvidence.parentTree, "");
  assert.equal(inventory.adoptionEvidence.status, "addition-verified-original-content-retained");
  assert.equal(readiness.sourceReadiness, "workflow-imports-reviewed-native-producer-closure-incomplete");
  assert.equal(readiness.sourceReviewedApproval, false);
  assert.equal(readiness.currentFacetFrozen, true);
  assert.equal(readiness.functionReady, false);
  assert.equal(readiness.evaluationReady, false);
  for (const key of ["nativeDiagnostic", "fullAcceptance", "workflowContribution", "costs"]) {
    assert.equal(readiness.results[key], null);
  }
  const source = inventory.records.find(item => item.blob === readiness.source.gitBlob);
  assert.equal(source.sha256, readiness.source.sha256);
  assert.equal(source.path, readiness.source.path);
  assert.equal(source.revision, readiness.source.revision);
});
