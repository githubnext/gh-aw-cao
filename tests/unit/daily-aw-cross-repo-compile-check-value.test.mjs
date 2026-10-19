import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { assessNativeReport, collectBatch, definition, scoreMetric } from "../../docs/operational-value/proof/functions/daily-aw-cross-repo-compile-check.mjs";
import { readJson } from "../../.github/skills/add-operational-value/scripts/common.mjs";

const sha256 = value => createHash("sha256").update(value).digest("hex");
const clone = value => structuredClone(value);
const request = { windowStart: "2026-10-18T15:00:12Z", windowEnd: "2026-10-19T09:00:00Z",
  observedAt: "2026-10-19T09:00:00Z" };
const file = ".github/workflows/example.md";
const inventory = () => ({ complete: true, workflows: [file],
  files: [{ path: file, gitBlob: "a".repeat(40), sha256: "b".repeat(64) }] });
const compile = (valid = true) => {
  const stdout = JSON.stringify([{ workflow: "example.md", valid,
    errors: valid ? [] : [{ type: "validation_error", message: "Unsupported configuration" }], warnings: [] }]);
  return { argv: ["compile", "--strict", "--json"], exitCode: valid ? 0 : 1,
    stdout, stdoutSha256: sha256(stdout), stderr: "", stderrSha256: sha256(""), environmentStatus: "complete" };
};
const report = () => ({
  repository: "public/example", repositoryId: 1, sourceCommit: "a".repeat(40),
  assessedAt: "2026-10-19T09:00:00Z",
  compiler: { revision: "c".repeat(40), binarySha256: "d".repeat(64), version: "fixture-not-native-history",
    toolchainDigest: "e".repeat(64), environmentDigest: "f".repeat(64) },
  beforeInventory: inventory(), afterInventory: inventory(), before: compile(false), after: compile(),
  fix: { argv: ["fix", "--write"], exitCode: 0, manualEdits: false, disabledCodemods: [],
    originalDiffSha256: "a".repeat(64), sideEffectInventorySha256: "b".repeat(64) },
  importsResolved: true, pinsResolved: true,
});

test("native units and actor-independent acceptance remain distinct from reports produced", () => {
  assert.equal(definition.metrics.filter(row => row.role === "primary").length, 1);
  assert.equal(definition.intent.temporalAnchor, "contract-activation");
  assert.equal(definition.evidence.measurementKind, "snapshot");
  assert.equal(definition.review, undefined);
  assert.equal(scoreMetric("compatible-repositories", definition.validationExamples.targetAttained), 100);
  assert.equal(scoreMetric("compatible-repositories", definition.validationExamples.targetMissed), 0);
  assert.equal(scoreMetric("compatible-workflows", definition.validationExamples.targetAttained), 40);
  assert.equal(scoreMetric("compatible-workflows", definition.validationExamples.targetMissed), 0);
  for (const id of definition.metrics.map(row => row.id)) {
    for (const value of [null, {}, [], { accepted: 20, eligible: 20 }, definition.validationExamples.missing,
      definition.validationExamples.malformed]) assert.equal(scoreMetric(id, value), null);
  }
});

test("partial independent workflow evidence survives unknown full compatibility", () => {
  const evidence = { ...definition.validationExamples.targetAttained, coverageStatus: "partial",
    assessedRepositories: 1, compatibleRepositories: 1, incompatibleRepositories: 0,
    fullInventoryRepositories: 1, unknownRepositories: 19,
    knownCompatibleWorkflows: 2, knownAssessedWorkflows: 3 };
  assert.equal(scoreMetric("compatible-repositories", evidence), null);
  assert.equal(scoreMetric("compatible-workflows", evidence), 2);
  assert.equal(scoreMetric("compatible-workflows", { ...evidence, knownCompatibleWorkflows: 4 }), null);
  assert.equal(scoreMetric("compatible-workflows", { ...evidence, eligibleCount: 0 }), null);
  assert.equal(scoreMetric("compatible-repositories", { ...evidence, coverageStatus: "complete" }), null);
  assert.equal(scoreMetric("compatible-repositories", {
    ...definition.validationExamples.targetAttained, knownCompatibleWorkflows: 0,
  }), null);
});

