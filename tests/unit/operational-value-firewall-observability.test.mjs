import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assessRetainedEvidence } from "../../scripts/collect-firewall-observability.mjs";
import { readJsonArchive } from "../../.github/skills/add-operational-value/scripts/json-archive.mjs";

const base = new URL("../../docs/operational-value/proof/firewall-observability/", import.meta.url);

test("fixed firewall sample retains three native gaps rather than accepting request claims", () => {
  const assessment = assessRetainedEvidence();
  assert.deepEqual(assessment.selectedReports.map(row => row.number), [35842, 34848, 34153]);
  assert.equal(assessment.candidateCount, 169);
  assert.equal(assessment.completedNativeEvaluation, false);
  assert.equal(assessment.qualifiedNativeWorkflows, 0);
  for (const row of assessment.selectedReports) {
    assert.equal(row.nativeValue, null);
    assert.equal(row.completedNativeEvaluation, false);
    assert.ok(row.referencedRuns.length);
    assert.ok(row.referencedRuns.every(run => run.returnedArtifactCount === 0));
  }
  assert.equal(assessment.fullAcceptance, null);
  assert.equal(assessment.contribution, null);
  assert.equal(assessment.costs, null);
});

test("original no-data prose and surviving charts do not become native zero or event evidence", () => {
  const packet = readJsonArchive(fileURLToPath(new URL("originals/discussion-34153.json.gz", base)));
  const body = JSON.parse(packet.body).data.repository.discussion.body;
  assert.match(body, /Total workflows analyzed: 0/);
  assert.match(body, /example\.com\/redacted/);
  assert.equal(assessRetainedEvidence().selectedReports.at(-1).nativeValue, null);
});

test("firewall gap assessment fails explicitly if an original response archive changes", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "firewall-custody-"));
  try {
    cpSync(base, temp, { recursive: true });
    const file = path.join(temp, "originals/discussion-35842.json.gz");
    writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from("changed")]));
    assert.throws(() => assessRetainedEvidence(temp), /Archive custody changed/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
