import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const keys = ["daily-code-debt-aider", "code-simplifier"];
const contracts = readJsonArchive("docs/operational-value/gh-aw-census/contracts.json.gz");
console.log("CENSUS", JSON.stringify(contracts.contracts.filter(row => keys.some(key => row.path?.endsWith(`/${key}.md`))), null, 2));
const { index, entities } = readOutputHistory("docs/operational-value/gh-aw-workflows/evidence");
console.log("INVENTORY", index.totalEntities, index.partitions.length);
for (const key of keys) {
  const rows = entities.filter(row => row.workflowReference?.workflowId === key);
  console.log(key, JSON.stringify(rows.map(row => ({ number: row.number, kind: row.kind, mergedAt: row.mergedAt }))));
}
