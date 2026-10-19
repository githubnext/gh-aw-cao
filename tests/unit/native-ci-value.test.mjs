import assert from "node:assert/strict";
import test from "node:test";
import { readJsonArchive } from "../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { validateCustody } from "../../docs/operational-value/proof/native-go-quality/custody.mjs";
import { analyzeCiSources, assessCiEvidence, nativeCiModule, verifyFuzzTransition } from "../../scripts/native-ci-value.mjs";

const { data, originals } = readJsonArchive("docs/operational-value/proof/native-ci/native-sources.json.gz");
const custody = validateCustody(data, originals);
const [beforeInventory, afterInventory] = data.inventories;
const before = custody.source(beforeInventory.commit, ".github/workflows/ci.yml");
const after = custody.source(afterInventory.commit, ".github/workflows/ci.yml");
const files = Object.fromEntries(beforeInventory.tests.map(row => [row.path, custody.source(beforeInventory.commit, row.path)]));

test("actual-parent native selection restores nine conditional targets, not eleven observed executions", () => {
  const assessment = assessCiEvidence();
  assert.equal(assessment.nativeSubtotal, 9);
  assert.equal(assessment.parsedFiles, 665);
  assert.equal(assessment.nativeTargets, 24);
  assert.equal(assessment.originalInvocations, 13);
  assert.equal(assessment.newInvocations, 24);
  assert.equal(assessment.targetCodeExecuted, false);
  assert.equal(assessment.fullAcceptance, null);
  assert.equal(assessment.costs, null);
  assert.deepEqual(assessment.rejected.map(row => row.reason), ["ambiguous-or-missing-selector", "after-failing-selector"]);
  assert.deepEqual(assessment.rejected[0].matches, ["FuzzParseInputDefinition", "FuzzParseInputDefinitions"]);
  assert.equal(assessment.contribution.receiptVerified, null);
  assert.equal(assessment.runBinding.headSha, "f1263e844a3510978484d69336e0f9245ebe3962");
  assert.equal(assessment.ambiguousSelectorWitness.exitCode, 1);
});

test("unrelated edits, removed calls and duplicate invocations cannot masquerade as additive coverage", () => {
  assert.throws(() => verifyFuzzTransition(before, after + "\n# unrelated edit\n", files), /Unexpected CI changes/);
  const removed = after.replace('          run_fuzz_test "FuzzParseFrontmatter" "./pkg/parser/"\n', "");
  assert.throws(() => verifyFuzzTransition(before, removed, files), /Unexpected CI changes/);
  const duplicated = after.replace('          run_fuzz_test "FuzzRuntimeImportExpressionValidation" "./pkg/parser/"\n',
    '          run_fuzz_test "FuzzRuntimeImportExpressionValidation" "./pkg/parser/"\n'.repeat(2));
  assert.throws(() => verifyFuzzTransition(before, duplicated, files), /Duplicate new selector/);
});

test("changed gating, unsupported shell handling and unchanged configurations fail closed", () => {
  assert.throws(() => verifyFuzzTransition(before, after.replace("if: github.ref == 'refs/heads/main'", "if: false"), files));
  assert.throws(() => verifyFuzzTransition(before, after.replace("  fuzz:\n", "  fuzz:\n    continue-on-error: true\n"), files),
    /Unsupported shell or error handling/);
  assert.throws(() => verifyFuzzTransition(before, before, files));
});

test("Go AST rejects malformed and non-native fuzz definitions", () => {
  assert.throws(() => analyzeCiSources({ files: { "pkg/parser/broken_test.go": "package parser\nfunc {" } }));
  assert.throws(() => analyzeCiSources({ files: { "pkg/parser/wrong_test.go":
    'package parser\nimport "testing"\nfunc FuzzWrong(t *testing.T) {}\n' } }));
});

test("source custody and pinned implementation drift are explicit failures", () => {
  const mutated = structuredClone(originals);
  mutated[0].contentBase64 = Buffer.from("altered native source").toString("base64");
  assert.throws(() => validateCustody(data, mutated), /custody mismatch/);
  assert.throws(() => nativeCiModule({ "scripts/native-ci-value.mjs": "0".repeat(64) }), /Dependency changed/);
});

