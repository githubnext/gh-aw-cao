import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { brotliDecompressSync } from "node:zlib";
import { observationWindows } from "../../.github/skills/add-operational-value/scripts/common.mjs";
import { readOutputHistory } from "../../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { gitId, objectBytes, readBootstrap, sha256, validateCustody } from "../../docs/operational-value/proof/go-dependency/custody.mjs";
import { analyzeAssertions, assertionTransitions, compareVersions, dependencyTarget,
  readGoRequirements } from "../../docs/operational-value/proof/go-dependency/native.mjs";
import { publicScope, response } from "../../docs/operational-value/proof/go-dependency/evidence.mjs";

const archive = () => JSON.parse(brotliDecompressSync(readFileSync(
  new URL("../../docs/operational-value/proof/go-dependency/cache-originals.json.br", import.meta.url))));
const mod = (version, suffix = "") => `module example.com/test\n\ngo 1.25\n\nrequire (\n github.com/example/module ${version}${suffix}\n)\n`;
const target = { module: "github.com/example/module", from: "v1.2.3", to: "v1.2.4" };
const originalResponse = (endpoint, body, status = 200) => {
  const bytes = Buffer.from(JSON.stringify(body));
  return { endpoint, status, bytes: bytes.length, sha256: sha256(bytes), contentBase64: bytes.toString("base64") };
};

test("public original authority and endpoint gaps are explicit and digest-bound", () => {
  const metadata = { id: 1036865607, full_name: "github/gh-aw", private: false, visibility: "public" };
  const originals = { schemaVersion: 1, repository: "github/gh-aw", repositoryId: 1036865607,
    responses: [originalResponse("repos/github/gh-aw", metadata),
      originalResponse("repos/github/gh-aw/issues/14507", { message: "Gone" }, 410)] };
  assert.doesNotThrow(() => publicScope(originals));
  const absent = response(originals, "repos/github/gh-aw/issues/14507");
  assert.equal(absent.available, false);
  assert.equal(absent.status, 410);
  assert.match(absent.reason, /not absent or exhausted/);
  assert.throws(() => response(originals, "repos/github/gh-aw/issues/99999"), /Missing or repeated/);
  const privateScope = structuredClone(originals);
  privateScope.responses[0] = originalResponse("repos/github/gh-aw", { ...metadata, private: true, visibility: "private" });
  assert.throws(() => publicScope(privateScope), /authority/);
  const tampered = structuredClone(originals);
  tampered.responses[0].contentBase64 = Buffer.from("{}").toString("base64");
  assert.throws(() => publicScope(tampered), /digest/);
});

test("all three bootstrap originals verify byte count, SHA256 and Git blob identity", () => {
  const source = readBootstrap();
  assert.equal(source.data.objects.length, 3);
  assert.equal(source.data.unresolved.length, 12);
  assert.match(source.source("go-fan"), /Identify Improvements/);
  assert.match(source.source("dependabot-go-checker"), /Only direct dependencies/);
  assert.match(source.source("dependabot-burner"), /generated workflow manifests/);
  for (const original of source.data.objects) {
    const row = { ...original, type: "blob", id: original.gitBlob };
    for (const changed of [
      { ...row, bytes: row.bytes + 1 },
      { ...row, sha256: "0".repeat(64) },
      { ...row, id: "0".repeat(40) },
      { ...row, contentBase64: Buffer.from("tampered").toString("base64") },
    ]) assert.throws(() => objectBytes(changed), /custody/);
  }
});

test("introduction anchors prove source absent at the actual parent, not at a shallow boundary", () => {
  const custody = validateCustody(archive());
  for (const [commit, slug] of [
    ["25b31e7ac6b7a7f7391d08a635d8f22966473e8d", "dependabot-burner"],
    ["f48714272a9fe7996be9f88a50fbd8ec357c1a62", "dependabot-go-checker"],
    ["6c88dcebd6f034b5f08a8cdea593611dba812358", "go-fan"],
  ]) {
    const info = custody.commit(commit), file = `.github/workflows/${slug}.md`;
    assert.equal(info.parents.length, 1);
    assert.match(custody.resolve(commit, file), /^[a-f0-9]{40}$/);
    assert.equal(custody.resolve(info.parents[0], file), null);
    assert.throws(() => custody.source(commit, file), /Only path identity/);
  }
});

