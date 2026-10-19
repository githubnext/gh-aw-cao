import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { nativeSpecConditionModule, scanSpecState, scoreSpecCondition, specReferenceFacts } from "../../scripts/native-spec-condition-value.mjs";
import { parseSpecTree, specStateLookup } from "../../scripts/collect-spec-condition-history.mjs";
import { censusDigest, readCensusJson } from "../../scripts/operational-value-census-io.mjs";

test("specification facts scan the complete prose while ignoring code and external references", () => {
  const fact = specReferenceFacts({ id: "source", content: [
    "---", "description: A specification", "---",
    "[present](present.md#section) [missing](../missing.md \"title\")",
    "`[inline](ignored.md)` [external](https://example.org/file.md)",
    "```md", "[example](not-real.md)", "```",
    "~~~", "[example](not-real-either.md)", "~~~",
    "[bad](broken%ZZ.md) [escape](../../../outside.md)",
    "[root](/root.md) [anchor](#part) [other](image.png)",
  ].join("\n") });
  assert.equal(fact.descriptionPresent, true);
  assert.deepEqual(fact.links.map(row => row.target), [".github/aw/present.md", ".github/missing.md", null, null]);
  assert.deepEqual(fact.links.map(row => row.invalid), [false, false, true, true]);
  assert.deepEqual(fact.links.map(row => row.line), [4, 4, 12, 12]);
});

test("immutable membership checks all local targets and does not turn symlinks into clean files", () => {
  const tree = parseSpecTree(`100644 blob ${"a".repeat(40)}\t.github/aw/spec.md\0`
    + `100644 blob ${"b".repeat(40)}\t.github/aw/present.md\0`
    + `120000 blob ${"c".repeat(40)}\t.github/aw/link.md\0`);
  const fact = specReferenceFacts({ id: "a".repeat(40),
    content: "[yes](present.md)\n[no](missing.md)\n[unknown](link.md)" });
  const specs = [tree.get(".github/aw/spec.md")], features = new Map([[fact.id, fact]]);
  const state = { specs, lookup: specStateLookup(tree, specs, features) };
  const evidence = scanSpecState(state, features);
  assert.equal(evidence.linksChecked, 3);
  assert.equal(evidence.observedBrokenLinks, 1);
  assert.equal(evidence.unresolved, 1);
  assert.equal(scoreSpecCondition("broken-links", evidence), null);
  assert.equal(scoreSpecCondition("observed-broken-links", evidence), 1);
  assert.equal(scoreSpecCondition("missing-descriptions", evidence), 1);
  assert.throws(() => scanSpecState({ ...state, lookup: {} }, features), /Incomplete/);
  assert.throws(() => parseSpecTree("malformed\0"), /Malformed/);
});

test("missing sources and malformed native counts never masquerade as a clean audit", () => {
  const evidence = scanSpecState({ specs: [{ path: ".github/aw/spec.md", mode: "120000", blob: "source" }], lookup: {} }, new Map());
  assert.equal(scoreSpecCondition("broken-links", evidence), null);
  assert.equal(scoreSpecCondition("observed-broken-links", evidence), null);
  assert.equal(scoreSpecCondition("missing-descriptions", evidence), null);
  assert.equal(scoreSpecCondition("broken-links", { ...evidence, valid: false }), null);
  assert.equal(scoreSpecCondition("broken-links", { ...evidence, filesScanned: "one" }), null);
});

test("real complete specification scans replay the immutable native facts and published plots", () => {
  const directory = "docs/operational-value/proof/spec-condition";
  const index = readCensusJson(`${directory}/index.json.gz`);
  const facts = new Map(index.partitions.flatMap(part => {
    const rows = readCensusJson(`${directory}/${part.file}`);
    assert.equal(censusDigest(rows), part.sha256);
    return rows.map(row => [row.id, row]);
  }));
  assert.equal(index.states.length, 12);
  assert.equal(facts.size, 248);
  const [contract] = readCensusJson(`${directory}/contracts.json`);
  const module = nativeSpecConditionModule(contract);
  const timeline = JSON.parse(readFileSync(
    `docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`, "utf8"));
  const requests = timeline.snapshots.map(snapshot => ({ repository: contract.repository,
    windowStart: snapshot.window.startAt, windowEnd: snapshot.window.endAt, observedAt: snapshot.observedAt }));
  const replayed = module.collectBatch(requests);
  for (const [position, snapshot] of timeline.snapshots.entries()) {
    const state = index.states.find(row => row.windowEnd === snapshot.window.endAt);
    const links = state.specs.flatMap(spec => facts.get(spec.blob).links);
    assert.equal(links.length, replayed[position].evidence.linksChecked);
    const broken = links.filter(link => link.invalid || state.lookup[link.target] === null);
    assert.equal(module.scoreMetric("broken-links", replayed[position].evidence), broken.length);
    assert.equal(snapshot.metrics["broken-links"], broken.length);
    assert.deepEqual(snapshot.evidence, replayed[position].evidence);
  }
  assert.equal(timeline.snapshots[0].metrics["missing-descriptions"], 8);
  assert.equal(timeline.snapshots.at(-1).metrics["missing-descriptions"], 0);
  assert.equal(timeline.snapshots.at(-1).evidence.linksChecked, 288);
});
