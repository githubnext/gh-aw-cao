import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readJsonArchive } from "../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { analyzeMigrationSources, cliCompatibilityModule, verifyMigrationTransition } from "../../scripts/native-cli-compatibility-value.mjs";
import { collectBatch, definition, scoreMetric } from "../../docs/operational-value/proof/functions/breaking-change-checker.mjs";

const directory = new URL("../../docs/operational-value/proof/cli-compatibility/", import.meta.url);
const index = readJsonArchive(fileURLToPath(new URL("index.json.gz", directory)));
const inputs = ["before", "after"].map(side => {
  const blob = JSON.parse(readJsonArchive(fileURLToPath(new URL(index.receipts[`native-${side}-0`].file, directory))).body);
  return { id: side, text: Buffer.from(blob.content, "base64").toString("utf8") };
});
const sources = analyzeMigrationSources(inputs).sources;
const patterns = {
  detection: sources.after.hasDeprecatedAppField.statements[0],
  rewrite: sources.after.renameAppToGitHubApp.range.find(statement => statement.startsWith('if strings.HasPrefix(trimmed, "app:") && isTopLevelKey(line)')),
};
const metricId = "verified-automatic-migration-repairs";
const cutoff = "2026-10-18T15:00:12Z";
const request = (windowStart, windowEnd) => ({ repository: "github/gh-aw", windowStart, windowEnd, observedAt: cutoff });

test("one real native automatic-migration repair is narrower than v1 compatibility restoration", () => {
  assert.equal(definition.nativeAssessment.nativeSubtotal, 1);
  assert.equal(definition.nativeAssessment.qualifiedWorkflows, 1);
  assert.equal(definition.nativeAssessment.selectedRoots, 45);
  assert.deepEqual(definition.nativeAssessment.discoveredPulls, [42794, 43822, 46273, 50311, 52128]);
  assert.equal(definition.originalAcceptance.id, "restored-cli-compatibility-cases");
  assert.equal(definition.metrics[0].id, metricId);
  assert.match(definition.assessmentPolicy, /outcome-informed retrospective/);
  assert.equal(definition.nativeAssessment.fullAcceptance, null);
  assert.equal(definition.nativeAssessment.contribution.receiptVerified, null);
});

test("native Go AST confirms both new gates and otherwise identical production migration bodies", () => {
  assert.deepEqual(verifyMigrationTransition(sources.before, sources.after, patterns), { verified: true, nativeSubtotal: 1 });
});

test("missing, wrong-target and noncontinuing rewrite guards cannot qualify", () => {
  for (const change of [
    value => { value.renameAppToGitHubApp.range = value.renameAppToGitHubApp.range.filter(statement => statement !== patterns.rewrite); },
    value => { value.renameAppToGitHubApp.range = value.renameAppToGitHubApp.range.map(statement => statement.replace('"github-app"', '"wrong-app"')); },
    value => { value.renameAppToGitHubApp.range = value.renameAppToGitHubApp.range.map(statement => statement.replace("modified = true", "modified = false")); },
    value => { value.hasDeprecatedAppField.statements.shift(); },
    value => { value.getGitHubAppCodemod.apply = "return content, false, nil"; },
  ]) {
    const altered = structuredClone(sources.after);
    change(altered);
    assert.throws(() => verifyMigrationTransition(sources.before, altered, patterns));
  }
});

test("an already-present detector and unrelated setup changes cannot masquerade as a repair", () => {
  assert.throws(() => verifyMigrationTransition(sources.after, sources.after, patterns));
  const altered = structuredClone(sources.after);
  altered.renameAppToGitHubApp.outside[0] = "var result = broken";
  assert.throws(() => verifyMigrationTransition(sources.before, altered, patterns));
});

test("half-open delivery periods count the repair once, with other periods unknown rather than zero", () => {
  const delivery = "2026-07-01T18:10:03Z";
  const requests = [
    request("2026-06-24T18:10:03Z", delivery),
    request(delivery, "2026-07-08T18:10:03Z"),
    request("2026-07-08T18:10:03Z", "2026-07-15T18:10:03Z"),
  ];
  const packets = collectBatch(requests);
  assert.deepEqual(packets.map(packet => scoreMetric(metricId, packet.evidence)), [null, 1, null]);
  assert.equal(packets.flatMap(packet => packet.evidence.caseIdentities).length, 1);
  assert.deepEqual(collectBatch(requests), packets);
  for (const packet of packets) {
    assert.equal(packet.evidence.fullAcceptance, null);
    assert.equal(packet.evidence.originalStrictAcceptance, null);
    assert.equal(packet.evidence.safeguards, null);
    assert.equal(packet.evidence.costs, null);
  }
});

test("out-of-scope, immature and malformed requests fail explicitly", () => {
  const valid = request("2026-10-11T15:00:12Z", cutoff);
  for (const changed of [
    { ...valid, repository: "other/repository" },
    { ...valid, windowStart: cutoff },
    { ...valid, windowEnd: "2026-10-19T15:00:12Z" },
    { ...valid, windowStart: "not-a-date" },
  ]) assert.throws(() => collectBatch([changed]));
  assert.throws(() => collectBatch([valid, valid]), /Overlapping delivery periods/);
  assert.throws(() => scoreMetric("unknown-metric", {}));
  assert.equal(scoreMetric(metricId, {}), null);
  assert.equal(scoreMetric(metricId, { schemaVersion: 1, native: -1 }), null);
});

test("dependency drift fails before native replay, and malformed target data is never executed", () => {
  assert.throws(() => cliCompatibilityModule({
    "docs/operational-value/proof/cli-compatibility/oracle.go": "0".repeat(64),
  }), /Dependency changed/);
  assert.throws(() => analyzeMigrationSources([{ id: "invalid", text: "this is not Go source" }]));
});
