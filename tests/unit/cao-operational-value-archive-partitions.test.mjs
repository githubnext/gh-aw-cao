import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { readCensusJson, writeCensusJson } from "../../scripts/operational-value-census-io.mjs";
import { readJson } from "../../.github/skills/add-operational-value/scripts/common.mjs";
import { readJsonArchive, writeJsonArchive } from "../../.github/skills/add-operational-value/scripts/json-archive.mjs";

test("oversized compressed archives round-trip identical facts through bounded digest-checked parts", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "cao-census-parts-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "index.json.gz");
  const facts = { unicode: "Native \u2713", opaque: randomBytes(400000).toString("hex") };
  writeCensusJson(file, facts);
  const manifest = JSON.parse(gunzipSync(readFileSync(file)));
  assert.equal(manifest.kind, "partitioned-census-json");
  assert.deepEqual(readCensusJson(file), facts);
  for (const part of manifest.parts) assert.ok(statSync(path.join(directory, part.file)).size <= 256 * 1024);
  writeCensusJson(path.join(directory, manifest.parts[0].file), "tampered");
  assert.throws(() => readCensusJson(file), /digest or size mismatch/);
  manifest.parts[0].file = "../outside-part-001.json.gz";
  writeCensusJson(file, manifest);
  assert.throws(() => readCensusJson(file), /Unsafe/);
});

test("large plain timelines and compressed evidence share bounded portable report IO without changing facts", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "cao-report-parts-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const facts = { unicode: "Native \u2713", opaque: randomBytes(400000).toString("hex") };
  for (const suffix of [".json", ".json.gz"]) {
    const file = path.join(directory, `timeline${suffix}`);
    const published = writeJsonArchive(file, facts);
    assert.ok(published.length > 2);
    assert.equal(published.at(-1), file, "publish part dependencies before their manifest");
    assert.deepEqual(readJson(file), facts);
    assert.deepEqual(readCensusJson(file), facts);
    for (const part of published) assert.ok(statSync(part).size <= 256 * 1024);
    assert.throws(() => readJsonArchive(file, { maxDecodedBytes: 1000 }), error =>
      error.code === "ERR_BUFFER_TOO_LARGE" || /exceeds decoded size limit/.test(error.message));
    assert.throws(() => writeJsonArchive(file, facts, { maxDecodedBytes: 1000 }), /limit/);
    assert.deepEqual(readJson(file), facts, "a rejected oversized write must not alter the accepted artifact");
  }
});
