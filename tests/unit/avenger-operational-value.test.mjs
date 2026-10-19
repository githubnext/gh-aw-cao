import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assessNativeArchive, collectBatch, definition, scoreMetric } from "../../docs/operational-value/proof/functions/avenger.mjs";

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hash = value => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const rawHash = value => createHash("sha256").update(value).digest("hex");
const clone = value => structuredClone(value);
const start = "2026-10-18T06:32:44Z";
const end = "2026-10-18T15:00:12Z";
const request = { windowStart: start, windowEnd: end, observedAt: end };
const empty = () => JSON.parse(readFileSync(new URL("../../docs/operational-value/proof/avenger/native-evidence.json", import.meta.url)));
const conditionIdentity = condition => hash({
  repositoryId: 1036865607, rule: condition.rule, locus: condition.locus,
  predicateSha256: condition.predicateSha256, inputClassSha256: condition.inputClassSha256,
});

function receipt(archive, kind, payload, knownAt = "2026-10-18T09:10:00Z") {
  const raw = JSON.stringify(payload);
  const sha256 = rawHash(raw), ref = `fixture://${kind}/${sha256}`;
  if (!archive.receipts.some(row => row.sha256 === sha256)) {
    archive.receipts.push({ kind, ref, payload: raw, sha256, knownAt });
  }
  return { sha256, ref };
}

function bindCheck(archive, check, condition) {
  const native = check.native;
  native.sha256 = hash({ format: native.format, stdout: native.stdout, stderr: native.stderr, exitCode: native.exitCode });
  const requirement = receipt(archive, "branch-requirement", {
    headSha: check.headSha, job: check.plan.job, matrix: check.plan.matrix,
    repositoryId: 1036865607, enforcement: "required", predicateSha256: condition.predicateSha256,
  });
  check.requirement = { headSha: check.headSha, job: check.plan.job, matrix: check.plan.matrix,
    enforcement: "required", policySha256: requirement.sha256, providerRef: requirement.ref };
  const proof = receipt(archive, "protected-native-check", {
    repositoryId: check.repositoryId, headSha: check.headSha, workflowPath: check.workflowPath,
    runId: check.runId, jobId: check.jobId, attempt: check.attempt, appId: check.appId,
    plan: check.plan, nativeSha256: native.sha256, inputPaths: check.inputPaths,
    startedAt: check.startedAt, completedAt: check.completedAt,
    setup: check.setup, skipped: check.skipped, continueOnError: check.continueOnError, branch: check.branch,
  });
  check.providerSha256 = proof.sha256; check.providerRef = proof.ref;
}

function cover(archive, facets = definition.metrics.map(row => row.id)) {
  const inventory = receipt(archive, "native-coverage-inventory", {
    repositoryId: 1036865607, sourceRevision: definition.sourceProfile.revision,
    startAt: start, endAt: end, facets, conditions: archive.conditions.map(conditionIdentity).sort(),
    state: "exhaustive", comparison: "unchanged-native-predicates",
  });
  archive.coverage = [{ startAt: start, endAt: end, knownAt: "2026-10-18T09:10:00Z",
    status: "complete", facets, inventorySha256: inventory.sha256, inventoryRef: inventory.ref }];
}