test("decoder reads native per-workflow ValidationResults, not process success or self-assessment", () => {
  const result = assessNativeReport(report());
  assert.equal(result.status, "compatible");
  assert.equal(result.compatibleWorkflows, 1);
  assert.equal(result.migratedFromIncompatible, true);
  const invalid = report();
  invalid.after = compile(false);
  assert.equal(assessNativeReport(invalid).status, "incompatible");
  invalid.after.exitCode = 0;
  assert.throws(() => assessNativeReport(invalid), /contradicts/);
  const summary = report();
  summary.after.stdout = '{"compatible":true}';
  summary.after.stdoutSha256 = sha256(summary.after.stdout);
  assert.throws(() => assessNativeReport(summary), /population/);
});

test("native raw stdout/stderr digests and exact strict flags are mandatory", () => {
  for (const change of [
    r => { r.after.stdout += " "; },
    r => { r.after.stderr = "Infrastructure failure"; },
    r => { r.after.argv = ["compile", "--no-emit"]; },
    r => { r.compiler.binarySha256 = "unknown"; },
    r => { r.after.stdout = ""; },
  ]) {
    const value = report();
    change(value);
    assert.throws(() => assessNativeReport(value));
  }
});

test("access, setup, pins and import gaps remain unknown rather than incompatibility", () => {
  const value = report();
  value.after = compile(false);
  value.after.environmentStatus = "infrastructure-failed";
  const result = assessNativeReport(value);
  assert.equal(result.status, "unknown");
  assert.equal(result.assessedWorkflows, 0);
  value.after.environmentStatus = "complete";
  value.importsResolved = false;
  assert.equal(assessNativeReport(value).status, "unknown");
});

test("missing, duplicate, unexpected and ambiguous native workflow results cannot certify whole repositories", () => {
  const value = report();
  value.beforeInventory.files.push({ path: ".github/workflows/second.md", gitBlob: "c".repeat(40), sha256: "d".repeat(64) });
  value.beforeInventory.workflows.push(".github/workflows/second.md");
  value.afterInventory = clone(value.beforeInventory);
  assert.equal(assessNativeReport(value).fullInventory, false);
  assert.equal(assessNativeReport(value).status, "unknown");
  const duplicate = report();
  const rows = JSON.parse(duplicate.after.stdout);
  duplicate.after.stdout = JSON.stringify([...rows, ...rows]);
  duplicate.after.stdoutSha256 = sha256(duplicate.after.stdout);
  assert.throws(() => assessNativeReport(duplicate), /duplicate/);
  const extra = report();
  extra.after.stdout = extra.after.stdout.replace("example.md", "not-selected.md");
  extra.after.stdoutSha256 = sha256(extra.after.stdout);
  assert.throws(() => assessNativeReport(extra), /Unexpected/);
});

test("migration cannot remove workflows, disable checks or add manual edits", () => {
  for (const change of [
    r => { r.afterInventory.workflows = []; },
    r => { r.afterInventory.complete = false; },
    r => { r.fix.manualEdits = true; },
    r => { r.fix.disabledCodemods = ["waive-check"]; },
    r => { r.fix.argv = ["fix"]; },
    r => { r.fix.originalDiffSha256 = null; },
  ]) {
    const value = report();
    change(value);
    assert.throws(() => assessNativeReport(value));
  }
});

test("batch failures and nonzero clean exits do not establish whole-repository compatibility", () => {
  const value = report();
  const rows = JSON.parse(value.after.stdout);
  rows.push({ scope: "batch", workflow: "repository-validation", valid: false,
    errors: [{ type: "validation_error", message: "Batch failed" }], warnings: [] });
  value.after.stdout = JSON.stringify(rows);
  value.after.stdoutSha256 = sha256(value.after.stdout);
  value.after.exitCode = 1;
  const result = assessNativeReport(value);
  assert.equal(result.status, "unknown");
  assert.equal(result.compatibleWorkflows, 1);
  const clean = report();
  clean.after.exitCode = 1;
  assert.equal(assessNativeReport(clean).status, "unknown");
  const missingDiagnostic = report();
  missingDiagnostic.after.stdout = JSON.stringify([{ workflow: "example.md", valid: false, errors: [], warnings: [] }]);
  missingDiagnostic.after.stdoutSha256 = sha256(missingDiagnostic.after.stdout);
  assert.equal(assessNativeReport(missingDiagnostic).status, "unknown");
});

