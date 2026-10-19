import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readJsonArchive } from "../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { collectBatch, definition, scoreMetric } from "../../docs/operational-value/proof/functions/cli-consistency-checker.mjs";
import { checkDocumentation, checkHelp, cutoff, documentationPath, extractDocumentationRules,
  goString, goTokens, hash, normativePath, reviewNativeSource, sourceText } from "../../docs/operational-value/proof/cli-consistency-checker/native.mjs";

const directory = "docs/operational-value/proof/cli-consistency-checker";
const contract = readJsonArchive(`${directory}/contract.json`);
const source = readJsonArchive(`${directory}/source.json.gz`, { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 });
const metricId = definition.metrics[0].id;
const request = { windowStart: "2026-10-17T15:00:12Z", windowEnd: cutoff, observedAt: cutoff };

test("native source contents, not metadata, verify all preserved file bytes", () => {
  assert.equal(source.files.length, 538);
  for (const file of source.files) assert.equal(typeof sourceText(source, file.path), "string");
  assert.deepEqual(source.blockers.map(file => file.path), ["go.mod", "go.sum"]);
  const changed = structuredClone(source);
  changed.files.find(file => file.path === documentationPath).content += "AA==";
  assert.throws(() => sourceText(changed, documentationPath), /integrity/);
});

test("frozen source-native rules are independently recovered and all selected assertions inventoried", () => {
  const rules = extractDocumentationRules(sourceText(source, normativePath));
  assert.deepEqual(rules, contract.rules);
  assert.equal(rules.length, 23);
  assert.equal(rules.filter(rule => rule.expected !== null).length, 22);
  assert.equal(hash(JSON.stringify(rules)), contract.rulesDigest);
  assert.equal(rules.find(rule => rule.expected === null).expression.includes("engineFlagHelpList"), true);
});

test("Go literals, comments and native Contains/NotContains scope do not become JavaScript evaluation", () => {
  assert.equal(goString('"a\\n\\x62\\u0063"'), "a\nbc");
  assert.equal(goString("`raw\r\ntext`"), "raw\ntext");
  assert.deepEqual(goTokens('// assert.Contains(t, text, "bad")\n"{"').map(token => token.text), ['"{"']);
  assert.throws(() => goTokens('"unterminated'), /unterminated/);
  assert.throws(() => goString('"\\q"'), /Unsupported/);
  const rules = [
    { scope: "compileSection", expected: "needle", operation: "Contains" },
    { scope: "updateSection", expected: "forbidden", operation: "NotContains" },
  ];
  assert.deepEqual(checkDocumentation("#### `compile`\n#### `update`\nneedle", rules)
    .map(rule => rule.status), ["passed", "passed"]);
  assert.equal(checkDocumentation("needle but no compile heading", rules)[0].status, "failed");
  assert.equal(checkDocumentation("#### `compile`\n#### `update`\nforbidden", rules)[1].status, "failed");
});

test("positive and negative native input cases score without caller acceptance booleans", () => {
  assert.equal(scoreMetric(metricId, definition.validationExamples.targetAttained), 100);
  assert.ok(scoreMetric(metricId, definition.validationExamples.targetMissed) < 100);
  const input = structuredClone(definition.validationExamples.targetAttained);
  input.accepted = false;
  input.passed = 0;
  input.total = 0;
  assert.equal(scoreMetric(metricId, input), 100);
  input.nativeInput.documentation = input.nativeInput.documentation.replaceAll("`--cool-down`", "");
  input.accepted = true;
  input.passed = 22;
  assert.equal(scoreMetric(metricId, input), 100 * 21 / 22);
});

test("missing, malformed and unrelated-profile evidence cannot become a clean CLI", () => {
  for (const input of [null, {}, { accepted: true }, definition.validationExamples.malformed,
    { profileDigest: "incorrect", nativeInput: { documentation: "hello" } }]) {
    assert.equal(scoreMetric(metricId, input), null);
  }
  assert.equal(scoreMetric("unknown", definition.validationExamples.targetAttained), null);
});