function fixture() {
  const archive = empty();
  const condition = {
    category: "tests", rule: "literal-parser-condition", locus: "pkg/parser/parse_test.go",
    predicateSha256: "a".repeat(64), inputClassSha256: "b".repeat(64),
    establishedAt: "2026-10-18T07:00:00Z", origin: "original",
    package: "github.com/github/gh-aw/pkg/parser", test: "TestParse/regression",
  };
  const key = conditionIdentity(condition);
  const catalogue = receipt(archive, "condition-catalogue", { conditionKey: key,
    establishedAt: condition.establishedAt, origin: "original", rule: condition.rule,
    locus: condition.locus, predicateSha256: condition.predicateSha256,
    inputClassSha256: condition.inputClassSha256, equivalence: "independently-adjudicated" });
  condition.catalogueRef = catalogue.ref; condition.catalogueSha256 = catalogue.sha256;
  archive.conditions.push(condition);
  const parent = "1".repeat(40);
  const rawCommit = `tree ${"2".repeat(40)}\nparent ${parent}\nauthor Fixture <fixture@example.invalid> 1792309800 +0000\ncommitter Fixture <fixture@example.invalid> 1792309800 +0000\n\nFixture repair only\n`;
  const head = createHash("sha1").update(`commit ${Buffer.byteLength(rawCommit)}\0`).update(rawCommit).digest("hex");
  const plan = {
    ciBlob: definition.sourceProfile.ciBlob, makeBlob: definition.sourceProfile.makeBlob,
    predicateSha256: condition.predicateSha256,
    assertionInputsSha256: "9".repeat(64),
    toolchainSha256: "c".repeat(64), configurationSha256: "d".repeat(64),
    suppressionSha256: "e".repeat(64), scopeSha256: "f".repeat(64),
    argv: ["go", "test", "-json", "./pkg/parser"], job: "integration", matrix: { os: "ubuntu-latest" },
  };
  const check = (passed, sha, startedAt, completedAt, jobId) => {
    const native = { format: "go-test-jsonl", stdout: [
      { Action: "run", Package: condition.package, Test: condition.test },
      { Action: passed ? "pass" : "fail", Package: condition.package, Test: condition.test },
    ].map(row => JSON.stringify(row)).join("\n"), stderr: "", exitCode: passed ? 0 : 1 };
    const row = { repositoryId: 1036865607, branch: "main", headSha: sha, startedAt, completedAt,
      runId: "123", jobId, attempt: 1, appId: 15368, workflowPath: ".github/workflows/ci.yml",
      status: "completed", skipped: false, continueOnError: false, setup: "complete",
      plan: clone(plan), inputPaths: [condition.locus], native };
    bindCheck(archive, row, condition);
    return row;
  };
  const before = check(false, parent, "2026-10-18T07:00:00Z", "2026-10-18T07:10:00Z", "456");
  const after = check(true, head, "2026-10-18T09:00:00Z", "2026-10-18T09:10:00Z", "457");
  const landing = { repositoryId: 1036865607, branch: "main", at: "2026-10-18T08:30:00Z", commit: head,
    commitChain: [{ sha: head, raw: rawCommit, nextParent: parent }] };
  const landProof = receipt(archive, "main-landing", {
    repositoryId: 1036865607, commit: head, branch: "main", at: landing.at,
  });
  landing.providerRef = landProof.ref; landing.providerSha256 = landProof.sha256;
  archive.repairs.push({ conditionKey: key, knownAt: "2026-10-18T09:10:00Z", before, after, landing });
  cover(archive);
  return archive;
}

test("retained actual collector stays unavailable, not zero or exhausted, and preserves request order", async () => {
  const rows = await collectBatch([request, { ...request, windowStart: "2026-10-18T10:00:00Z" }]);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].evidence.windowStart, "2026-10-18T10:00:00Z");
  for (const row of rows) {
    assert.equal(scoreMetric("repairs", row.evidence), null);
    assert.equal(row.evidence.coverageStatus, "missing");
    assert.equal(row.evidence.eligibleCount, null);
    assert.match(row.evidence.missingReason, /not exhausted/);
    assert.ok(row.provenance.length >= 3);
    assert.equal(row.commit, definition.sourceProfile.revision);
  }
});

test("one independently protected native repair counts irrespective of human or workflow actor", () => {
  const evidence = assessNativeArchive(fixture(), request);
  assert.equal(scoreMetric("repairs", evidence), 1);
  assert.equal(scoreMetric("linked", evidence), null);
  assert.equal(scoreMetric("complete", evidence), null);
  assert.equal(evidence.maturityStatus, "interim");
  assert.equal(evidence.eligibleCount, 1);
});

