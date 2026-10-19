import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { nativeSpellingModule, normalizeNativeSpellingReport, scanNativeSpelling, scoreNativeSpelling, spellingPath } from "../../scripts/native-spelling-value.mjs";
import { nativeSpellingConfig } from "../../scripts/collect-spelling-history.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "../../scripts/operational-value-census-io.mjs";
import { parsePublicLfsPointer, verifyPublicGitBlob } from "../../scripts/immutable-public-git-source.mjs";

const file = "docs/src/content/example.md";
const issue = flagged => ({ uri: `file:///work/${file}`, row: 1, col: flagged ? 30 : 11,
  text: "missspellled", isFlagged: flagged, isFound: false });
const report = issues => ({ issues, error: [], result: { errors: 0, files: 1, issues: issues.length, cachedFiles: 0 } });

test("ordinary unknown words are native spelling diagnostics even when isFlagged is false", () => {
  const evidence = normalizeNativeSpellingReport(report([issue(false), issue(true)]), [file], "/work");
  assert.deepEqual(scanNativeSpelling(evidence),
    { "native-findings": 2, "forbidden-word-findings": 1, "ordinary-unknown-findings": 1 });
  assert.equal(scoreNativeSpelling("native-findings", normalizeNativeSpellingReport(report([]), [file], "/work")), 0);
  assert.equal(evidence.issues[0].path, file);
  assert.equal(evidence.issues[0].word, "missspellled");
});

test("incomplete reports and native runtime errors cannot become clean spellchecks", () => {
  for (const value of [
    { ...report([]), error: ["dictionary unavailable"] },
    { ...report([]), result: { ...report([]).result, errors: 1 } },
    { ...report([]), result: { ...report([]).result, files: 0 } },
    { ...report([]), result: { ...report([]).result, cachedFiles: 1 } },
    report([{ ...issue(false), row: 0 }]),
    report([{ ...issue(false), uri: "file:///outside/example.md" }]),
    report([{ ...issue(false), isFlagged: "false" }]),
    report([{ ...issue(false), issueType: 1 }]),
  ]) assert.throws(() => normalizeNativeSpellingReport(value, [file], "/work"));
  assert.equal(scanNativeSpelling({ valid: false }), null);
  assert.equal(scanNativeSpelling({ valid: true, complete: false, paths: [file], filesChecked: 1, issues: [] }), null);
  const evidence = normalizeNativeSpellingReport(report([issue(false)]), [file], "/work");
  assert.equal(scanNativeSpelling({ ...evidence, issues: [...evidence.issues, ...evidence.issues] }), null);
  assert.throws(() => scoreNativeSpelling("runs", evidence), /Unknown/);
});

test("native zero opportunities remain distinct from unknown and malformed cohorts", () => {
  const empty = { issues: [], error: [], result: { errors: 0, files: 0, issues: 0, cachedFiles: 0 } };
  assert.equal(scoreNativeSpelling("native-findings", normalizeNativeSpellingReport(empty, [], "/work")), 0);
  assert.throws(() => normalizeNativeSpellingReport(report([]), [file, file], "/work"), /Incomplete/);
  for (const file of ["docs/src/content/../private.md", "../docs/src/content/example.md",
    "docs/src/content/node_modules/example.md", "docs/example.md", "docs/src/content/example.js"]) assert.equal(spellingPath(file), false);
  assert.equal(spellingPath("docs/src/content/example.mdx"), true);
});