test("native build constraints exclude ineligible definitions and honor testing import aliases", () => {
  const native = analyzeCiSources({ files: {
    "pkg/parser/native_test.go": 'package parser\nimport native "testing"\nfunc FuzzNative(f *native.F) { f.Fuzz(func(t *native.T, s string) {}) }\n',
    "pkg/parser/tagged_test.go": '//go:build integration\n\npackage parser\nimport "testing"\nfunc FuzzTagged(f *testing.F) { f.Fuzz(func(t *testing.T, s string) {}) }\n',
    "pkg/parser/windows_windows_test.go": 'package parser\nimport "testing"\nfunc FuzzWindows(f *testing.F) { f.Fuzz(func(t *testing.T, s string) {}) }\n',
  }, selections: [{ package: "./pkg/parser/", pattern: "Fuzz" }] });
  assert.deepEqual(native.selections[0].matches, ["FuzzNative"]);
  assert.equal(native.targets[0].fuzzBody, true);
  assert.equal(native.excludedFiles.length, 2);
});

test("ordinary lowercase helpers and conditionally shadowed receivers do not establish a native fuzz body", () => {
  const native = analyzeCiSources({ files: {
    "pkg/parser/shadow_test.go": 'package parser\nimport "testing"\nfunc Fuzzhelper(value string) {}\nfunc FuzzShadow(f *testing.F) { if true { f := f; f.Fuzz(func(t *testing.T, s string) {}) } }\n',
  }, selections: [{ package: "./pkg/parser/", pattern: "Fuzz" }] });
  assert.deepEqual(native.targets.map(row => row.name), ["FuzzShadow"]);
  assert.equal(native.targets[0].fuzzBody, false);
});

test("disjoint mature periods count a delivery once and leave other periods unknown", () => {
  const module = nativeCiModule({});
  const request = { repository: "github/gh-aw", observedAt: "2026-10-18T15:00:12Z" };
  const observations = module.collectBatch([
    { ...request, windowStart: "2026-02-17T14:13:33Z", windowEnd: "2026-02-24T14:13:33Z" },
    { ...request, windowStart: "2026-02-24T14:13:33Z", windowEnd: "2026-03-03T14:13:33Z" },
    { ...request, windowStart: "2026-03-03T14:13:33Z", windowEnd: "2026-03-10T14:13:33Z" },
  ]);
  const metric = module.definition.metrics[0].id;
  assert.deepEqual(observations.map(row => module.scoreMetric(metric, row.evidence)), [null, 9, null]);
  assert.equal(observations[1].evidence.identities.length, 9);
  assert.deepEqual(observations[0].evidence.rejected, []);
  assert.equal(observations[1].evidence.rejected.length, 2);
  assert.deepEqual(observations[2].evidence.rejected, []);
  assert.equal(observations[1].evidence.fullAcceptance, null);
  assert.equal(module.scoreMetric(metric, { schemaVersion: 1, native: -1 }), null);
  assert.throws(() => module.scoreMetric("wrong", {}), /Unknown metric/);
});

test("overlapping, invalid-calendar, immature and out-of-scope requests fail explicitly", () => {
  const module = nativeCiModule({});
  const request = { repository: "github/gh-aw", windowStart: "2026-02-24T14:13:33Z",
    windowEnd: "2026-03-03T14:13:33Z", observedAt: "2026-10-18T15:00:12Z" };
  assert.throws(() => module.collectBatch([request, request]), /Overlapping delivery periods/);
  assert.throws(() => module.collectBatch([{ ...request, repository: "elsewhere/repository" }]), /escaped frozen scope/);
  assert.throws(() => module.collectBatch([{ ...request, observedAt: "2026-02-30T15:00:12Z" }]), /Invalid observation/);
  assert.throws(() => module.collectBatch([{ ...request, windowStart: "2026-02-30T15:00:12Z" }]), /valid RFC 3339/);
  assert.throws(() => module.collectBatch([{ ...request, observedAt: "2026-03-01T15:00:12Z" }]), /valid measurement period/);
  assert.throws(() => module.collectBatch([{ ...request, windowEnd: "2026-10-19T15:00:12Z",
    observedAt: "2026-10-20T15:00:12Z" }]), /escaped frozen cutoff/);
});