test("full-goal gaps and unknown contribution preserve partial native progress", () => {
  const archive = fixture(); archive.coverage = [];
  const evidence = assessNativeArchive(archive, request);
  assert.equal(evidence.coverageStatus, "partial");
  assert.equal(evidence.partialNativeCounts.repairs, 1);
  assert.equal(scoreMetric("repairs", evidence), null);
  assert.equal(evidence.partialNativeCounts.complete, 0);
});

test("dedup conditions rather than PRs, attempts, reports or receipt count", () => {
  const archive = fixture();
  archive.repairs.push(clone(archive.repairs[0]));
  const duplicate = clone(archive.repairs[0]);
  duplicate.after.jobId = "458"; bindCheck(archive, duplicate.after, archive.conditions[0]);
  archive.repairs.push(duplicate);
  assert.equal(scoreMetric("repairs", assessNativeArchive(archive, request)), 1);
});

test("delivery windows are inclusive/exclusive, late evidence is not backdated or redelivered", () => {
  const archive = fixture();
  archive.repairs[0].knownAt = "2026-10-18T12:00:00Z";
  const early = assessNativeArchive(archive, { ...request, windowEnd: "2026-10-18T12:00:00Z" });
  const late = assessNativeArchive(archive, { ...request, windowStart: "2026-10-18T12:00:00Z" });
  assert.equal(early.partialNativeCounts.repairs, 0);
  assert.equal(late.partialNativeCounts.repairs, 1);
  const unknown = assessNativeArchive(archive, { ...request, windowEnd: "2026-10-18T10:00:00Z", observedAt: "2026-10-18T11:00:00Z" });
  assert.equal(unknown.partialNativeCounts.repairs, 0);
});

for (const [name, mutate] of [
  ["merge without a failing before", archive => { archive.repairs[0].before.native.exitCode = 0; }],
  ["overall green with no exercised testcase", archive => { archive.repairs[0].after.native.stdout = ""; }],
  ["skipped target", archive => { archive.repairs[0].after.native.stdout = archive.repairs[0].after.native.stdout.replace('"pass"', '"skip"'); }],
  ["masked check", archive => { archive.repairs[0].after.continueOnError = true; }],
  ["setup failure", archive => { archive.repairs[0].after.setup = "failed"; }],
  ["deleted target", archive => { archive.repairs[0].after.inputPaths = []; }],
  ["changed predicate", archive => { archive.repairs[0].after.plan.predicateSha256 = "1".repeat(64); }],
  ["new suppression", archive => { archive.repairs[0].after.plan.suppressionSha256 = "1".repeat(64); }],
  ["changed expected inputs or golden assertions", archive => { archive.repairs[0].after.plan.assertionInputsSha256 = "1".repeat(64); }],
  ["changed toolchain", archive => { archive.repairs[0].after.plan.toolchainSha256 = "1".repeat(64); }],
  ["different matrix", archive => { archive.repairs[0].after.plan.matrix.os = "windows-latest"; }],
  ["golden regeneration", archive => { archive.repairs[0].after.plan.argv.push("-update"); }],
  ["echo fabricated test output", archive => { archive.repairs[0].after.plan.argv = ["echo", "pass"]; }],
  ["invalid compiler/test output", archive => { archive.repairs[0].after.native.stdout = "not json"; }],
  ["not landed on main", archive => { archive.repairs[0].landing.branch = "feature"; }],
  ["wrong head", archive => { archive.repairs[0].after.headSha = "7".repeat(40); }],
  ["altered Git object", archive => { archive.repairs[0].landing.commitChain[0].raw += "changed"; }],
  ["post-pass landing", archive => { archive.repairs[0].landing.at = "2026-10-18T09:11:00Z"; }],
  ["missing independent receipts", archive => { archive.receipts = []; }],
]) {
  test(`reject ${name} without erasing the unresolved condition`, () => {
    const archive = fixture(); mutate(archive);
    const evidence = assessNativeArchive(archive, request);
    assert.equal(evidence.partialNativeCounts.repairs, 0);
    assert.equal(evidence.partialNativeCounts.incomplete, 1);
  });
}

