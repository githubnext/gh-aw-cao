import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { collectBatch, definition, scoreMetric } from "../../docs/operational-value/proof/functions/changeset.mjs";
import { readJsonArchive } from "../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { gitBlob, sha256, parseNativeChangeset, inspectChangeset, validatePacket,
  validateTransitions, historyStart, cutoff } from "../../scripts/native-changeset.mjs";

const native = readJsonArchive("docs/operational-value/proof/changeset/native.json.gz");
const blob = (text, name = "patch-example") => {
  const bytes = Buffer.from(text);
  return { path: `.changeset/${name}.md`, mode: "100644", content: bytes.toString("base64"),
    bytes: bytes.length, gitBlob: gitBlob(bytes), sha256: sha256(bytes), status: "available" };
};

test("native parser preserves empty-body, package-alias and prefix-match behavior", () => {
  assert.equal(parseNativeChangeset('---\n"gh-aw": patch\n---\n').readable, true);
  assert.equal(parseNativeChangeset('---\n"githubnext/gh-aw": minor\n---\nFixed.\n').bumpType, "minor");
  assert.equal(parseNativeChangeset('---\n"gh-aw": patchwork\n---\nFixed.\n').bumpType, "patch");
  assert.equal(parseNativeChangeset('---\r\n"gh-aw": patch\r\n---\r\nFixed.\r\n').readable, false);
  assert.equal(parseNativeChangeset('---\n"gh-aw": patch\nMissing closing delimiter').readable, false);
});

test("format and nonempty-description facets cannot masquerade as native parser or accuracy", () => {
  const empty = inspectChangeset(blob('---\n"gh-aw": patch\n---\n'));
  assert.equal(empty.readable, true);
  assert.equal(empty.nonemptyDescription, false);
  assert.equal(empty.specifiedFormat, false);
  const prefix = inspectChangeset(blob('---\n"gh-aw": patchwork\n---\nFixed.\n'));
  assert.equal(prefix.readable, true);
  assert.equal(prefix.specifiedFormat, false);
  const wrongType = inspectChangeset(blob('---\n"gh-aw": minor\n---\nFixed.\n'));
  assert.equal(wrongType.specifiedFormat, false);
  const valid = inspectChangeset(blob('---\n"gh-aw": patch\n---\nUtterly false claim.\n'));
  assert.equal(valid.specifiedFormat, true);
  assert.equal(valid.semanticAccuracy, null);
  assert.equal(valid.semanticCompleteness, null);
});

test("native Codemod separation preserves empty description and content semantics", () => {
  const entry = parseNativeChangeset('---\n"gh-aw": minor\n---\nDescription.\n\n## Codemod\n\nOld to new.\n');
  assert.equal(entry.description, "Description.");
  assert.equal(entry.codemod, "Old to new.");
  const onlyCodemod = parseNativeChangeset('---\n"gh-aw": minor\n---\n## Codemod\nInstructions\n');
  assert.equal(onlyCodemod.description, "");
});

test("raw native decoding rejects tampering, unknown rule profile and asserted success", () => {
  const corrupted = structuredClone(native);
  corrupted.entries.find(row => row.status === "available").content = Buffer.from("forged").toString("base64");
  assert.throws(() => validatePacket(corrupted), /mismatch/);
  assert.equal(scoreMetric("release-readable", { accepted: true, value: 999, readable: 999 }), null);
  const wrongRule = structuredClone(native);
  wrongRule.sources.find(row => row.path === "scripts/changeset.js").gitBlob = "f".repeat(40);
  assert.throws(() => validatePacket(wrongRule), /mismatch/);
  const wrongRepository = structuredClone(native);
  wrongRepository.repositoryId++;
  assert.throws(() => validatePacket(wrongRepository), /scope/);
});

test("native transitions bind commit, parent, diff, before/after and current rule applicability", () => {
  const decoded = validateTransitions(native);
  assert.ok(decoded.events.length > 0);
  assert.ok(decoded.gaps.length > 0);
  const corrupted = structuredClone(native);
  corrupted.transitions[0].rawCommit = Buffer.from("invented commit").toString("base64");
  assert.throws(() => validateTransitions(corrupted), /commit identity/);
  const wrongProfile = structuredClone(native);
  wrongProfile.transitions.forEach(row => { row.profileBefore = ["f".repeat(40), "f".repeat(40)]; });
  const unknown = validateTransitions(wrongProfile);
  assert.equal(unknown.events.length, 0);
  assert.ok(unknown.gaps.length > decoded.gaps.length);
  for (const event of decoded.events) {
    assert.equal(event.additions, Number(event.after.readable && !event.before.readable));
    assert.ok(event.at >= historyStart && event.at < cutoff);
  }
});

