import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { assertPublicPackageSource, decodePackageGitBlob, rebindPackageReviewMetadata } from "../../scripts/collect-package-currency-history.mjs";
import { readNativePackagePins, satisfiesStablePackageRange } from "../../scripts/native-package-currency-value.mjs";
import { assessVersionCurrency, scoreVersionCurrency } from "../../scripts/native-version-currency-value.mjs";
import { censusDigest, readCensusJson } from "../../scripts/operational-value-census-io.mjs";

test("native direct-package pins honor exact, caret and tilde range boundaries without comparing range lower bounds", () => {
  for (const [version, range, expected] of [["2.3.4", "^2.0.0", true], ["3.0.0", "^2.0.0", false],
    ["0.3.9", "^0.3.1", true], ["0.4.0", "^0.3.1", false], ["0.0.2", "^0.0.1", false],
    ["0.0.1", "^0.0.1", true], ["2.3.9", "~2.3.1", true], ["2.4.0", "~2.3.1", false],
    ["2.3.4", "2.3.4", true], ["2.3.5", "2.3.4", false], ["2.3.0", "^2.3.4", false],
    ["2.3.4", ">=2", null], ["2.3.4-beta.1", "^2.3.4", null]]) {
    assert.equal(satisfiesStablePackageRange(version, range), expected);
  }
  const tools = [{ name: "example", constant: "example", scope: "dependencies" }];
  const manifest = { dependencies: { example: "^2.0.0" } };
  const lock = { lockfileVersion: 3, packages: { "": manifest, "node_modules/example": { version: "2.4.0" } } };
  assert.deepEqual(readNativePackagePins(manifest, lock, tools), { pins: { example: "2.4.0" }, diagnostics: [] });
  assert.deepEqual(readNativePackagePins(manifest, { ...lock, packages: { ...lock.packages, "": {} } }, tools).pins, {});
  assert.deepEqual(readNativePackagePins(manifest, { lockfileVersion: 1 }, tools).pins, {});
});

