import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assessChoiceReceipt, expectedWeekdayChoice, nativeChoiceModule, projectChoicePayload, scanChoiceEvidence } from "../../scripts/native-choice-value.mjs";
import { choiceSourceProfile, readChoicePayloadArchive, readChoiceRootLog } from "../../scripts/collect-choice-history.mjs";
import { censusDigest, readCensusJson } from "../../scripts/operational-value-census-io.mjs";
import { verifyPublicGitBlob } from "../../scripts/immutable-public-git-source.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const contract = { workflowId: "daily-choice-test", repository: "github/gh-aw",
  sourcePath: ".github/workflows/daily-choice-test.md", compiledPath: ".github/workflows/daily-choice-test.lock.yml",
  until: "2026-10-18T15:00:12Z", taskSha256: "1".repeat(64), jobSha256: "2".repeat(64),
  interpreterSha256: hash(readFileSync("scripts/native-choice-value.mjs")) };
const module = nativeChoiceModule(contract);
const sample = () => structuredClone(module.definition.validationExamples.targetAttained.observations[0]);

test("weekday expectations use exact native configurations, with no invented weekend rule", () => {
  for (const day of [12, 14, 16]) assert.deepEqual(expectedWeekdayChoice(`2026-10-${day}T11:20:00Z`),
    { environment: "staging", testType: "smoke" });
  for (const day of [13, 15]) assert.deepEqual(expectedWeekdayChoice(`2026-10-${day}T11:20:00Z`),
    { environment: "production", testType: "integration" });
  assert.equal(expectedWeekdayChoice("2026-10-17T11:20:00Z"), null);
  assert.equal(expectedWeekdayChoice("2026-02-30T11:20:00Z"), null);
});

test("successful jobs alone, wrong days and wrong configurations do not establish delivered correctness", () => {
  assert.equal(assessChoiceReceipt(sample(), contract).correct, true);
  assert.equal(module.scoreMetric("correct-configurations", module.definition.validationExamples.targetMissed), 0);
  const noPayload = sample(); delete noPayload.artifacts;
  assert.equal(assessChoiceReceipt(noPayload, contract).status, "unknown");
  const spoof = sample(); spoof.host.line = "2026-10-16T11:23:30Z Agent says the configuration is correct.";
  assert.equal(assessChoiceReceipt(spoof, contract).status, "unknown");
  const outside = sample(); outside.host.line = "2026-10-16T11:20:30Z Test would be executed on staging environment with smoke tests";
  assert.equal(assessChoiceReceipt(outside, contract).status, "unknown");
  const midnight = sample(); midnight.run.createdAt = "2026-10-16T00:30:00Z";
  assert.equal(assessChoiceReceipt(midnight, contract).status, "unknown");
});

test("source profiles, initial attempts, upload identities and merged payload agreement are mandatory", () => {
  for (const mutate of [
    row => { row.run.attempt = 2; },
    row => { row.source.taskSha256 = "3".repeat(64); },
    row => { row.source.headSha = "b".repeat(40); },
    row => { row.artifacts[0].runId = 9; },
    row => { row.artifacts[0].id = row.artifacts[1].id; },
    row => { row.artifacts[0].providerDigest = `sha256:${"0".repeat(64)}`; },
    row => { row.artifacts[0].selection.environment = "production"; },
    row => { row.artifacts[0].uploadStep.name = "Execute Claude Code CLI"; },
    row => { row.host.entry = "agent/5_Display Test Config.txt"; },
  ]) {
    const row = sample(); mutate(row);
    assert.equal(assessChoiceReceipt(row, contract).status, "unknown");
  }
});

test("unknown evidence does not erase a proven configuration or become an all-unknown zero", () => {
  const known = sample(), unknown = { run: { id: 2, createdAt: "2026-10-15T11:20:00Z" } };
  const mixed = scanChoiceEvidence({ valid: true, observations: [known, unknown] }, contract);
  assert.equal(mixed["correct-configurations"], 1);
  assert.equal(mixed["unassessed-opportunities"], 1);
  assert.equal(scanChoiceEvidence({ valid: true, observations: [unknown] }, contract)["correct-configurations"], null);
  assert.equal(scanChoiceEvidence({ valid: true, observations: [known, known] }, contract), null);
  assert.equal(module.scoreMetric("correct-configurations", { valid: false }), null);
});