test("every schema3 metric has native raw positive, negative, missing and malformed examples", () => {
  assert.equal(definition.schemaVersion, 3);
  for (const metric of definition.metrics) {
    const examples = definition.validationExamples;
    assert.ok(scoreMetric(metric.id, examples.targetAttained) > scoreMetric(metric.id, examples.targetMissed));
    assert.equal(scoreMetric(metric.id, examples.missing), null);
    assert.equal(scoreMetric(metric.id, examples.malformed), null);
  }
});

test("partial native value survives missing semantic evidence, but unknown latest is not zero", async () => {
  const requests = [
    { windowStart: historyStart, windowEnd: "2026-10-11T15:00:12Z", observedAt: cutoff },
    { windowStart: "2026-10-11T15:00:12Z", windowEnd: cutoff, observedAt: cutoff },
  ];
  const [earlier, latest] = await collectBatch(requests);
  assert.equal(scoreMetric("release-readable", earlier.evidence), 21);
  assert.equal(scoreMetric("with-description", earlier.evidence), 21);
  assert.equal(scoreMetric("specified-format", earlier.evidence), 12);
  assert.equal(earlier.evidence.coverageStatus, "partial");
  assert.equal(latest.evidence.coverageStatus, "partial");
  assert.equal(scoreMetric("release-readable", latest.evidence), null);
  assert.equal(latest.evidence.fullGoal.value, null);
  assert.equal(latest.evidence.workflowContribution.value, null);
  assert.equal(latest.evidence.keepDecision, "not rated");
  assert.equal(latest.evidence.costs.value, null);
  assert.equal(latest.evidence.repositoryCondition.releaseReadable, 731);
  assert.equal(latest.evidence.repositoryCondition.missing, 80);
});

test("disjoint periods add native completions without double-counting retained snapshots", async () => {
  const end = "2026-10-11T15:00:12Z";
  const [whole, a, b] = await collectBatch([
    { windowStart: historyStart, windowEnd: cutoff, observedAt: cutoff },
    { windowStart: historyStart, windowEnd: end, observedAt: cutoff },
    { windowStart: end, windowEnd: cutoff, observedAt: cutoff },
  ]);
  const totals = [whole, a, b].map(row => row.evidence.structuralTransitions.readableAdditions);
  assert.equal(totals[0], totals[1] + totals[2]);
  const ids = [a, b].flatMap(row => row.evidence.structuralTransitions.events.map(event => event.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(a.evidence.repositoryCondition, null);
});

test("arbitrary unsupported historical windows remain unknown; validation rejects invalid periods", async () => {
  const [missing] = await collectBatch([{ windowStart: "2025-11-02T00:00:00Z",
    windowEnd: "2025-11-09T00:00:00Z", observedAt: cutoff }]);
  assert.equal(scoreMetric("release-readable", missing.evidence), null);
  assert.equal(missing.evidence.coverageStatus, "missing");
  await assert.rejects(collectBatch([{ windowStart: cutoff, windowEnd: cutoff, observedAt: cutoff }]), /window/);
  assert.equal(scoreMetric("release-readable", { raw: native,
    windowStart: historyStart, windowEnd: "2026-10-12 invalid" }), null);
  await assert.rejects(collectBatch([{ windowStart: "2026-02-30T00:00:00Z",
    windowEnd: cutoff, observedAt: cutoff }]), /window/);
});

test("retained discovery includes complete direct and bidirectional candidate closure, not accepted links", () => {
  const discovery = readJsonArchive("docs/operational-value/proof/changeset/discovery.json.gz");
  assert.equal(discovery.history.entities, 58048);
  assert.equal(discovery.history.partitions, 346);
  assert.equal(discovery.direct.length, 38);
  assert.equal(discovery.closure.length, 3182);
  const numbers = new Set(discovery.closure.map(row => row.number));
  for (const row of discovery.direct) assert.ok(numbers.has(row.number));
  for (const row of discovery.closure) for (const related of row.relatedCandidates ?? []) assert.ok(numbers.has(related));
  assert.match(discovery.interpretation, /not accepted/);
});

test("native parser identity is bound in the frozen definition", () => {
  assert.equal(definition.instrumentSha256, sha256(readFileSync("scripts/native-changeset.mjs")));
  assert.equal(definition.intent.temporalAnchor, "workflow-adoption");
  assert.equal(definition.adoption.adoptedAt, "2025-11-01T16:31:43Z");
  const adoption = readJsonArchive("docs/operational-value/proof/changeset/adoption.json.gz");
  assert.equal(adoption.commit, definition.adoption.commit);
  assert.equal(adoption.parent, definition.adoption.baselineCommit);
  const parent = Buffer.from(adoption.rawParentTree, "base64").toString();
  assert.equal(parent.includes("\t.github/workflows/changeset.md\0"), false);
  assert.equal(parent.includes("\t.github/workflows/changeset.lock.yml\0"), false);
  const introduced = Buffer.from(adoption.rawTree, "base64").toString();
  assert.ok(introduced.includes("\t.github/workflows/changeset.md\0"));
  assert.ok(introduced.includes("\t.github/workflows/changeset.lock.yml\0"));
});