test("runtime dictionary override matches the declared native policy without executable imports", () => {
  const raw = { version: "0.2", language: "en-US", enabledLanguageIds: ["markdown", "mdx"],
    ignorePaths: ["**/node_modules/**", "**/.git/**"], dictionaryDefinitions: [{ path: "ignored-original.txt" }],
    dictionaries: ["original"] };
  const config = nativeSpellingConfig(raw, "./dictionary.txt");
  assert.deepEqual(config.dictionaries, ["en", "en-US", "workflow-dictionary"]);
  assert.deepEqual(config.dictionaryDefinitions, [{ name: "workflow-dictionary", path: "./dictionary.txt", addWords: true }]);
  assert.deepEqual(nativeSpellingConfig(raw, null).dictionaries, ["en", "en-US"]);
  for (const extra of [{ import: "./untrusted.js" }, { reporters: ["untrusted"] }, { language: "en-GB" }]) {
    assert.throws(() => nativeSpellingConfig({ ...raw, ...extra }, null), /Unsupported/);
  }
});

test("native positive probe preserves the actual jq meaning of false // true", () => {
  const directory = "docs/operational-value/proof/native-spelling";
  const index = readCensusJson(`${directory}/index.json`), probe = readCensusJson(`${directory}/probe.json.gz`);
  assert.equal(index.probeSha256, censusDigest(probe));
  assert.equal(probe.native.issues[0].flagged, false);
  assert.equal(probe.native.sourceFilterCount, 1);
  assert.equal(scoreNativeSpelling("native-findings", probe.native), 1);
  assert.equal(index.toolLockSha256, censusDigest(readCensusJson(`${directory}/tool-lock.json.gz`)));
});

test("all retained native source bytes and complete file cohorts replay without installed CSpell", async () => {
  const directory = "docs/operational-value/proof/native-spelling";
  const index = readCensusJson(`${directory}/index.json`);
  const facts = readCensusJson(`${directory}/facts.json.gz`, { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 });
  const { collectBatch } = await import("../../docs/operational-value/proof/functions/daily-astrostylelite-markdown-spellcheck.mjs");
  assert.equal(index.factsSha256, censusDigest(facts));
  assert.equal(facts.states.length, 29);
  assert.equal(facts.states[0].native.filesChecked, 150);
  assert.equal(scoreNativeSpelling("native-findings", facts.states[0].native), 1273);
  assert.equal(scoreNativeSpelling("native-findings", facts.states.at(-1).native), 2499);
  assert.equal(facts.states.at(-1).native.filesChecked, 259);
  const ids = new Set();
  let bytes = 0;
  for (const file of readdirSync(`${directory}/sources`).filter(file => /^[a-f0-9]{40}\.json\.gz$/.test(file))) {
    const source = readCensusJson(`${directory}/sources/${file}`), native = Buffer.from(source.native, "base64");
    assert.equal(source.id, file.slice(0, 40));
    verifyPublicGitBlob(native, source.id);
    const content = Buffer.from(source.content, "base64");
    assert.equal(createHash("sha256").update(content).digest("hex"), source.sha256);
    if (source.lfs) assert.deepEqual(parsePublicLfsPointer(native), source.lfs);
    else assert.deepEqual(content, native);
    bytes += content.length;
    ids.add(source.id);
  }
  assert.equal(ids.size, index.sourceBlobs);
  assert.equal(bytes, index.sourceBytes);
  for (const state of facts.states) {
    assert.deepEqual(state.files.map(file => file.path).sort(), [...state.native.paths].sort());
    assert.ok(state.files.every(file => ids.has(file.gitBlob)));
    assert.equal(state.native.sourceFilterCount, state.native.issues.length);
  }
  const current = facts.states.at(-1);
  const [collection] = collectBatch([{ windowStart: "2026-10-11T15:00:12Z", windowEnd: current.windowEnd }]);
  assert.equal(collection.evidence.coverageStatus, "complete");
  assert.equal(collection.evidence.fullGoalAcceptance, "not-measured");
  assert.equal(collection.evidence.workflowCausation, "not-measured");
  assert.equal(scoreNativeSpelling("native-findings", collection.evidence), 2499);
  assert.throws(() => collectBatch([{ repository: "other/repository", windowEnd: current.windowEnd }]), /mismatch/);
  const [previous] = collectBatch([{ windowStart: "2026-10-04T15:00:12Z", windowEnd: "2026-10-11T15:00:12Z" }]);
  assert.equal(previous.evidence.coverageStatus, "complete");
  const signal = readCensusJson("docs/operational-value/proof/reports/github-gh-aw/daily-astrostylelite-markdown-spellcheck-pulse.json").signal;
  assert.equal(signal.status, "worsening");
  assert.equal(signal.attention, "review");
  assert.equal(signal.directionAwareGain, -64);
});