test("native artifact decoder projects one bounded allowed item and never agent prose", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "cao-choice-probe-"));
  try {
    const file = path.join(temporary, "agent_output.json"), archive = path.join(temporary, "artifact.zip");
    const value = { items: [{ type: "test_environment", environment: "staging", test_type: "smoke" }], message: "Untrusted agent prose." };
    const content = JSON.stringify(value);
    writeFileSync(file, content);
    execFileSync("zip", ["-q", archive, "agent_output.json"], { cwd: temporary, timeout: 30000 });
    const result = readChoicePayloadArchive(readFileSync(archive));
    assert.deepEqual(result, { selection: { environment: "staging", testType: "smoke" }, payloadSha256: hash(content) });
    for (const invalid of [{ items: [] }, { items: [...value.items, ...value.items] },
      { items: [{ ...value.items[0], environment: "staging\nspoof" }] }]) assert.equal(projectChoicePayload(invalid), null);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test("root job archives preserve underscore-bearing custom-job identity without broadening other log readers", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "cao-choice-host-probe-"));
  try {
    const content = "2026-10-16T11:23:30Z Test would be executed on staging environment with smoke tests\n";
    writeFileSync(path.join(temporary, "5_test_environment.txt"), content);
    const archive = path.join(temporary, "logs.zip");
    execFileSync("zip", ["-q", archive, "5_test_environment.txt"], { cwd: temporary, timeout: 30000 });
    const bytes = readFileSync(archive), result = readChoiceRootLog(bytes);
    assert.equal(result.hostEntry, "5_test_environment.txt");
    assert.equal(result.text, content);
    assert.equal(result.archiveSha256, hash(bytes));
    assert.equal(result.hostLogSha256, hash(content));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test("retained native choice observations replay from frozen source and actual protected receipts", async () => {
  const directory = "docs/operational-value/proof/weekday-choice";
  const [actual] = readCensusJson(`${directory}/contracts.json`);
  const index = readCensusJson(`${directory}/index.json`), facts = readCensusJson(`${directory}/facts.json.gz`);
  assert.equal(index.contractSha256, censusDigest(actual));
  assert.equal(index.factsSha256, censusDigest(facts));
  assert.equal(index.producer.sha256, hash(readFileSync(index.producer.path)));
  assert.equal(new Set(facts.observations.map(row => row.run.id)).size, index.observations);
  const sources = new Map(index.sources.map(item => {
    const raw = readCensusJson(`${directory}/sources/${item.gitBlob}.json.gz`);
    assert.equal(censusDigest(raw), item.sha256);
    const bytes = Buffer.from(raw.content, "base64");
    verifyPublicGitBlob(Buffer.from(raw.native, "base64"), item.gitBlob);
    assert.equal(hash(bytes), raw.sha256);
    return [item.gitBlob, bytes.toString("utf8")];
  }));
  for (const row of facts.observations.filter(row => row.source)) {
    const profile = choiceSourceProfile(sources.get(row.source.sourceGitBlob), sources.get(row.source.compiledGitBlob));
    assert.equal(profile.taskSha256, actual.taskSha256);
    assert.equal(profile.jobSha256, actual.jobSha256);
  }
  const assessments = facts.observations.map(row => assessChoiceReceipt(row, actual));
  assert.equal(assessments.filter(row => row.status === "assessed" && row.correct).length, index.proven);
  assert.ok(index.proven > 0, "Coverage requires actual correct configuration receipts, not successful executions.");
  const { definition } = await import("../../docs/operational-value/proof/functions/daily-choice-test.mjs");
  assert.equal(definition.metrics.find(metric => metric.role === "primary").id, "correct-configurations");
  assert.equal(definition.evidence.measurementKind, "interval");
});
