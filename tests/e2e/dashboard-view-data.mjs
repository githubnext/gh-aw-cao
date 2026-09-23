import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  deployedActivityShardEntries,
  legacyPhaseJsonToJsonl,
} from "./dashboard-deployed-refresh-helpers.mjs";

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
  for (const { name, sourceName } of deployedActivityShardEntries(manifest)) {
    const response = await fetcher(new URL(sourceName, sourceUrl));
    if (!response.ok || !response.body) throw new Error(`Unable to download deployed dashboard shard: ${sourceName}.`);
    await mkdir(dirname(join(destination, name)), { recursive: true });
    if (sourceName.endsWith(".json")) {
      await writeFile(join(destination, name), legacyPhaseJsonToJsonl(Buffer.from(await response.arrayBuffer())));
    } else {
      await pipeline(response.body, createWriteStream(join(destination, name)));
    }
  }
}
