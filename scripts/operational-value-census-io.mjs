import { createHash } from "node:crypto";
import path from "node:path";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

export const censusDigest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const readCensusJson = readJsonArchive;

export function writeCensusJson(file, value) {
  writeJsonArchive(file, value, { partitionPlain: false });
}

export function writeCensusEvidence(file, value) {
  const serialized = structuredClone(value);
  const outcomes = {};
  for (const observation of serialized.goUnitEvidence ?? []) {
    for (const shard of observation.shards ?? []) {
      if (!Number.isSafeInteger(shard.artifactId) || shard.artifactId <= 0 || !Array.isArray(shard.testOutcomes)) {
        throw new Error("Invalid normalized Go test artifact");
      }
      if (Object.hasOwn(outcomes, shard.artifactId) && censusDigest(outcomes[shard.artifactId]) !== censusDigest(shard.testOutcomes)) {
        throw new Error("Conflicting normalized evidence for the same immutable artifact");
      }
      outcomes[shard.artifactId] = shard.testOutcomes;
      delete shard.testOutcomes;
    }
  }
  const name = `${path.basename(file).replace(/\.json(?:\.gz)?$/, "")}-go-unit-tests.json.gz`;
  writeCensusJson(path.join(path.dirname(file), name), outcomes);
  serialized.normalizedGoTests = { file: name, sha256: censusDigest(outcomes) };
  writeCensusJson(file, serialized);
}

export function readCensusEvidence(file) {
  const value = readCensusJson(file);
  if (!value.normalizedGoTests) return value;
  const reference = value.normalizedGoTests;
  if (typeof reference.file !== "string" || reference.file !== path.basename(reference.file)
    || !reference.file.endsWith(".json.gz")) throw new Error("Invalid normalized evidence reference");
  const outcomes = readCensusJson(path.join(path.dirname(file), reference.file));
  if (censusDigest(outcomes) !== reference.sha256) throw new Error("Normalized evidence digest mismatch");
  for (const observation of value.goUnitEvidence ?? []) {
    for (const shard of observation.shards ?? []) {
      if (!Number.isSafeInteger(shard.artifactId) || shard.artifactId <= 0
        || !Array.isArray(outcomes[shard.artifactId])) throw new Error("Missing normalized test artifact");
      shard.testOutcomes = outcomes[shard.artifactId];
    }
  }
  return value;
}
