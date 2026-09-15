import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

export async function downloadDeployedDashboardData(destination, sourceUrl, fetcher = fetch) {
  const inventoryUrl = new URL("inventory-sources.json", sourceUrl);
  const [manifestResponse, inventoryResponse] = await Promise.all([
    fetcher(sourceUrl),
    fetcher(inventoryUrl),
  ]);
  if (!manifestResponse.ok) {
    throw new Error(`Unable to download deployed dashboard data: HTTP ${manifestResponse.status}.`);
  }
  if (!inventoryResponse.ok) {
    throw new Error(
      `Unable to download deployed dashboard inventory: HTTP ${inventoryResponse.status}.`,
    );
  }
  const manifest = await manifestResponse.json();
  if (!inventoryResponse.body) throw new Error("Deployed dashboard inventory response has no body.");
  await mkdir(destination, { recursive: true });
  await pipeline(inventoryResponse.body, createWriteStream(join(destination, "inventory-sources.json")));
  const shardDirectory = join(destination, "gh-aw-logs-shards");
  await mkdir(shardDirectory);
  for (const name of Object.keys(manifest).filter((name) => name.startsWith("gh-aw-logs-shards/")).sort()) {
    const response = await fetcher(new URL(name, sourceUrl));
    if (!response.ok || !response.body) throw new Error(`Unable to download deployed dashboard shard: ${name}.`);
    await pipeline(response.body, createWriteStream(join(destination, name)));
  }
}