test("validly re-digested changed suppression cannot manufacture acceptance", () => {
  const archive = fixture();
  archive.repairs[0].after.plan.suppressionSha256 = "1".repeat(64);
  bindCheck(archive, archive.repairs[0].after, archive.conditions[0]);
  assert.equal(assessNativeArchive(archive, request).partialNativeCounts.repairs, 0);
});

test("a new formatter receipt does not count mutating --write as a fixed-point check", () => {
  const archive = fixture(), condition = archive.conditions[0], record = archive.repairs[0];
  condition.category = "formatting";
  condition.locus = "pkg/parser/parse.go";
  const key = conditionIdentity(condition);
  record.conditionKey = key;
  for (const [check, dirty] of [[record.before, true], [record.after, false]]) {
    check.inputPaths = [condition.locus];
    check.plan.argv = ["gofmt", "-l"];
    check.native = { format: "go-fmt", stdout: dirty ? `${condition.locus}\n` : "", stderr: "", exitCode: 0 };
    bindCheck(archive, check, condition);
  }
  const catalogue = receipt(archive, "condition-catalogue", { conditionKey: key,
    establishedAt: condition.establishedAt, origin: "original", rule: condition.rule,
    locus: condition.locus, predicateSha256: condition.predicateSha256, inputClassSha256: condition.inputClassSha256,
    equivalence: "independently-adjudicated" });
  condition.catalogueRef = catalogue.ref; condition.catalogueSha256 = catalogue.sha256;
  assert.equal(assessNativeArchive(archive, request).partialNativeCounts.repairs, 1);
  record.after.plan.argv.push("-w");
  bindCheck(archive, record.after, condition);
  assert.equal(assessNativeArchive(archive, request).partialNativeCounts.repairs, 0);
});

test("body-only Avenger markers never become contribution or full-goal proofs", () => {
  const archive = fixture(), row = archive.repairs[0];
  row.contribution = { status: "receipt-verified", workflowId: "avenger", originalRunId: "100",
    sourceBlob: definition.sourceProfile.sourceBlob, providerRef: "edited-body",
    providerSha256: "a".repeat(64), acceptedCommit: row.after.headSha,
    conditionKey: row.conditionKey, kind: "protected-creation-receipt" };
  row.fullAcceptance = { headSha: row.after.headSha, sourceRevision: definition.sourceProfile.revision,
    introducedAssessment: "complete", introducedDefects: 0,
    commands: ["make fmt", "make lint", "make test-unit"].map(command => ({
      command, status: "passed", skipped: false, receiptSha256: "a".repeat(64), providerRef: "self-report",
    })), ciCoverage: "all-applicable-assertions", ciInventorySha256: "a".repeat(64), ciInventoryRef: "self-report" };
  const evidence = assessNativeArchive(archive, request);
  assert.equal(evidence.partialNativeCounts.repairs, 1);
  assert.equal(evidence.partialNativeCounts.linked, 0);
  assert.equal(evidence.partialNativeCounts.complete, 0);
});