test("the comparison extension retains every predecessor byte and native observation", () => {
  const directory = "docs/operational-value/proof/native-spelling";
  const version = "08759e0a2ede8b2947cba2f22b2bddf2b225e747c88c95690fa6d658a73f4da0";
  const archive = readCensusJson(`${directory}/versions/${version}/archive.json.gz`,
    { maxDecodedBytes: 128 * 1024 * 1024, maxParts: 1024 });
  assert.equal(archive.kind, "native-value-version-archive");
  assert.ok(archive.files.length > 1000);
  const temporary = mkdtempSync(path.join(os.tmpdir(), "cao-spelling-predecessor-"));
  try {
    for (const file of archive.files) {
      const bytes = Buffer.from(file.content, "base64");
      assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
      if (/^facts(?:-part-\d+)?\.json\.gz$/.test(file.path)) writeFileSync(path.join(temporary, file.path), bytes);
    }
    const previous = readCensusJson(path.join(temporary, "facts.json.gz"), { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 });
    const current = readCensusJson(`${directory}/facts.json.gz`, { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 });
    const originalIndex = JSON.parse(Buffer.from(archive.files.find(file => file.path === "index.json").content, "base64"));
    assert.equal(previous.states.length, 28);
    for (const state of previous.states) assert.deepEqual(current.states.find(row => row.windowEnd === state.windowEnd), state);
    assert.deepEqual(Buffer.from(archive.files.find(file => file.path === "function.txt").content, "base64"),
      readFileSync("docs/operational-value/proof/functions/daily-astrostylelite-markdown-spellcheck.mjs"));
    const index = readCensusJson(`${directory}/index.json`);
    assert.equal(index.comparisonContextExtension.previousIndexSha256, censusDigest(originalIndex));
    assert.equal(index.comparisonContextExtension.previousFactsSha256, censusDigest(previous));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("changed waiver policy preserves native findings but refuses a comparable improvement", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cao-spelling-policy-"));
  try {
    const [original] = readCensusJson("docs/operational-value/proof/native-spelling/contracts.json");
    const contract = { ...original, directory };
    const native = normalizeNativeSpellingReport(report([issue(false)]), [file], "/work");
    const facts = { states: [
      { windowEnd: "2026-10-11T15:00:12Z", commit: "a".repeat(40), inlinePolicySha256: "a".repeat(64), native },
      { windowEnd: "2026-10-18T15:00:12Z", commit: "b".repeat(40), inlinePolicySha256: "b".repeat(64), native },
    ] };
    writeCensusJson(`${directory}/facts.json.gz`, facts);
    writeCensusJson(`${directory}/index.json`, { complete: true, repository: contract.repository,
      sourceRevision: contract.sourceRevision, contractSha256: censusDigest(contract), factsSha256: censusDigest(facts) });
    const { collectBatch } = nativeSpellingModule(contract);
    const [collection] = collectBatch([{ windowStart: facts.states[0].windowEnd, windowEnd: facts.states[1].windowEnd }]);
    assert.equal(collection.evidence.coverageStatus, "partial");
    assert.match(collection.evidence.missingReason, /waiver continuity/);
    assert.equal(scoreNativeSpelling("native-findings", collection.evidence), 1);
    const [missing] = collectBatch([{ windowStart: facts.states[1].windowEnd, windowEnd: "2026-10-25T15:00:12Z" }]);
    assert.equal(missing.evidence.coverageStatus, "unknown");
    assert.equal(scoreNativeSpelling("native-findings", missing.evidence), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
