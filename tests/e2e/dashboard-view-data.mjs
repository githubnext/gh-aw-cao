import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function downloadDeployedDashboardData(destination, sourceUrl, fetcher = fetch) {
  const inventoryUrl = new URL("inventory-sources.json", sourceUrl);
  const [logsResponse, inventoryResponse] = await Promise.all([
    fetcher(sourceUrl),
    fetcher(inventoryUrl),
  ]);
  if (!logsResponse.ok) {
    throw new Error(`Unable to download deployed dashboard data: HTTP ${logsResponse.status}.`);
  }
  if (!inventoryResponse.ok) {
    throw new Error(
      `Unable to download deployed dashboard inventory: HTTP ${inventoryResponse.status}.`,
    );
  }
  await mkdir(destination, { recursive: true });
  await Promise.all([
    writeFile(join(destination, "gh-aw-logs.jsonl"), await logsResponse.text()),
    writeFile(join(destination, "inventory-sources.json"), await inventoryResponse.text()),
  ]);
}