test("missing, tampered, duplicate and substituted commit/tree/path custody fails closed", () => {
  const data = archive();
  assert.ok(data.paths.some(row => row.proofOnly));
  const changed = structuredClone(data);
  changed.objects[0].contentBase64 = Buffer.from("bad").toString("base64");
  assert.throws(() => validateCustody(changed), /custody/);
  const missing = structuredClone(data);
  missing.objects = missing.objects.filter(row => row.type !== "tree");
  assert.throws(() => validateCustody(missing), /Missing original tree/);
  assert.throws(() => validateCustody({ ...data, objects: [...data.objects, data.objects[0]] }), /Repeated/);
  const swapped = structuredClone(data);
  swapped.paths[0].blob = "0".repeat(40);
  assert.throws(() => validateCustody(swapped), /path proof/);
  const unsafe = structuredClone(data);
  unsafe.paths[0].path = "../go.mod";
  assert.throws(() => validateCustody(unsafe), /Unsafe/);
  const bytes = Buffer.from("same bytes are not a commit");
  assert.notEqual(gitId("blob", bytes), gitId("commit", bytes));
  assert.equal(sha256(bytes).length, 64);
});

test("native dependency target requires exact monotonic old/new direct pins and excludes major recommendations", () => {
  assert.equal(dependencyTarget(mod("v1.2.3"), mod("v1.2.4"), target).value, 1);
  assert.equal(dependencyTarget(mod("v1.2.3"), mod("v1.2.3"), target).value, 0);
  assert.equal(dependencyTarget(mod("v1.2.3"), mod("v1.2.5"), target).value, 0);
  assert.equal(dependencyTarget(mod("v1.2.4"), mod("v1.2.3"), { ...target, from: "v1.2.4", to: "v1.2.3" }).value, 0);
  assert.equal(dependencyTarget(mod("v1.2.3", " // indirect"), mod("v1.2.4", " // indirect"), target).value, 0);
  assert.equal(dependencyTarget(mod("v0.2.3"), mod("v1.0.0"), { ...target, from: "v0.2.3", to: "v1.0.0" },
    { skipMajor: true }).value, 0);
  assert.equal(dependencyTarget("broken", mod("v1.2.4"), target).value, null);
  assert.equal(readGoRequirements(`${mod("v1.2.3")}\nreplace example.com/dep => ../local`).get(target.module).replaced, false);
  assert.equal(dependencyTarget(`${mod("v1.2.3")}\nreplace ${target.module} => ../local`, mod("v1.2.4"), target).value, null);
  assert.equal(readGoRequirements("module x\nrequire (\n nope\n"), null);
  assert.equal(compareVersions("v0.0.0-20260727090823-41c9e6be3365", "v0.0.0-20260720091843-3eef36eaaa28"), 1);
  assert.equal(compareVersions("v1.2.3-rc.2", "v1.2.3-rc.10"), -1);
  assert.equal(compareVersions("v1.2.3-rc.10", "v1.2.3"), -1);
  assert.equal(compareVersions("v1.2.3+incompatible", "v1.2.3"), 0);
  assert.equal(compareVersions("latest", "v1.2.3"), null);
});

test("native Go AST ignores comments, strings, unrelated imports and shadowed aliases", () => {
  const prefix = 'package test\nimport ("testing"; "github.com/stretchr/testify/assert"; "github.com/stretchr/testify/require")\n';
  const before = `${prefix}func TestNative(t *testing.T) { assert.Contains(t, err.Error(), "wanted") }`;
  const after = `${prefix}func TestNative(t *testing.T) { require.ErrorContains(t, err, "wanted") }`;
  const alternatives = [
    after,
    `${prefix}func TestNative(t *testing.T) { _ = "require.ErrorContains(t, err, wanted)" }`,
    `${prefix}func TestOther(t *testing.T) { require.ErrorContains(t, err, "wanted") }`,
    `${prefix}func TestNative(t *testing.T) { require.ErrorContains(t, err, "different") }`,
    `${prefix}func TestNative(t *testing.T) { require := fake; require.ErrorContains(t, err, "wanted") }`,
    'package test\nfunc broken(',
  ];
  const parsed = analyzeAssertions([{ id: "before", text: before },
    ...alternatives.map((text, index) => ({ id: String(index), text }))]);
  assert.equal(assertionTransitions(parsed[0], parsed[1]).value, 1);
  for (let index = 2; index < 6; index++) assert.equal(assertionTransitions(parsed[0], parsed[index]).value, 0);
  assert.equal(assertionTransitions(parsed[0], parsed[6]).value, null);
});