test("raw help interpreter checks source-defined prefixes and native section order", () => {
  const output = "Compile workflows\n\nUsage:\n  gh aw compile\n\nExamples:\n  gh aw compile\n\nFlags:\n  -h, --help   Show help for gh aw compile\n";
  assert.deepEqual(checkHelp("compile", output).map(rule => rule.status), ["passed", "passed"]);
  assert.equal(checkHelp("compile", output.replace("Show help for gh aw", "help")).at(0).status, "failed");
  const wrongOrder = "Compile\n\nExamples:\n  gh aw compile\n\nUsage:\n  gh aw compile\n\nFlags:\n  --help  Show help for gh aw compile\n";
  assert.equal(checkHelp("compile", wrongOrder).at(1).status, "failed");
  assert.throws(() => checkHelp("compile", "Build failed"), /native command help/);
  assert.throws(() => checkHelp("compile", `${output}\nUsage:\n  gh aw compile\n`), /duplicate/);
});

test("actual collector replays immutable source at the exact frozen cutoff, not synthetic observations", async () => {
  const [collection] = await collectBatch([request]);
  const review = reviewNativeSource(source, contract.rules);
  assert.equal(collection.commit, source.revision);
  assert.equal(collection.evidence.nativeInput.documentation, sourceText(source, documentationPath));
  assert.equal(collection.evidence.eligibleCount, 22);
  assert.equal(collection.evidence.populationDigest, review.populationDigest);
  assert.equal(collection.evidence.coverageStatus, "complete");
  assert.equal(collection.evidence.fullCommandAcceptance, null);
  assert.equal(collection.evidence.contribution, null);
  assert.equal(review.counts.unavailable, 1);
  assert.equal(review.readiness.fullFunction, "partial-native-facet");
  assert.equal(review.readiness.fullAcceptance, "unavailable");
  assert.equal(scoreMetric(metricId, collection.evidence),
    100 * review.counts.passed / (review.counts.passed + review.counts.failed));
  assert.ok(collection.provenance.every(item => item.ref.includes(source.revision)));
});

test("batch ordering, missing history and prospective gaps remain visible without stale-score fallback", async () => {
  const earlier = { ...request, windowStart: "2026-10-16T15:00:12Z", windowEnd: "2026-10-17T15:00:12Z" };
  const later = { ...request, windowStart: cutoff, windowEnd: "2026-10-19T15:00:12Z", observedAt: "2026-10-19T15:00:12Z" };
  const collections = await collectBatch([later, request, earlier, request]);
  assert.deepEqual(collections.map(collection => collection.evidence.windowEnd), [later, request, earlier, request].map(item => item.windowEnd));
  assert.deepEqual(collections.map(collection => scoreMetric(metricId, collection.evidence)),
    [null, scoreMetric(metricId, collections[1].evidence), null, scoreMetric(metricId, collections[1].evidence)]);
  assert.match(collections[2].evidence.missingReason, /cannot be backdated/);
  assert.match(collections[0].evidence.missingReason, /latest immutable commit/);
});

test("collector rejects invalid and out-of-scope requests", async () => {
  for (const input of [[{ ...request, repository: "another/repo" }], [{ ...request, observedAt: request.windowStart }],
    [{ ...request, windowEnd: "invalid" }], [{ ...request, windowEnd: request.windowStart }], null]) {
    await assert.rejects(collectBatch(input), /Invalid CLI evidence/);
  }
});

test("all selected producer lineage remains unaccepted discovery with lossless original bytes", () => {
  const archive = readJsonArchive(`${directory}/producers.json.gz`, { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 });
  const index = JSON.parse(gunzipSync(Buffer.from(archive.originalIndex.bytes, "base64")));
  assert.equal(index.totalEntities, 58048);
  assert.equal(index.partitions.length, 346);
  assert.equal(archive.roots.length, 185);
  assert.equal(archive.entities.length, 2931);
  assert.equal(archive.producerReviews.length, 185);
  assert.ok(archive.producerReviews.every(row => row.acceptedNativeRepair === null && row.contribution === null
    && row.safeOutputCreationReceipt === null && row.status === "discovery-only"));
  assert.equal(archive.acceptedContribution, null);
  const selected = new Set(archive.entities.map(row => row.number));
  const originalSelected = [];
  for (const part of archive.originalPartitions) {
    const bytes = Buffer.from(part.content, "base64");
    assert.equal(hash(bytes), part.sha256);
    const rows = JSON.parse(gunzipSync(bytes));
    const expected = index.partitions.find(item => item.file === part.file);
    assert.equal(createHash("sha256").update(JSON.stringify(rows)).digest("hex"), expected.sha256);
    assert.equal(rows.length, expected.count);
    originalSelected.push(...rows.filter(row => selected.has(row.number)));
  }
  const sorted = rows => rows.toSorted((a, b) => a.number - b.number);
  assert.deepEqual(sorted(originalSelected), sorted(archive.entities));
});
