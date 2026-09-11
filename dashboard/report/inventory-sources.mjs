import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { actionsLog as log } from "../../activity/actions-log.mjs";
import { buildInventoryDashboardSources } from "./dashboard-language-sources.mjs";

export async function main() {
  const inventoryPath = process.env.REPORT_INVENTORY;
  const controlSettingsPath = process.env.REPORT_CONTROL_SETTINGS;
  const outputPath = process.env.REPORT_INVENTORY_SOURCES;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!inventoryPath || !controlSettingsPath || !outputPath || !repository) {
    throw new Error("REPORT_INVENTORY, REPORT_CONTROL_SETTINGS, REPORT_INVENTORY_SOURCES, and GITHUB_REPOSITORY are required");
  }

  log.group`Build dashboard inventory sources`;
  try {
    const [inventory, controlSettings] = await Promise.all([
      readFile(inventoryPath, "utf8").then(JSON.parse),
      readFile(controlSettingsPath, "utf8").then(JSON.parse),
    ]);
    const sources = buildInventoryDashboardSources({ inventory, controlSettings, repository });
    await writeFile(path.resolve(outputPath), `${JSON.stringify(sources, null, 2)}\n`);
    log.info`Wrote ${sources.packages.rows.length} packages and ${sources.workflows.rows.length} workflows`;
  } finally {
    log.endGroup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    log.error`${error.stack || error.message || error}`;
    process.exitCode = 1;
  });
}
