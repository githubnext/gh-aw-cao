import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gitEvidence } from "../.github/skills/add-operational-value/scripts/git-evidence.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { eligibleGoPath, evaluateGoHistory } from "./native-go-measures.mjs";

function writeParts(directory, label, rows) {
  const parts = [];
  let group = [], bytes = 0;
  const flush = () => {
    if (!group.length) return;
    const file = `${label}-${String(parts.length + 1).padStart(4, "0")}.json.gz`;
    writeCensusJson(path.join(directory, file), group);
    parts.push({ file, sha256: censusDigest(group), count: group.length });
    group = []; bytes = 0;
  };
  for (const row of rows) {
    const length = Buffer.byteLength(JSON.stringify(row));
    if (group.length && length + bytes > 512000) flush();
    group.push(row); bytes += length;
  }
  flush();
  return parts;
}

export function readGoHistory(directory) {
  const index = readCensusJson(path.join(directory, "native-history.json.gz"));
  if (index.schemaVersion !== 1 || index.kind !== "native-go-history" || index.complete !== true) {
    throw new Error("Incomplete native Go history");
  }
  const read = parts => parts.flatMap(part => {
    if (typeof part.file !== "string" || part.file !== path.basename(part.file) || !part.file.endsWith(".json.gz")) {
      throw new Error("Unsafe native history partition");
    }
    const rows = readCensusJson(path.join(directory, part.file));
    if (!Array.isArray(rows) || rows.length !== part.count || censusDigest(rows) !== part.sha256) {
      throw new Error("Native history partition integrity mismatch");
    }
    return rows;
  });
  const history = read(index.history), features = read(index.features);
  if (history.length !== index.commits || features.length !== index.uniqueBlobs) throw new Error("Native history total mismatch");
  if (new Set(history.map(row => row.commit)).size !== history.length) throw new Error("Duplicate native history commit");
  const evaluated = evaluateGoHistory(history, features);
  return { index, history, features, evaluated };
}

export function collectGoHistory(repository, revision, baseline, since, directory, cache, budgets = {}) {
  if (existsSync(path.join(directory, "native-history.json.gz"))) throw new Error("Refusing to overwrite preserved native evidence");
  mkdirSync(directory, { recursive: true });
  const git = gitEvidence(repository, cache);
  const startedAt = new Date().toISOString();
  const history = git.history(revision, baseline, since);
  writeParts(directory, "history", history);
  console.error(`Acquired ${history.length} immutable Go-change commits`);
  const oracle = path.join(cache, "native-go-oracle");
  const source = path.resolve("scripts/operational-value-go-oracle.go");
  execFileSync("go", ["build", "-o", oracle, source], { timeout: 120000 });
  const blobs = history.flatMap(commit => commit.changes.filter(change => eligibleGoPath(change.path))
    .filter(change => [change.beforeMode, change.afterMode].every(mode => ["000000", "100644", "100755"].includes(mode)))
    .flatMap(change => [change.beforeBlob, change.afterBlob].filter(Boolean)));
  let completed = 0;
  const facts = git.features(blobs, batch => {
    const result = execFileSync(oracle, [], { encoding: "utf8", timeout: 120000, maxBuffer: 128 * 1024 * 1024,
      input: batch.map(value => JSON.stringify(value)).join("\n") + "\n" }).trim().split("\n").map(line => JSON.parse(line));
    completed += result.length;
    console.error(`Analyzed ${completed} native Go blobs`);
    return result.map((fact, index) => {
      let lines = 0;
      for (let at = batch[index].content.indexOf("\n"); at !== -1; at = batch[index].content.indexOf("\n", at + 1)) lines++;
      return { ...fact, lines };
    });
  }, budgets);
  const index = { schemaVersion: 1, kind: "native-go-history", repository, revision, baseline, since,
    startedAt, completedAt: new Date().toISOString(), complete: true,
    oracleSha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
    collectorSha256: createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex"),
    lineCounter: "newline-byte-count-v1",
    toolchain: execFileSync("go", ["version"], { encoding: "utf8" }).trim(),
    commits: history.length, uniqueBlobs: facts.uniqueBlobs, totalBytes: facts.totalBytes,
    history: writeParts(directory, "history", history), features: writeParts(directory, "features", [...facts.features.values()]) };
  evaluateGoHistory(history, [...facts.features.values()]);
  writeCensusJson(path.join(directory, "native-history.json.gz"), index);
  return index;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 6) throw new Error("usage: measure-go-native-history.mjs OWNER/REPO REVISION BASELINE SINCE NEW_ARCHIVE BARE_CACHE");
  console.log(JSON.stringify(collectGoHistory(...args)));
}
