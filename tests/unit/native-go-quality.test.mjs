import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { apiOriginals, base, cutoff, objectBytes, readCustody, readJson, sha256, validateCustody, verifyLock } from "../../docs/operational-value/proof/native-go-quality/custody.mjs";
import { evaluateNative } from "../../docs/operational-value/proof/native-go-quality/model.mjs";
import { analyze, transitions } from "../../docs/operational-value/proof/native-go-quality/native.mjs";

const prefix = 'package p\nimport("testing";"github.com/stretchr/testify/assert";"github.com/stretchr/testify/require")\n';
const testcase = (body, parameter = "t *testing.T") => `${prefix}func TestNative(${parameter}){${body}}\n`;
const transition = (before, after, slug = "daily-testify-uber-super-expert") => transitions(...analyze([
  { id: "before.go", text: before }, { id: "after.go", text: after },
]), slug);
const prerequisites = fatal => testcase(`daysFlag:=cmd.Flags().Lookup("days");${fatal ? "require" : "assert"}.NotNil(t,daysFlag);assert.Equal(t,"7",daysFlag.DefValue)`);

test("all original Git objects, actual parents and both source/compiled adoption paths verify", () => {
  verifyLock();
  const custody = readCustody();
  assert.equal(custody.data.missing.length, 0);
  for (const workflow of custody.data.workflows) {
    const { commit, parent, adoptedAt } = workflow.adoption;
    assert.equal(custody.commit(commit).parents[0], parent);
    assert.equal(custody.commit(commit).at, adoptedAt);
    for (const suffix of ["md", "lock.yml"]) {
      const file = `.github/workflows/${workflow.slug}.${suffix}`;
      assert.equal(custody.resolve(parent, file), null);
      assert.match(custody.resolve(commit, file), /^[a-f0-9]{40}$/);
      assert.ok(custody.source(commit, file));
    }
  }
});

test("source custody rejects changed bytes, wrong paths, missing trees and repeated objects", () => {
  const data = readJson(new URL("custody.json.gz", base));
  const objects = data.partitions.flatMap(part => readJson(new URL(part.file, base)));
  const bad = { ...objects[0], bytes: objects[0].bytes + 1 };
  assert.throws(() => objectBytes(bad), /custody/);
  assert.throws(() => objectBytes({ ...objects[0], id: "0".repeat(40) }), /custody/);
  assert.throws(() => validateCustody(data, [...objects, objects[0]]), /Repeated/);
  assert.throws(() => validateCustody(data, objects.filter(row => row.type !== "tree")), /Missing original tree/);
  const changed = structuredClone(data);
  changed.paths[0].blob = "0".repeat(40);
  assert.throws(() => validateCustody(changed, objects), /custody/);
  const unsafe = structuredClone(data);
  unsafe.paths[0].path = "../escape";
  assert.throws(() => validateCustody(unsafe, objects), /Unsafe/);
});

test("original public authority, exact pinned dependency blobs, graph gaps and unmarked detector finding are retained", () => {
  const rows = apiOriginals();
  const scope = rows.find(row => row.file === "repository.json.gz").body;
  assert.equal(scope.private, false);
  assert.equal(scope.id, 1036865607);
  assert.ok(rows.some(row => row.body.errors?.some(error => error.type === "NOT_FOUND" && error.path.includes("i27624"))));
  const detector = rows.find(row => row.file === "pattern-graph.json.gz").body.data.repository.i4145;
  assert.equal(detector.timelineItems.pageInfo.hasNextPage, false);
  assert.ok(detector.timelineItems.nodes.some(event => event.source?.mergeCommit?.oid === "d89c7e0caa25d407ba7aa40c64a97facc2adfa24"));
  assert.ok(rows.filter(row => row.file.startsWith("standard-") && row.body.content).length === 4);
  assert.equal(evaluateNative().standardProof, true);
});

test("native logger predicate counts only guarded pre-existing computations, never log additions", () => {
  const source = body => `package p\nimport "github.com/github/gh-aw/pkg/logger"\nvar log=logger.New("p:f")\nfunc Run(){${body}}\n`;
  const before = source('log.Printf("%s", compute())');
  assert.equal(transition(before, source('if log.Enabled(){log.Printf("%s",compute())}'), "go-logger").value, 1);
  assert.equal(transition(source(""), before, "go-logger").value, 0);
  assert.equal(transition(before, before, "go-logger").value, 0);
  assert.equal(transition(before, source('if other.Enabled(){log.Printf("%s",compute())}'), "go-logger").value, 0);
  assert.equal(transition(before, source('log:=fake; if log.Enabled(){log.Printf("%s",compute())}'), "go-logger").value, 0);
  assert.equal(transition(before, source('if log.Enabled(){log.Printf("%s",different())}'), "go-logger").value, 0);
  assert.equal(transition(before, source('if log.Enabled(){log.Printf("%s",compute());log.Printf("%s",compute())}'), "go-logger").value, 0);
  assert.equal(transition(source('log.Printf("%d", len(items))'), source('if log.Enabled(){log.Printf("%d", len(items))}'), "go-logger").value, 0);
});