test("independent protected contribution and full acceptance are separate diagnostic channels", () => {
  const archive = fixture(), row = archive.repairs[0];
  const contribution = { workflowId: "avenger", sourceBlob: definition.sourceProfile.sourceBlob,
    originalRunId: "100", acceptedCommit: row.after.headSha, conditionKey: row.conditionKey,
    kind: "protected-creation-receipt" };
  const proof = receipt(archive, "workflow-contribution", contribution);
  row.contribution = { ...contribution, status: "receipt-verified", providerRef: proof.ref, providerSha256: proof.sha256 };
  const commands = ["make fmt", "make lint", "make test-unit"].map(command => {
    const proof = receipt(archive, "protected-native-command", {
      headSha: row.after.headSha, command, status: "passed", skipped: false, independentlyExecuted: true,
    });
    return { command, status: "passed", skipped: false, receiptSha256: proof.sha256, providerRef: proof.ref };
  });
  const inventory = receipt(archive, "complete-ci-inventory", {
    headSha: row.after.headSha, sourceRevision: definition.sourceProfile.revision,
    coverage: "all-applicable-assertions", introducedAssessment: "complete", introducedDefects: 0,
    commands, bypassAssessment: "unchanged", nativeReceiptsVerified: true,
  });
  row.fullAcceptance = { headSha: row.after.headSha, sourceRevision: definition.sourceProfile.revision,
    introducedAssessment: "complete", introducedDefects: 0, commands,
    ciCoverage: "all-applicable-assertions", ciInventorySha256: inventory.sha256, ciInventoryRef: inventory.ref };
  const evidence = assessNativeArchive(archive, request);
  assert.equal(scoreMetric("repairs", evidence), 1);
  assert.equal(scoreMetric("complete", evidence), 1);
  assert.equal(scoreMetric("linked", evidence), 1);
  row.fullAcceptance.commands[0].skipped = true;
  const changed = assessNativeArchive(archive, request);
  assert.equal(scoreMetric("repairs", changed), 1);
  assert.equal(scoreMetric("complete", changed), null);
  assert.equal(scoreMetric("linked", changed), 1);
});

for (const [category, format, argv, fields, before, after, bad] of [
  ["lint", "golangci-json", ["golangci-lint", "run", "--output.json.path=stdout"],
    { diagnostic: "native original diagnostic" },
    { stdout: JSON.stringify({ Issues: [{ FromLinter: "literal-parser-condition", Text: "native original diagnostic",
      Pos: { Filename: "pkg/parser/parse_test.go" } }] }), stderr: "", exitCode: 1 },
    { stdout: '{"Issues":[]}', stderr: "", exitCode: 0 },
    { stdout: '{"Issues":[],"Error":"setup failed"}', stderr: "", exitCode: 0 }],
  ["formatting", "prettier-check", ["prettier", "--check", "pkg/parser/parse_test.go"], {},
    { stdout: "", stderr: "[warn] pkg/parser/parse_test.go", exitCode: 1 },
    { stdout: "All matched files use Prettier code style!", stderr: "", exitCode: 0 },
    { stdout: "All matched files use Prettier code style!", stderr: "[warn] pkg/parser/parse_test.go", exitCode: 0 }],
  ["compile", "go-build", ["go", "build", "./pkg/parser"], { diagnostic: "42:3: undefined: originalSymbol" },
    { stdout: "", stderr: "pkg/parser/parse_test.go:42:3: undefined: originalSymbol", exitCode: 1 },
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: "", stderr: "runner: unavailable", exitCode: 0 }],
  ["wasm-golden", "go-test-jsonl", ["go", "test", "-json", "./pkg/workflow"],
    { package: "github.com/github/gh-aw/pkg/workflow", test: "TestWasmGolden_fixture" },
    { stdout: '{"Action":"run","Package":"github.com/github/gh-aw/pkg/workflow","Test":"TestWasmGolden_fixture"}\n{"Action":"fail","Package":"github.com/github/gh-aw/pkg/workflow","Test":"TestWasmGolden_fixture"}', stderr: "", exitCode: 1 },
    { stdout: '{"Action":"run","Package":"github.com/github/gh-aw/pkg/workflow","Test":"TestWasmGolden_fixture"}\n{"Action":"pass","Package":"github.com/github/gh-aw/pkg/workflow","Test":"TestWasmGolden_fixture"}', stderr: "", exitCode: 0 },
    { stdout: '{"Action":"run","Package":"github.com/github/gh-aw/pkg/workflow","Test":"TestWasmGolden_fixture"}\n{"Action":"skip","Package":"github.com/github/gh-aw/pkg/workflow","Test":"TestWasmGolden_fixture"}', stderr: "", exitCode: 0 }],
]) {
  test(`${format} native decoder accepts actual condition transitions, not setup errors or skips`, () => {
    const archive = fixture(), row = archive.repairs[0], condition = archive.conditions[0];
    Object.assign(condition, fields, { category });
    for (const [check, output] of [[row.before, before], [row.after, after]]) {
      check.plan.argv = argv;
      check.native = { format, ...output };
      bindCheck(archive, check, condition);
    }
    assert.equal(assessNativeArchive(archive, request).partialNativeCounts.repairs, 1);
    row.after.native = { format, ...bad };
    bindCheck(archive, row.after, condition);
    assert.equal(assessNativeArchive(archive, request).partialNativeCounts.repairs, 0);
  });
}