test("package evidence refuses credential-shaped source and authenticated registry URLs", () => {
  assert.deepEqual(assertPublicPackageSource('{"resolved":"https://registry.npmjs.org/example/-/example-1.0.0.tgz"}'),
    { resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz" });
  for (const resolved of ["https://user:credential@registry.example.invalid/example", "https://registry.example.invalid/example?token=redacted",
    `ghp_${"x".repeat(36)}`]) {
    assert.throws(() => assertPublicPackageSource(JSON.stringify({ resolved })), /Refusing/);
  }
});

test("official package blob fallback verifies immutable identity, size, encoding and public source", () => {
  const content = '{"dependencies":{"example":"1.0.0"}}\n', bytes = Buffer.from(content);
  const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const response = { sha, encoding: "base64", size: bytes.length, content: bytes.toString("base64") + "\n" };
  assert.equal(decodePackageGitBlob(response, sha), content);
  for (const changes of [{ sha: "a".repeat(40) }, { size: bytes.length + 1 }, { encoding: "utf8" },
    { content: Buffer.from("{}").toString("base64") }, { content: response.content + "!" }]) {
    assert.throws(() => decodePackageGitBlob({ ...response, ...changes }, sha), /Invalid|mismatch/);
  }
});

test("actual package history replays native lock pins and official dated publications", {
  skip: !existsSync("docs/operational-value/proof/package-currency/index.json"),
}, () => {
  const directory = "docs/operational-value/proof/package-currency";
  const [contract] = readCensusJson(`${directory}/contracts.json`), index = readCensusJson(`${directory}/index.json`);
  const facts = readCensusJson(`${directory}/facts.json.gz`), sources = new Map();
  assert.equal(index.complete, true);
  assert.equal(index.contractSha256, censusDigest(contract));
  assert.equal(index.factsSha256, censusDigest(facts));
  assert.equal(contract.tools.length, 18);
  for (const source of index.sources) {
    const raw = readCensusJson(`${directory}/sources/${source.gitBlob}.json.gz`);
    assert.equal(censusDigest(raw), source.sha256);
    assert.equal(createHash("sha1").update(`blob ${Buffer.byteLength(raw.content)}\0`).update(raw.content).digest("hex"), raw.id);
    sources.set(raw.id, assertPublicPackageSource(raw.content));
  }
  for (const state of facts.states) {
    const manifest = state.files.find(file => file.path === contract.manifestPath);
    const lock = state.files.find(file => file.path === contract.lockPath);
    assert.deepEqual(readNativePackagePins(sources.get(manifest?.gitBlob), sources.get(lock?.gitBlob), contract.tools),
      { pins: state.pins, diagnostics: state.diagnostics });
  }
  const timelineFile = "docs/operational-value/proof/reports/github-gh-aw/update-astro-timeline.json";
  if (existsSync(timelineFile)) {
    const timeline = JSON.parse(readFileSync(timelineFile, "utf8"));
    assert.equal(timeline.valueFunction.definition.evidence.sourcePolicySha256, censusDigest(contract));
    assert.equal(timeline.snapshots.length, 32);
    assert.equal(timeline.snapshots.filter(snapshot => Number.isFinite(snapshot.metrics["stale-pins"])).length, 4);
    assert.equal(timeline.snapshots.at(-1).metrics["stale-pins"], 9);
    assert.equal(timeline.snapshots.find(snapshot => snapshot.observedAt === "2026-10-11T15:00:12Z").metrics["stale-pins"], 8);
    const legacyReference = timeline.snapshots.at(-1).evidence.rows.find(row => row.tool === "satori");
    assert.equal(legacyReference.pin, "0.33.5");
    assert.equal(legacyReference.latestEligible, "1.0.4");
    assert.equal(legacyReference.latestPublishedAt, "2015-04-18T03:18:14.612Z");
    assert.equal(timeline.valueReview.decision.status, "not-rated");
    assert.equal(timeline.valueReview.current.status, "complete");
    assert.equal(timeline.valueReview.current.eligibleCount, 18);
    assert.equal(timeline.valueReview.recentComparison.nativeDelta, 1);
    assert.equal(timeline.valueReview.recentComparison.directionAwareGain, -1);
    assert.equal(timeline.valueReview.periods[0].status, "incomplete-evidence");
    for (const snapshot of timeline.snapshots) {
      const state = facts.states.find(state => state.windowEnd === snapshot.window.endAt);
      const evidence = state ? assessVersionCurrency(state.pins, contract.tools, facts.releases, state.windowEnd) : { valid: false };
      for (const id of ["stale-pins", "known-stale-pins"]) assert.equal(snapshot.metrics[id], scoreVersionCurrency(id, evidence));
      assert.ok(snapshot.provenance.some(row => row.kind === "native-package-currency-index" && row.ref === censusDigest(index)));
    }
  }
});

test("explicit package review metadata preserves the original native facts, interpreter and all prior values", {
  skip: !existsSync("docs/operational-value/proof/package-currency/index.json"),
}, () => {
  const directory = "docs/operational-value/proof/package-currency", index = readCensusJson(`${directory}/index.json`);
  const previousVersion = index.reviewMetadataExtension.previousFunctionSha256;
  const archive = `${directory}/versions/${previousVersion}`;
  const [previous] = readCensusJson(`${archive}/contracts.json`), [contract] = readCensusJson(`${directory}/contracts.json`);
  const originalIndex = readCensusJson(`${archive}/index.json`);
  assert.equal(index.reviewMetadataExtension.previousIndexSha256, censusDigest(originalIndex));
  assert.equal(originalIndex.factsSha256, index.factsSha256);
  assert.equal(censusDigest(readCensusJson(`${archive}/facts.json.gz`)), index.factsSha256);
  assert.equal(createHash("sha256").update(readFileSync(`${archive}/interpreter.txt`)).digest("hex"), previous.interpreterSha256);
  assert.equal(createHash("sha256").update(readFileSync(`${archive}/function.txt`)).digest("hex"), previousVersion);
  const oldTimeline = readCensusJson(`${archive}/reports/update-astro-timeline.json`);
  const timeline = readCensusJson("docs/operational-value/proof/reports/github-gh-aw/update-astro-timeline.json");
  assert.deepEqual(oldTimeline.snapshots.map(snapshot => snapshot.metrics), timeline.snapshots.map(snapshot => snapshot.metrics));
  assert.equal(oldTimeline.valueReview.current.status, "incomplete-evidence");
  const functionFile = "docs/operational-value/proof/functions/update-astro.mjs", wrapper = readFileSync(functionFile, "utf8");
  assert.throws(() => rebindPackageReviewMetadata(directory, { ...contract, sourceRevision: "a".repeat(40) },
    functionFile, wrapper, previousVersion), /does not preserve/);
  assert.equal(censusDigest(readCensusJson(`${directory}/index.json`)), censusDigest(index));
});
