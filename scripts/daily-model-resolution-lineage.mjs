import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { definition } from "../docs/operational-value/proof/functions/daily-model-resolution.mjs";

const history = process.argv[2];
if (!history) throw new Error("Supply the authorized read-only output history root");
const { index, entities } = readOutputHistory(history);
if (index.repository !== definition.repository || index.until !== "2026-10-18T15:00:12Z") {
  throw new Error("Shared discovery history does not match frozen scope");
}
const selected = entities.filter(row => row.workflowReference?.workflowId === definition.slug
  || row.unverifiedWorkflowId === definition.slug);
const root = "docs/operational-value/proof/daily-model-resolution";
const originalIndex = readFileSync(path.join(history, "history.json.gz"));
copyFileSync(path.join(history, "history.json.gz"), path.join(root, "original-history-index.json.gz"));
writeJsonArchive(path.join(root, "selected-lineage.json.gz"), selected);
const summary = {
  schemaVersion: 1, repository: index.repository, until: index.until,
  historyIndexSha256: createHash("sha256").update(originalIndex).digest("hex"),
  verifiedPartitions: index.partitions.length, verifiedEntities: entities.length,
  selectedEntities: selected.length,
  selection: "Exact workflowReference.workflowId or unverifiedWorkflowId equal to daily-model-resolution",
  acceptedNativeOutcomes: null,
  explanation: "All original selected normalized identities retained losslessly. Editable lineage is discovery, never proxy request evidence or accepted model resolution.",
  functionSha256AtDiscovery: createHash("sha256")
    .update(readFileSync("docs/operational-value/proof/functions/daily-model-resolution.mjs")).digest("hex"),
};
writeFileSync(path.join(root, "lineage-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