test("introduced defects require an independently passing predecessor, not a new failing report alone", () => {
  const archive = fixture(), row = archive.repairs.pop(), condition = archive.conditions[0];
  condition.origin = "introduced";
  const catalogue = receipt(archive, "condition-catalogue", { conditionKey: row.conditionKey,
    establishedAt: condition.establishedAt, origin: "introduced", rule: condition.rule,
    locus: condition.locus, predicateSha256: condition.predicateSha256,
    inputClassSha256: condition.inputClassSha256, equivalence: "independently-adjudicated" });
  condition.catalogueRef = catalogue.ref; condition.catalogueSha256 = catalogue.sha256;
  row.before.native.stdout = row.before.native.stdout.replace('"fail"', '"pass"');
  row.before.native.exitCode = 0;
  bindCheck(archive, row.before, condition);
  row.after.native.stdout = row.after.native.stdout.replace('"pass"', '"fail"');
  row.after.native.exitCode = 1;
  bindCheck(archive, row.after, condition);
  archive.introduced.push({ conditionKey: row.conditionKey, knownAt: row.knownAt,
    before: row.before, check: row.after, landing: row.landing });
  cover(archive);
  const evidence = assessNativeArchive(archive, request);
  assert.equal(evidence.partialNativeCounts.introduced, 1);
  assert.equal(evidence.partialNativeCounts.repairs, 0);
  delete archive.introduced[0].before;
  assert.equal(assessNativeArchive(archive, request).partialNativeCounts.introduced, 0);
});

test("unbound coverage cannot invent a zero population", () => {
  const archive = empty();
  archive.coverage = [{ startAt: start, endAt: end, knownAt: end, status: "complete",
    facets: ["repairs"], inventorySha256: "a".repeat(64), inventoryRef: "unretained" }];
  assert.equal(scoreMetric("repairs", assessNativeArchive(archive, request)), null);
});

test("archive corruption, mismatched repository, conflicts and invalid windows fail explicitly", () => {
  const archive = fixture();
  archive.receipts[0].payload += " ";
  assert.throws(() => assessNativeArchive(archive, request), /producer receipt/);
  assert.throws(() => assessNativeArchive({ ...empty(), repositoryId: 1 }, request), /native archive/);
  assert.throws(() => assessNativeArchive(empty(), { ...request, windowEnd: start }), /window/);
  const conflict = fixture();
  conflict.conditions.push({ ...conflict.conditions[0], category: "compile" });
  assert.throws(() => assessNativeArchive(conflict, request), /Conflicting condition/);
});

test("actual collector accepts portable retained input paths without turning test fixtures into history", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "avenger-native-test-"));
  try {
    const file = path.join(directory, "native.json");
    writeFileSync(file, JSON.stringify(fixture()));
    const [row] = await collectBatch([request], { nativeEvidenceFile: file });
    assert.equal(scoreMetric("repairs", row.evidence), 1);
    const [actual] = await collectBatch([request]);
    assert.equal(scoreMetric("repairs", actual.evidence), null);
  } finally { rmSync(directory, { recursive: true }); }
});

test("current predicates are never backdated to workflow adoption or projected after cutoff", () => {
  const historical = assessNativeArchive(empty(), { ...request, windowStart: "2026-05-24T00:06:12Z" });
  assert.equal(scoreMetric("repairs", historical), null);
  assert.match(historical.missingReason, /outside the reviewed/);
  const future = assessNativeArchive(empty(), { ...request, windowEnd: "2026-10-19T00:00:00Z", observedAt: "2026-10-19T00:00:00Z" });
  assert.equal(scoreMetric("repairs", future), null);
});
