import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { definition } from "../docs/operational-value/proof/functions/daily-observability-report.mjs";

const directory = process.argv[2];
if (!directory) throw new Error("usage: node scripts/daily-observability-report-lineage.mjs SHARED_HISTORY_ROOT");
const { index, entities } = readOutputHistory(directory);
if (index.repository !== definition.repository || index.partitions.length !== 346 || entities.length !== 58048) {
  throw new Error("Unexpected shared retained discovery scope");
}
const selected = entities.filter(entity => entity.workflowReference?.workflowId === definition.slug
  || entity.unverifiedWorkflowId === definition.slug);
const digest = file => createHash("sha256").update(readFileSync(file)).digest("hex");
writeJsonArchive("docs/operational-value/proof/daily-observability-report/lineage-discovery.json.gz", {
  schemaVersion: 1, kind: "discovery-only", repository: index.repository,
  frozenFunctionSha256: digest("docs/operational-value/proof/functions/daily-observability-report.mjs"),
  historyIndexSha256: digest(path.join(directory, "history.json.gz")),
  verifiedPartitions: index.partitions.length, verifiedEntities: entities.length,
  index, selected,
  limitation: "Complete verification of this retained issue/PR inventory is not complete telemetry coverage. Editable markers and run links are discovery, not creation receipts, raw logging acceptance or workflow contribution.",
});
console.log(JSON.stringify({ verifiedPartitions: index.partitions.length, verifiedEntities: entities.length, selected: selected.length }));