test("native fatal prerequisites require a real testing.T and an unchanged immediate dependent access", () => {
  assert.equal(transition(prerequisites(false), prerequisites(true)).value, 1);
  const before = testcase('assert.NotNil(t,ptr);assert.Equal(t,"x",ptr.Name)');
  assert.equal(transition(before, testcase('require.NotNil(t,ptr);assert.Equal(t,"x",ptr.Name)')).value, 1);
  assert.equal(transition(before, testcase('require.NotNil(t,other);assert.Equal(t,"x",ptr.Name)')).value, 0);
  assert.equal(transition(before, testcase('require.NotNil(t,ptr);if ok{assert.Equal(t,"x",ptr.Name)}')).value, 0);
  assert.equal(transition(testcase('assert.NotNil(t,ptr);ptr.Name()'), testcase('require.NotNil(t,ptr);ptr.Name()')).value, 0);
  assert.equal(transition(testcase('assert.NotNil(t,ptr);unrelated()'), testcase('require.NotNil(t,ptr);unrelated()')).value, 0);
  assert.equal(transition(testcase('assert.NotNil(t,ptr);ptr.Name()', "t *Fake"), testcase('require.NotNil(t,ptr);ptr.Name()', "t *Fake")).value, 0);
  assert.equal(transition(before, testcase('require:=fake;require.NotNil(t,ptr);assert.Equal(t,"x",ptr.Name)')).value, 0);
  assert.equal(transition(prerequisites(false), prerequisites(true).replace('Lookup("days")', 'Lookup("other")')).value, 0);
  assert.equal(transition(before, "package p\nfunc broken(").value, null);
});

test("native JSON projection follows encoding/json rather than treating every dash-shaped tag as exclusion", () => {
  const source = tag => `package p\ntype Record struct{Name string \`json:"${tag}"\`}\n`;
  const rows = analyze(["-", "-,omitempty", "Name", "Name,omitempty"].map(tag => ({ id: tag, text: source(tag) })));
  assert.deepEqual(rows.map(row => row.jsonProjection), ["{}", '{"-":"value"}', '{"Name":"value"}', '{"Name":"value"}']);
  assert.deepEqual(rows.map(row => row.dashFields.length), [1, 0, 0, 0]);
  assert.equal(analyze([{ id: "bad", text: "not Go" }])[0].valid, false);
});

test("real useful native delivery is two nil flag-field continuations, not assertion substitutions or merges", () => {
  const result = evaluateNative();
  assert.equal(result.invalidFiles.length, 0);
  assert.deepEqual(result.witness, { fatalContinuationAvoidsPanic: true, nonfatalContinuationPanics: true });
  const accepted = result.rows.filter(row => row.value > 0);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].number, 28622);
  assert.equal(accepted[0].value, 2);
  assert.deepEqual(accepted[0].sites.map(row => row.argument), ["daysFlag", "thresholdFlag"]);
  assert.ok(accepted[0].corroborated);
  assert.equal(accepted[0].receiptBacked, null);
  assert.equal(new Set(accepted[0].sites.map(row => row.identity)).size, 2);
  assert.equal(result.rows.filter(row => row.slug === "go-pattern-detector" && row.value !== null).length, 0);
  assert.equal(result.rows.filter(row => row.slug === "go-logger" && row.value > 0).length, 0);
});

