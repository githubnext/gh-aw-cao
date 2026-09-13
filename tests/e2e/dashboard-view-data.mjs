import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

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
  if (!logsResponse.body) throw new Error("Deployed dashboard data response has no body.");
  if (!inventoryResponse.body) throw new Error("Deployed dashboard inventory response has no body.");
  await mkdir(destination, { recursive: true });
  const downloads = await Promise.allSettled([
    pipeline(logsResponse.body, createWriteStream(join(destination, "gh-aw-logs.jsonl"))),
    pipeline(inventoryResponse.body, createWriteStream(join(destination, "inventory-sources.json"))),
  ]);
  const failure = downloads.find((download) => download.status === "rejected");
  if (failure) throw failure.reason;
}
