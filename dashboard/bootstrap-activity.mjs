import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDashboardControlSettings } from "../activity/control-settings.mjs";
import { discoverInventory } from "../activity/inventory.mjs";
import { buildInventoryDashboardSources } from "../activity/inventory-sources.mjs";

export async function bootstrapActivity({
  root,
  directory,
  repository,
  generatedAt = new Date().toISOString(),
}) {
  const controlSettings = resolveDashboardControlSettings({
    repository,
    controlProgram: fileURLToPath(new URL("../.github/workflows/shared/control.mjs", import.meta.url)),
    policyPath: path.join(root, ".github/workflows/cao.json"),
  });
  if (controlSettings.policy_resolution.status !== "available") {
    throw new Error(`Cannot bootstrap dashboard: ${controlSettings.policy_resolution.reason}`);
  }
  const inventory = discoverInventory(root, { generatedAt });
  const sources = buildInventoryDashboardSources({
    inventory,
    controlSettings,
    repository,
    generatedAt,
  });
  delete sources["marketplace-packages"];
  delete sources["marketplace-registries"];
  for (const source of Object.values(sources)) {
    source.metadata.completeness = "partial";
    source.metadata["collection-operation"] = "local-inventory-bootstrap";
    source.metadata["collection-state"] = "partial";
    source.metadata["collection-reason"] = "Local installation metadata only; Activity has not collected a snapshot yet.";
  }
  // A checked-in workflow does not establish its live Actions registry state.
  for (const row of sources.workflows.rows) row["workflow-active"] = "unknown";

  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length > 0) {
    throw new Error("Cannot bootstrap dashboard over existing activity data");
  }
  await mkdir(path.join(directory, "gh-aw-logs-shards"));
  const files = {
    "control-settings.json": controlSettings,
    "inventory-sources.json": sources,
    "gh-aw-logs-shards/bootstrap.jsonl": {
      schema_version: 2,
      kind: "workflow_runs",
      request: { repository },
      payload: [],
    },
  };
  for (const [name, value] of Object.entries(files)) {
    await writeFile(path.join(directory, name), `${JSON.stringify(value)}\n`, { flag: "wx" });
  }
}
