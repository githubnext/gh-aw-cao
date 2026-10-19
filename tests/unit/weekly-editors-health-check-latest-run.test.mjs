import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readJsonArchive } from "../../.github/skills/add-operational-value/scripts/json-archive.mjs";

const root = "docs/operational-value/proof/weekly-editors-health-check";
const report = readJsonArchive(`${root}/latest-run-inspection.json`);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

test("exactly three released latest-run endpoints retain original bytes and safe actual headers", () => {
  const hashes = {
    artifacts: "87c8e4f44968a5f2de0de64f0e27b86bb21feb1604adf27ab18af0ff78387384",
    jobs: "00b28146f589e6b6d08646e64f32435b8d2ae5a9897614d4090830a5a9e954db",
    logs: "3dcf42cb36e37a9e9cdb234625f9cb96049ead9e18e0efe2949307447280dc90",
  };
  let previous = null;
  for (const name of ["artifacts", "jobs", "logs"]) {
    const packet = readJsonArchive(`${root}/latest-run-${name}.json`);
    assert.equal(hash(Buffer.from(packet.originalBody, "base64")), hashes[name]);
    assert.equal(packet.receipt.bodySha256, hashes[name]);
    assert.equal(packet.receipt.status, 200);
    assert.equal(packet.receipt.refusal, false);
    assert.equal(packet.receipt.headers.location, undefined);
    assert.equal(packet.receipt.headers.authorization, undefined);
    assert.equal(packet.receipt.headers["retry-after"], undefined);
    if (previous) assert.ok(Date.parse(packet.receipt.receivedAt) - previous >= 1500);
    previous = Date.parse(packet.receipt.receivedAt);
  }
});

test("protected original job trace establishes missing HTTP instrumentation, not editor failures", () => {
  assert.equal(report.runId, 39014584632);
  assert.equal(report.attempt, 1);
  assert.equal(report.producerJob.id, 117344046063);
  assert.equal(report.headSha, "d3915e4a21040c00a6e11e1acb0aac42605abc4c");
  assert.equal(report.inspection.originalToolCalls, 4);
  assert.equal(report.inspection.originalHttpToolCalls, 0);
  assert.equal(report.inspection.protectedPermissionDenials, 1);
  assert.equal(report.inspection.specificDeniedCommand,
    "cat docs/src/content/docs/reference/editors.mdx; command -v playwright-cli safeoutputs");
  assert.equal(report.nativeEvidence.originalEditorHttpReceipts, 0);
  assert.equal(report.nativeEvidence.availableEditorCount, null);
  assert.equal(report.nativeEvidence.failedEditorCount, null);
  assert.equal(report.nativeEvidence.availabilityPercent, null);
  assert.equal(report.observedEditorInventory.matchedImmutableInventory, true);
  const calls = report.originalAgentEvents.toolCalls;
  assert.deepEqual(calls.map(call => call.toolName), ["bash", "view", "safeoutputs_noop", "bash"]);
  for (const call of calls) {
    assert.equal(call.originalStart.data.toolCallId, call.originalCompletion.data.toolCallId);
    assert.ok(call.startLine < call.completionLine);
  }
});

test("all latest-run artifact identities bind to original producer while downloads remain unreleased", () => {
  assert.equal(report.artifactPagination.total, 7);
  assert.equal(report.artifactPagination.returned, 7);
  assert.equal(report.artifactPagination.link, null);
  assert.equal(report.jobPagination.total, 6);
  const artifact = report.artifacts.find(row => row.name === "agent");
  assert.equal(artifact.id, 12093929058);
  assert.equal(artifact.expired, false);
  assert.equal(artifact.digest, "sha256:87a0c239b76d6b1d4291deaa7dc2e7fc7947b7eca15b2d63052b064e6942b80d");
  assert.equal(report.nextEvidence.authorization, "not released");
  assert.equal(report.zip.entries.length, 10);
  assert.equal(report.zip.sha256, "3dcf42cb36e37a9e9cdb234625f9cb96049ead9e18e0efe2949307447280dc90");
});

test("native availability function remains byte-identical to39-member predecessor", () => {
  const predecessor = readJsonArchive(`${root}/predecessor-run-discovery-v018.json`);
  assert.equal(predecessor.manifest.members.length, 39);
  const module = "docs/operational-value/proof/functions/weekly-editors-health-check.mjs";
  const before = predecessor.manifest.members.find(row => row.path === module);
  assert.equal(before.sha256, "1accbcef17c6392a0b0163807914515c25b4172ad41c30457db4fa3ad5c4ce21");
  assert.equal(hash(readFileSync(module)), before.sha256);
  assert.equal(report.frozenFunction.sha256, before.sha256);
  assert.equal(report.frozenFunction.changed, false);
});
