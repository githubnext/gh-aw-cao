import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { gitEvidence } from "../.github/skills/add-operational-value/scripts/git-evidence.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { hashFile } from "./collect-lint-native-history.mjs";
import { radixFacts, eslintVersion } from "./eslint-radix-native.mjs";
import { lintEffect } from "./lint-native-oracles.mjs";

const base = "docs/operational-value/proof/eslint-monster";
const directory = path.join(base, "radix");
if (existsSync(directory)) throw new Error("Refusing to overwrite retained radix evidence");
const index = readCensusJson(path.join(base, "native-index.json"));
const rows = index.partitions.flatMap(part => {
  const values = readCensusJson(path.join(base, part.file));
  if (censusDigest(values) !== part.sha256) throw new Error("Retained lineage digest mismatch");
  return values;
});
const git = gitEvidence(index.repository, process.argv[2]);
const blobs = rows.flatMap(row => [row.beforeBlob, row.afterBlob].filter(Boolean));
const acquisition = git.features(blobs, values => values.map(row => ({ id: row.id, ...radixFacts(row.content) })),
  { maxBlobs: 5000, maxBytes: 128 * 1024 * 1024 });
mkdirSync(directory, { recursive: true });
const partitions = [];
for (let offset = 0; offset < rows.length; offset += 200) {
  const values = rows.slice(offset, offset + 200).map(row => {
    const before = acquisition.features.get(row.beforeBlob) ?? null, after = acquisition.features.get(row.afterBlob) ?? null;
    const modesValid = [row.beforeMode, row.afterMode].every(mode => ["000000", "100644", "100755"].includes(mode));
    return { ...row, before, after, value: modesValid ? lintEffect(before, after) : null };
  });
  const file = `native-${String(partitions.length + 1).padStart(3, "0")}.json.gz`;
  writeCensusJson(path.join(directory, file), values);
  partitions.push({ file, sha256: censusDigest(values), rows: values.length });
}
writeCensusJson(path.join(directory, "native-index.json"), { ...index, partitions, eslintVersion,
  oracleSha256: hashFile(new URL("./eslint-radix-native.mjs", import.meta.url)),
  collectorSha256: hashFile(import.meta.filename), parentIndexSha256: censusDigest(index) });
console.log(JSON.stringify({ blobs: acquisition.uniqueBlobs, rows: rows.length }));
