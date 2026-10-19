import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { cutoff, repository, revision } from "../docs/operational-value/proof/cli-consistency-checker/native.mjs";

const directory = process.argv[2];
if (!directory) throw new Error("Explicit previously acquired history directory required; no acquisition is performed");
const { index, entities } = readOutputHistory(directory);
if (index.repository !== repository || index.repositoryId !== 1036865607 || index.until !== cutoff
  || index.sourceRevision !== revision || index.complete !== true
  || index.connections?.issues?.complete !== true || index.connections?.pullRequests?.complete !== true
  || index.partitions.length !== 346 || entities.length !== 58048) {
  throw new Error("Frozen production history identity or totals mismatch");
}
const slug = "cli-consistency-checker";
const roots = entities.filter(row => row.workflowReference?.workflowId === slug || row.unverifiedWorkflowId === slug);
const selected = new Set(roots.map(row => row.number));
let changed = true;
while (changed) {
  changed = false;
  for (const row of entities) {
    if (selected.has(row.number) || row.relatedCandidates.some(number => selected.has(number))) {
      for (const number of [row.number, ...row.relatedCandidates]) {
        if (!selected.has(number)) { selected.add(number); changed = true; }
      }
    }
  }
}
const rows = entities.filter(row => selected.has(row.number));
const available = new Set(rows.map(row => row.number));
const missingNumbers = [...selected].filter(number => !available.has(number)).sort((a, b) => a - b);
const report = {
  schemaVersion: 1, repository, repositoryId: index.repositoryId, cutoff,
  historyVerification: { reader: ".github/skills/add-operational-value/scripts/collect-output-history.mjs#readOutputHistory",
    partitions: index.partitions.length, normalizedEntities: entities.length, complete: index.complete ?? null,
    limitation: "Original API response bodies were not retained by this production inventory. Its normalized entity bytes are discovery only." },
  originalIndex: { encoding: "base64", bytes: readFileSync(path.join(directory, "history.json.gz")).toString("base64") },
  originalPartitions: index.partitions.flatMap(part => {
    const bytes = readFileSync(path.join(directory, part.file));
    const partition = JSON.parse(gunzipSync(bytes));
    if (!partition.some(row => available.has(row.number))) return [];
    return [{ file: part.file, sha256: createHash("sha256").update(bytes).digest("hex"),
      encoding: "base64", content: bytes.toString("base64"),
      limitation: "Exact original normalized inventory partition bytes, including co-partitioned unrelated identities; no original API body payload was acquired." }];
  }),
  roots: roots.map(row => row.number), selectedNumbers: [...selected].sort((a, b) => a - b), missingNumbers,
  entities: rows,
  producerReviews: roots.map(row => ({ number: row.number, id: row.id, workflowReference: row.workflowReference,
    status: "discovery-only",
    executionIdentity: row.workflowReference ? "editable-marker-not-independent-run-verification" : "unverified-workflow-marker",
    safeOutputCreationReceipt: null, originalHelpArtifact: null, sourceBoundCaptureReceipt: null,
    acceptedNativeRepair: null, contribution: null,
    missingReason: "No original safe-output creation receipt, verified producer run/head or before/after native behavior/help payload is available in this normalized inventory." })),
  selectedLineageStatus: "All forward and reverse relatedCandidates reachable from workflow-marked roots retained; no body edge is promoted to a verified provider edge.",
  acceptedContribution: null,
};
const output = "docs/operational-value/proof/cli-consistency-checker";
mkdirSync(output, { recursive: true });
writeJsonArchive(path.join(output, "producers.json.gz"), report,
  { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 });
const bytes = readFileSync(path.join(directory, "history.json.gz"));
console.log(JSON.stringify({ partitions: index.partitions.length, entities: entities.length,
  roots: roots.length, selectedEntities: rows.length, unresolvedReferences: missingNumbers.length,
  historyIndexSha256: createHash("sha256").update(bytes).digest("hex"), producerAcceptance: null }, null, 2));
