import assert from "node:assert/strict";
import test from "node:test";
import {
  cutoff, modelGap, networkSeparation, readProof, replayNetwork, replayOrigin, replaySetup,
  replayWrapper, sourceText, transition,
} from "../../scripts/native-policy-outcomes.mjs";
import * as network from "../../docs/operational-value/proof/functions/weekly-network-domains-audit.mjs";
import * as setup from "../../docs/operational-value/proof/functions/daily-action-setup-security-audit.mjs";
import * as model from "../../docs/operational-value/proof/functions/daily-workflow-security-model.mjs";

test("native network facet independently establishes three actual-parent host separations", () => {
  const result = replayNetwork();
  assert.deepEqual(result.accepted.map(row => row.domain), [
    "cdn.playwright.dev", "ghcr.io", "playwright.download.prss.microsoft.com",
  ]);
  const record = transition(67811);
  assert.equal(record.parent, "5281184c7ecfc9facccd07797e8f0528718aa915");
  assert.equal(record.committedAt, "2026-10-12T11:40:33Z");
});

test("network checker rejects unchanged access, suffix shadowing and ecosystem relabeling", () => {
  const record = transition(67811);
  const before = JSON.parse(sourceText(record.sources[1].before));
  const after = JSON.parse(sourceText(record.sources[1].after));
  const oldGo = sourceText(record.sources[0].before), newGo = sourceText(record.sources[0].after);
  assert.equal(networkSeparation(before, before, oldGo, oldGo).accepted.length, 0);
  const shadowed = structuredClone(after);
  shadowed["engine-defaults"].claude.push("ghcr.io", "*.playwright.dev", "microsoft.com");
  assert.equal(networkSeparation(before, shadowed, oldGo, newGo).accepted.length, 0);
  const changedPolicy = structuredClone(after);
  changedPolicy.ecosystems.containers = [];
  assert.equal(networkSeparation(before, changedPolicy, oldGo, newGo).accepted.length, 0);
  assert.throws(() => networkSeparation(before, {}, oldGo, newGo), /schema/);
  assert.throws(() => networkSeparation(before, after, oldGo, newGo.replace("json.Unmarshal", "json.Other")), /loader/);
});

test("native setup replay establishes two conditions, not the number of filesystem cases", () => {
  const result = replaySetup();
  assert.equal(result.accepted.length, 2);
  assert.equal(result.nativeCases.originBefore.persistedMarker, true);
  assert.equal(result.nativeCases.originAfter.persistedMarker, false);
  for (const row of result.nativeCases.wrapper) {
    assert.equal(row.before.mode, 0o755);
    assert.equal(row.after.mode, 0o700);
    assert.equal(row.before.containsMarker, true);
    assert.equal(row.after.containsMarker, true);
    assert.equal(row.before.bytesSha256, row.after.bytesSha256);
  }
});

test("source custody rejects altered original bytes and unsupported extraction", () => {
  const source = transition(54701).sources[0].before;
  assert.throws(() => sourceText({ ...source, sha256: "0".repeat(64) }), /changed/);
  assert.throws(() => sourceText({ ...source, blob: "0".repeat(40) }), /changed/);
});

test("native old setup statements remain negative controls on repeated execution", () => {
  assert.equal(replayOrigin(transition(54701).sources[0].before).persistedMarker, true);
  assert.equal(replayWrapper(transition(55587).sources[0].before, true).groupWorldReadable, true);
});

test("each independent function passes native missing/malformed and directional examples", () => {
  for (const module of [network, setup, model]) {
    const score = name => module.scoreMetric("native-deliveries", module.definition.validationExamples[name]);
    assert.ok(score("targetAttained") > score("targetMissed"));
    assert.equal(score("missing"), null);
    assert.equal(score("malformed"), null);
    assert.equal(module.scoreMetric("unknown-metric", module.definition.validationExamples.targetAttained), null);
  }
});

test("period scoring preserves delivery, missingness, scope and non-overlapping boundaries", async () => {
  const requests = [
    { windowStart: "2026-10-11T00:00:00Z", windowEnd: "2026-10-12T11:40:33Z", observedAt: cutoff },
    { windowStart: "2026-10-12T11:40:33Z", windowEnd: cutoff, observedAt: cutoff },
    { windowStart: cutoff, windowEnd: "2026-10-19T00:00:00Z", observedAt: "2026-10-19T00:00:00Z" },
  ];
  const result = await network.collectBatch(requests);
  assert.deepEqual(result.map(row => network.scoreMetric("native-deliveries", row.evidence)), [null, 3, null]);
  const duplicate = structuredClone(result[1].evidence);
  duplicate.events.push(duplicate.events[0]);
  assert.equal(network.scoreMetric("native-deliveries", duplicate), null);
  const fabricated = structuredClone(result[1].evidence);
  fabricated.events[0].domains[0].domain = "invented.example";
  assert.equal(network.scoreMetric("native-deliveries", fabricated), null);
  await assert.rejects(network.collectBatch(requests, { outcomes: [] }), /authority/);
  await assert.rejects(network.collectBatch([{ ...requests[1], repository: "private/target" }]), /window/);
});

test("setup real historical period contains both native repairs and no contribution inference", async () => {
  const [result] = await setup.collectBatch([{
    windowStart: "2026-08-20T00:00:00Z", windowEnd: "2026-08-27T00:00:00Z", observedAt: cutoff,
  }]);
  assert.equal(setup.scoreMetric("native-deliveries", result.evidence), 2);
  assert.equal(result.evidence.contribution, null);
  assert.equal(result.evidence.fullAcceptance, null);
  assert.equal(result.evidence.costs, null);
});

test("model preparation failures remain independent blockers, never accepted native boundaries", async () => {
  const gap = modelGap();
  assert.equal(gap.accepted.length, 0);
  assert.equal(gap.failures.length, 2);
  const result = await model.collectBatch([{
    windowStart: "2026-10-13T00:00:00Z", windowEnd: cutoff, observedAt: cutoff,
  }]);
  assert.equal(model.scoreMetric("native-deliveries", result[0].evidence), null);
  assert.equal(result[0].evidence.knownPreparationFailures.length, 2);
  assert.match(result[0].evidence.missingReason, /TLC/);
});

test("model negative examples reject wrong invariant, tool failure, missing state count and weakened source", () => {
  const example = model.definition.validationExamples.targetAttained;
  for (const alter of [
    row => { row.invariant = "WrongInvariant"; },
    row => { row.secure.exitCode = 1; },
    row => { row.secure.stdout = ""; },
    row => { row.preservedControlIds = []; },
    row => { row.refinedModelSha256 = row.originalModelSha256; },
  ]) {
    const copy = structuredClone(example);
    alter(copy.boundaries[0]);
    assert.equal(model.scoreMetric("native-deliveries", copy), null);
  }
});

test("source closure verifies actual added adoption files and retained frozen source versions", () => {
  const closure = readProof("source-closure.json.gz").closure;
  for (const [slug, entry] of Object.entries(closure)) {
    assert.ok(entry.profiles.length > 1);
    assert.equal(entry.profiles.at(-1).revision, entry.adoption.sha);
    assert.match(sourceText(entry.profiles.at(-1)), /safe-outputs:/);
    assert.match(sourceText(entry.compiledAtCutoff), /jobs:/);
    assert.equal(entry.compiledAtCutoff.path, `.github/workflows/${slug}.lock.yml`);
  }
});