test("real retained Go Fan implementation delivers exactly ten scoped structural API-migration sites", () => {
  const custody = validateCustody(archive());
  const parent = "aeb6e06c91a0b9bcc2f46f97c2c2bb18f4d4d43a", commit = "dd0929deabfd59e9977572d67733e20b747988f1";
  assert.equal(custody.commit(commit).parents[0], parent);
  const paths = ["pkg/console/confirm_test.go", "pkg/console/list_test.go", "pkg/fileutil/fileutil_test.go"];
  const inputs = paths.flatMap(file => [parent, commit].map(commit => ({
    id: `${commit}:${file}`, text: custody.source(commit, file),
  })));
  const parsed = analyzeAssertions(inputs);
  const values = paths.map((_, index) => assertionTransitions(parsed[2 * index], parsed[2 * index + 1]).value);
  assert.deepEqual(values, [1, 1, 8]);
  assert.equal(values.reduce((sum, value) => sum + value, 0), 10);
});

test("production discovery exhausts and verifies all partitions before selecting cohort candidates", () => {
  const history = readOutputHistory(new URL("../../docs/operational-value/gh-aw-workflows/evidence", import.meta.url).pathname);
  assert.equal(history.index.complete, true);
  assert.equal(history.index.repositoryId, 1036865607);
  assert.equal(history.index.partitions.length, 346);
  assert.equal(history.entities.length, 58048);
  assert.equal(history.index.sourceRevision, "c86377ec47b38f0b5af463277ee55d1d03d08da8");
  assert.equal(history.index.until, "2026-10-18T15:00:12Z");
});

test("all three real collectors preserve exact native quantities, unknown semantics and disjoint cutoff-aligned periods", async () => {
  const until = "2026-10-18T15:00:12Z";
  for (const [slug, quantities, count] of [
    ["dependabot-burner", [4, 3], 38],
    ["dependabot-go-checker", [1, 2, 1], 50],
    ["go-fan", [10], 47],
  ]) {
    const module = await import(`../../docs/operational-value/proof/functions/${slug}.mjs`);
    const { definition, collectBatch, scoreMetric } = module;
    const windows = observationWindows(definition, definition.adoption.adoptedAt, until);
    assert.equal(windows.length, count);
    assert.equal(windows.at(-1).windowEnd, until);
    assert.equal(windows[0].windowStart, definition.adoption.adoptedAt);
    for (let index = 1; index < windows.length; index++) assert.equal(windows[index - 1].windowEnd, windows[index].windowStart);
    const first = await collectBatch(windows), second = await collectBatch(windows);
    assert.deepEqual(second, first);
    const scores = first.map(row => scoreMetric("native-partial", row.evidence));
    assert.deepEqual(scores.filter(value => value !== null), quantities);
    assert.deepEqual(first.map(row => scoreMetric("corroborated-partial", row.evidence)).filter(value => value !== null), quantities);
    assert.ok(scores.some(value => value === null));
    for (const row of first) {
      assert.equal(row.evidence.strictFullGoalAcceptance, null);
      assert.equal(row.evidence.actualCosts, null);
      assert.equal(row.evidence.completeComparablePeriod, false);
      assert.equal(row.evidence.keepDecision, "not rated");
      assert.equal(row.evidence.fullEligiblePopulation, null);
    }
    const positive = first.find(row => scoreMetric("native-partial", row.evidence) > 0).evidence;
    assert.equal(scoreMetric("native-partial", { ...positive, caseIds: [] }), null);
    assert.equal(scoreMetric("native-partial", { ...positive, profilesSha256: "0".repeat(64) }), null);
    assert.equal(scoreMetric("native-partial", { ...positive, windowStart: "bad" }), null);
    assert.equal(scoreMetric("invented", positive), null);
    await assert.rejects(() => collectBatch([{ ...windows[0], repository: "different/repo" }]), /repository/);
    const boundary = windows.find(window => first[windows.indexOf(window)].evidence.nativeFacts.length);
    const adjacent = [
      { ...boundary, windowEnd: boundary.windowStart },
    ];
    await assert.rejects(() => collectBatch(adjacent), /windows/);
    const postCutoff = await collectBatch([{ windowStart: until, windowEnd: "2026-10-19T15:00:12Z",
      observedAt: "2026-10-19T15:00:12Z" }]);
    assert.equal(scoreMetric("native-partial", postCutoff[0].evidence), null);
  }
});
