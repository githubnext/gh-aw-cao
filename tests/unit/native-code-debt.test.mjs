import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { definition as simplifierDefinition, collectBatch, scoreMetric } from "../../docs/operational-value/proof/functions/code-simplifier.mjs";
import * as aider from "../../docs/operational-value/proof/functions/daily-code-debt-aider.mjs";
import { base, cutoff, read, sourceCustody, verifyLock } from "../../docs/operational-value/proof/native-code-debt/custody.mjs";
import { analyze, consolidation, sha256 } from "../../docs/operational-value/proof/native-code-debt/native.mjs";
import { evaluateNative, unreachable } from "../../docs/operational-value/proof/native-code-debt/model.mjs";
import { objectBytes, validateCustody } from "../../docs/operational-value/proof/native-go-quality/custody.mjs";

const window = { windowStart: "2026-04-12T15:00:12Z", windowEnd: "2026-04-19T15:00:12Z", observedAt: "2026-04-19T15:00:12Z" };
const positive = simplifierDefinition.validationExamples.targetAttained;
const parse = (before, after) => analyze([{ id: "before.go", text: before }, { id: "after.go", text: after }]);

test("actual source proves one structural consolidation, not full behavioral acceptance", () => {
  const result = evaluateNative();
  assert.equal(result.result.value, 1);
  assert.equal(result.result.constructorChanged, true);
  assert.equal(result.rows.filter(row => row.value > 0).length, 1);
  assert.equal(result.selected.number, 26384);
  assert.equal(result.nativeUniverse.beforeFiles, 1709);
  assert.equal(result.nativeUniverse.afterFiles, 1709);
  assert.equal(result.nativeUniverse.beforePackageFiles, 935);
  assert.equal(result.nativeUniverse.parsedPackageFiles, 1870);
  assert.equal(result.nativeUniverse.priorRemovedSymbolIdentifiers, 4);
  assert.equal(result.nativeUniverse.afterRemovedSymbolIdentifiers, 0);
  assert.equal(result.fullGoalAcceptance, null);
  assert.equal(result.safeguards, null);
});

test("rejected predecessor predicates and original census contracts remain preserved", () => {
  const result = evaluateNative();
  assert.equal(result.rejected.length, 3);
  assert.ok(result.rejected.every(row => row.nativeValue === 0));
  const discovery = read(new URL("discovery.json.gz", base));
  assert.equal(discovery.contractSha256, sha256(readFileSync(new URL("contract-v1.json", base))));
  assert.equal(discovery.originalCensus.length, 2);
  assert.ok(discovery.originalCensus.every(row => row.measureKind === "unresolved"));
});

test("native positive and negative fixtures test semantics, never historical delivery", () => {
  for (const module of [{ definition: simplifierDefinition, scoreMetric }, aider]) {
    assert.equal(module.scoreMetric("native-partial", module.definition.validationExamples.targetAttained), 1);
    assert.equal(module.scoreMetric("native-partial", module.definition.validationExamples.targetMissed), 0);
    assert.equal(module.scoreMetric("native-partial", module.definition.validationExamples.missing), null);
    assert.equal(module.scoreMetric("native-partial", module.definition.validationExamples.malformed), null);
  }
  assert.equal(scoreMetric("unknown-metric", positive), null);
});

test("changed native algorithm, forwarding, import or dependent error helper is rejected", () => {
  const changes = [
    text => text.replace("return cmd.Output()", "return cmd.CombinedOutput()"),
    text => text.replace("return RunGHContext(context.Background(),spinnerMessage,args...)", "return RunGHCombinedContext(context.Background(),spinnerMessage,args...)"),
    text => text.replace('import "context"', 'import context "example.invalid/context"'),
    text => text.replace("return err", "return nil"),
  ];
  for (const change of changes) {
    const input = { ...positive, after: change(positive.after) };
    assert.notEqual(input.after, positive.after);
    assert.equal(scoreMetric("native-partial", input), 0);
  }
});

test("malformed native syntax and entry directives never become clean observations", () => {
  assert.equal(consolidation(...parse(positive.before, "package broken func(")).value, null);
  assert.equal(scoreMetric("native-partial", { ...positive, before: positive.before.replace("package workflow", "//go:linkname external remote\npackage workflow") }), null);
  assert.equal(unreachable(...parse("package p\nfunc broken(", "package p")), null);
});