test("all three collectors are deterministic, fail closed, and do not invent no-case zeros", async () => {
  for (const slug of ["go-logger", "go-pattern-detector", "daily-testify-uber-super-expert"]) {
    const module = await import(`../../docs/operational-value/proof/functions/${slug}.mjs`);
    const request = { windowStart: module.definition.adoption.adoptedAt, windowEnd: cutoff, observedAt: cutoff };
    const first = await module.collectBatch([request]);
    assert.deepEqual(await module.collectBatch([request]), first);
    for (const key of ["fullGoalAcceptance", "safeguards", "actualCosts", "fullEligiblePopulation", "receiptBackedContribution"]) assert.equal(first[0].evidence[key], null);
    assert.equal(first[0].evidence.completeComparablePeriod, false);
    assert.equal(first[0].evidence.keepDecision, "not rated");
    assert.equal(module.scoreMetric("invented", first[0].evidence), null);
    assert.equal(module.scoreMetric("native-partial", { ...first[0].evidence, instrument: "bad" }), null);
    assert.equal(module.scoreMetric("native-partial", { ...first[0].evidence, caseIds: ["fake"] }), null);
    assert.equal(module.scoreMetric("native-partial", {}), null);
    await assert.rejects(() => module.collectBatch([{ ...request, repository: "private/target" }]), /repository/);
    await assert.rejects(() => module.collectBatch([{ ...request, windowEnd: "bad" }]), /windows/);
    const empty = { windowStart: request.windowStart, windowEnd: new Date(Date.parse(request.windowStart) + 1000).toISOString().replace(".000Z", "Z"), observedAt: cutoff };
    assert.equal(module.scoreMetric("native-partial", (await module.collectBatch([empty]))[0].evidence), null);
  }
});

test("delivery intervals are disjoint and one implementation cannot be counted on both sides of its boundary", async () => {
  const module = await import("../../docs/operational-value/proof/functions/daily-testify-uber-super-expert.mjs");
  const at = "2026-04-26T20:47:59Z";
  const requests = [
    { windowStart: module.definition.adoption.adoptedAt, windowEnd: at, observedAt: cutoff },
    { windowStart: at, windowEnd: cutoff, observedAt: cutoff },
  ];
  const results = await module.collectBatch(requests);
  const ids = results.map(row => new Set(row.evidence.caseIds));
  assert.equal([...ids[0]].filter(id => ids[1].has(id)).length, 0);
  assert.equal(module.scoreMetric("native-partial", results[0].evidence), 0);
  assert.equal(module.scoreMetric("native-partial", results[1].evidence), 2);
});

test("predecessor is unchanged, rejected method-only candidate remains explicit, and no keep bar exists", async () => {
  const version = readJson(new URL("contract-v2.json", base));
  assert.equal(version.predecessor.sha256, sha256(readFileSync(new URL("contracts-v1.json", base))));
  assert.equal(version.firstPass.testifyPotentialSites, 3);
  assert.equal(version.firstPass.acceptedAfterIndependentLibraryProof, 2);
  assert.match(version.firstPass.rejected[0].reason, /not automatically/);
  for (const slug of ["go-logger", "go-pattern-detector", "daily-testify-uber-super-expert"]) {
    const { definition } = await import(`../../docs/operational-value/proof/functions/${slug}.mjs`);
    assert.equal(definition.review, undefined);
    assert.equal(definition.limitations.fullGoalAcceptance, null);
    assert.match(definition.evidence.authoring, /outcome-informed retrospective/);
  }
});

test("standard report periods remain cutoff-aligned, disjoint, source-native and source-bound", async () => {
  for (const [slug, periods] of [["go-logger", 52], ["go-pattern-detector", 54], ["daily-testify-uber-super-expert", 40]]) {
    const module = await import(`../../docs/operational-value/proof/functions/${slug}.mjs`);
    const timeline = readJson(new URL(`reports/github-gh-aw/${slug}-timeline.json`, base));
    assert.equal(timeline.snapshots.length, periods);
    assert.equal(timeline.snapshots[0].window.startAt, module.definition.adoption.adoptedAt);
    assert.equal(timeline.snapshots.at(-1).window.endAt, cutoff);
    assert.deepEqual(timeline.valueFunction.definition, module.definition);
    const seen = new Set();
    for (let i = 0; i < timeline.snapshots.length; i++) {
      const snapshot = timeline.snapshots[i];
      if (i) assert.equal(timeline.snapshots[i - 1].window.endAt, snapshot.window.startAt);
      assert.equal(module.scoreMetric("native-partial", snapshot.evidence), snapshot.metrics["native-partial"]);
      if (!snapshot.evidence.caseIds.length) assert.equal(snapshot.metrics["native-partial"], null);
      for (const id of snapshot.evidence.caseIds) { assert.ok(!seen.has(id)); seen.add(id); }
    }
    const sum = timeline.snapshots.filter(row => row.metrics["native-partial"] !== null).reduce((total, row) => total + row.metrics["native-partial"], 0);
    assert.equal(sum, slug === "daily-testify-uber-super-expert" ? 2 : 0);
  }
});
