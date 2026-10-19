import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonArchive, writeJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { assess, hash } from "./native-checker.mjs";
import { verifyBlob } from "./collect.mjs";
import { compareSurviving } from "./compare-v2.mjs";

const home = path.dirname(fileURLToPath(import.meta.url));
const original = readJsonArchive(path.join(home, "native-evidence.json.gz"));
const missingIds = new Set(original.missing.map(row => row.id));
for (const snapshot of original.snapshots) {
  const files = Object.fromEntries(Object.entries(snapshot.paths).map(([name, entry]) => {
    if (missingIds.has(entry.id)) return [name, entry];
    const blob = readJsonArchive(path.join(home, "blobs", `${entry.id}.json.gz`));
    const bytes = Buffer.from(blob.contentBase64, "base64");
    verifyBlob(bytes, entry.id);
    if (hash(bytes) !== blob.sha256 || bytes.length !== blob.bytes) throw new Error("Retained source identity mismatch");
    return [name, { ...entry, content: bytes.toString("utf8") }];
  }));
  if (hash(JSON.stringify(assess(files, original.inventory))) !== hash(JSON.stringify(snapshot.assessment))) {
    throw new Error("Retained native replay mismatch");
  }
}
const result = {
  ...original,
  toolchain: {
    ...original.toolchain,
    comparatorSha256: hash(readFileSync(new URL("./compare-v2.mjs", import.meta.url))),
    sourceReviewSha256: hash(readFileSync(new URL("./source-review.json", import.meta.url))),
  },
  intervals: original.snapshots.slice(1).map((after, i) => ({
    windowStart: original.snapshots[i].at, windowEnd: after.at,
    beforeCommit: original.snapshots[i].commit, afterCommit: after.commit,
    ...compareSurviving(original.snapshots[i], after, missingIds),
    coverageStatus: "partial",
  })),
  correction: {
    contractKey: "safe-output-independent-native-conformance-v2",
    reason: "Source-only full-specification review SRC-12: required-component creation is not same-surviving-file clearance.",
    sealedV1EvidenceSha256: hash(readFileSync(new URL("./native-evidence.json.gz", import.meta.url))),
    sourceReview: "source-review.json",
    outcomeTuning: false,
  },
};
const output = path.join(home, "native-evidence-v2.json.gz");
writeJsonArchive(output, result);
if (hash(JSON.stringify(readJsonArchive(output))) !== hash(JSON.stringify(result))) throw new Error("Corrected evidence replay mismatch");
console.log(JSON.stringify({
  comparatorSha256: result.toolchain.comparatorSha256,
  sourceReviewSha256: result.toolchain.sourceReviewSha256,
  intervals: result.intervals.map(row => ({ end: row.windowEnd, remediated: row.remediated.length,
    excludedNonSurviving: row.excludedNonSurviving.length })),
}, null, 2));