test("methods, init, exported funcs, recursion and function values do not prove dead code", () => {
  for (const before of [
    "package p\ntype T struct{}\nfunc(t T) unused(){}\n",
    "package p\nfunc init(){}\n",
    "package p\nfunc Public(){}\n",
    "package p\nfunc recursive(){recursive()}\n",
    "package p\nfunc held(){}\nvar callback=held\n",
  ]) assert.equal(unreachable(...parse(before, "package p\n")), 0);
});

test("Aider failure-linked plumbing changes do not become code-debt outcomes", async () => {
  const rows = evaluateNative().rows.filter(row => row.slug === "daily-code-debt-aider");
  assert.equal(rows.length, 6);
  assert.ok(rows.every(row => row.value === null));
  const request = { windowStart: "2026-08-14T15:00:12Z", windowEnd: "2026-08-21T15:00:12Z", observedAt: cutoff };
  const [collection] = await aider.collectBatch([request]);
  assert.equal(aider.scoreMetric("native-partial", collection.evidence), null);
  assert.equal(collection.evidence.wholeWorkflowValue, null);
});

test("delivery boundary is start-inclusive/end-exclusive and native case deduplicates", async () => {
  const at = evaluateNative().selected.mergedAt;
  const requests = [
    { windowStart: "2026-04-14T13:06:28Z", windowEnd: at, observedAt: cutoff },
    { windowStart: at, windowEnd: "2026-04-16T13:06:28Z", observedAt: cutoff },
  ];
  const rows = await collectBatch(requests);
  assert.equal(scoreMetric("native-partial", rows[0].evidence), null);
  assert.equal(scoreMetric("native-partial", rows[1].evidence), 1);
  assert.equal(rows.flatMap(row => row.evidence.nativeFacts).filter(row => row.value > 0).length, 1);
  assert.equal(new Set(evaluateNative().rows.map(row => row.id)).size, evaluateNative().rows.length);
});

test("overlapping, oversized, wrong-repository and malformed requests fail explicitly", async () => {
  await assert.rejects(collectBatch([window, window]), /Overlapping/);
  await assert.rejects(collectBatch([{ ...window, repository: "private/unapproved" }]), /Invalid/);
  await assert.rejects(collectBatch([{ ...window, windowStart: "2026-01-01T00:00:00Z" }]), /Invalid/);
  await assert.rejects(collectBatch([{ ...window, observedAt: "invalid" }]), /Invalid/);
});

test("forged evidence cannot supply native effects and routine collection is deterministic", async () => {
  const first = await collectBatch([window]), second = await collectBatch([window]);
  assert.deepEqual(first, second);
  const evidence = first[0].evidence;
  assert.equal(scoreMetric("native-partial", evidence), 1);
  assert.equal(scoreMetric("native-partial", { ...evidence, nativeFacts: [{ value: 999 }] }), 1);
  assert.equal(scoreMetric("native-partial", { ...evidence, caseIds: [...evidence.caseIds, "forged"] }), null);
  assert.equal(scoreMetric("native-partial", { ...evidence, instrument: "forged" }), null);
  assert.equal(scoreMetric("native-partial", { ...evidence, windowEnd: "2026-10-20T00:00:00Z" }), null);
});

test("missing original blob, byte tampering and unsafe paths fail custody validation", () => {
  const data = read(new URL("custody.json.gz", base));
  const objects = read(new URL("objects.json.gz", base));
  const source = data.paths.find(row => row.path === "pkg/workflow/github_cli.go" && row.blob);
  const object = objects.find(row => row.id === source.blob);
  assert.throws(() => objectBytes({ ...object, contentBase64: Buffer.from("forged").toString("base64") }), /custody/);
  assert.throws(() => validateCustody(data, objects.filter(row => row.id !== source.blob)), /Missing original/);
  assert.throws(() => sourceCustody().resolve(source.commit, "../unsafe.go"), /Unsafe/);
  assert.throws(() => verifyLock("0".repeat(64)), /lock changed/);
});

test("adoption and historical recent-change eligibility are independent immutable facts", () => {
  const result = evaluateNative(), custody = sourceCustody();
  assert.equal(result.eligibility.head, result.eligibility.recent[0].id);
  assert.ok(result.eligibility.recent[0].at < result.eligibility.runCreatedAt);
  assert.equal(result.eligibility.candidateListReceipt, null);
  for (const row of result.adoptions) {
    const actual = custody.commit(row.commit);
    assert.equal(actual.at, row.adoptedAt);
    assert.equal(custody.resolve(actual.parents[0], `.github/workflows/${row.slug}.md`), null);
    assert.equal(custody.resolve(actual.parents[0], `.github/workflows/${row.slug}.lock.yml`), null);
  }
});