test("actual portable collector retains unknown denominators, exact windows and immutable provenance", async () => {
  const requests = [request, { ...request, windowEnd: "2026-10-19T08:00:00Z" }];
  const results = await collectBatch(requests);
  assert.equal(results.length, 2);
  for (let i = 0; i < results.length; i++) {
    const { evidence, provenance, commit } = results[i];
    assert.equal(evidence.windowEnd, requests[i].windowEnd);
    assert.equal(evidence.eligibleCount, null);
    assert.equal(evidence.populationDigest, null);
    assert.equal(evidence.coverageStatus, "unknown");
    assert.match(evidence.missingReason, /no independent protected native compile checker/i);
    assert.equal(evidence.costs, "not-measured");
    assert.equal(evidence.decision, "not-rated");
    assert.equal(commit, definition.sourceIdentity.revision);
    assert.ok(provenance.every(row => row.repository && row.kind && row.ref));
    for (const metric of definition.metrics) assert.equal(scoreMetric(metric.id, evidence), null);
  }
});

test("collector rejects backdated, invalid, reversed, future and unsupported requests", async () => {
  for (const bad of [
    { ...request, windowStart: "2026-01-01T00:00:00Z" },
    { ...request, windowEnd: "2026-02-30T09:00:00Z" },
    { ...request, windowStart: request.windowEnd },
    { ...request, observedAt: request.windowStart },
    { ...request, repository: "private/unapproved" },
    null,
  ]) await assert.rejects(() => collectBatch([bad]), /Invalid/);
});

test("native receipt authority cannot be fabricated through a context ledger", async () => {
  const directory = mkdtempSync(path.resolve(".cross-repo-value-test-"));
  try {
    const ledger = readJson("docs/operational-value/proof/daily-aw-cross-repo-compile-check/native.json");
    ledger.authorities = ["a".repeat(40)];
    const file = path.join(directory, "forged.json");
    writeFileSync(file, JSON.stringify(ledger));
    await assert.rejects(() => collectBatch([request], { nativeArchive: file }), /authority activation requires review/);
    ledger.authorities = [];
    ledger.reports.push({ compatible: true });
    writeFileSync(file, JSON.stringify(ledger));
    await assert.rejects(() => collectBatch([request], { nativeArchive: file }), /frozen eligible population/);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("preserved complete source closure, provider response and discovery identities replay without shared paths", () => {
  const root = "docs/operational-value/proof/daily-aw-cross-repo-compile-check";
  const sources = readJson(`${root}/sources.json.gz`);
  assert.equal(sources.sources.length, 11);
  for (const source of sources.sources) {
    assert.equal(source.status, "preserved");
    const bytes = Buffer.from(source.content, "base64");
    assert.equal(bytes.length, source.bytes);
    assert.equal(sha256(bytes), source.sha256);
    assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), source.gitBlob);
  }
  const provider = readJson(`${root}/compiled-provider.json.gz`);
  const body = Buffer.from(provider.originalBody, "base64");
  assert.equal(sha256(body), provider.receipt.bodySha256);
  assert.equal(sha256(Buffer.from(provider.decodedBlob, "base64")), definition.sourceIdentity.compiledSha256);
  const discovery = readJson(`${root}/discovery.json.gz`);
  assert.equal(discovery.verifiedPartitions, 346);
  assert.equal(discovery.verifiedEntities, 58048);
  assert.equal(discovery.selected.length, 162);
  assert.equal(new Set(discovery.selected.map(row => row.id)).size, 162);
  const moduleText = readFileSync("docs/operational-value/proof/functions/daily-aw-cross-repo-compile-check.mjs", "utf8");
  assert.ok(!moduleText.includes("/Users/"));
  assert.equal(discovery.index.repositoryId, 1036865607);
});
