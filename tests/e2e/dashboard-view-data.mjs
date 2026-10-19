import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  deployedActivityShardEntries,
  legacyPhaseJsonToJsonl,
} from "./dashboard-deployed-refresh-helpers.mjs";

const memoryDownloadConcurrency = 8;
const digestPattern = /^[a-f0-9]{64}$/i;
const digest = (content) => createHash("sha256").update(content).digest("hex");

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Deployed dashboard manifest must contain an object.");
  }
  for (const [name, hash] of Object.entries(manifest)) {
    if (
      /[\\:\0\r\n?#%]/.test(name)
      || name.split("/").some((segment) => !segment || segment === "." || segment === "..")
      || typeof hash !== "string" || !digestPattern.test(hash)
    ) throw new Error("Deployed dashboard manifest contains an unsafe path or digest.");
  }
  if (!digestPattern.test(manifest["gh-aw-logs.sqlite"] ?? "")) {
    throw new Error("Deployed dashboard manifest is missing the canonical SQLite SHA-256.");
  }
}

async function settleDownloads(downloads) {
  const results = await Promise.allSettled(downloads);
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  return results.map((result) => result.value);
}

export async function downloadDeployedDashboardData(
  destination,
  sourceUrl,
  fetcher = fetch,
  maximumShardCount = Number.POSITIVE_INFINITY,
) {
  if (maximumShardCount !== Infinity && (!Number.isSafeInteger(maximumShardCount) || maximumShardCount < 0)) {
    throw new Error("The maximum dashboard shard count must be a nonnegative integer.");
  }
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
  validateManifest(manifest);
  const shards = deployedActivityShardEntries(manifest).slice(0, maximumShardCount);
  const preparedManifest = {};
  const writeVerified = async (response, name) => {
    if (!response.ok || !response.body) {
      throw new Error(`Unable to download deployed dashboard payload ${name}: HTTP ${response.status}.`);
    }
    const hash = createHash("sha256");
    let bytes = 0;
    const output = join(destination, name);
    await mkdir(dirname(output), { recursive: true });
    await pipeline(response.body, new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      },
    }), createWriteStream(output));
    const actual = hash.digest("hex");
    if (manifest[name] && actual !== manifest[name].toLowerCase()) {
      throw new Error(`Deployed dashboard payload checksum mismatch: ${name}.`);
    }
    preparedManifest[name] = actual;
    return bytes;
  };
  if (!inventoryResponse.body) throw new Error("Deployed dashboard inventory response has no body.");
  await mkdir(destination, { recursive: true });
  const snapshotResponse = await fetcher(new URL("gh-aw-logs.sqlite", sourceUrl));
  const [snapshotBytes, inventoryBytes] = await settleDownloads([
    writeVerified(snapshotResponse, "gh-aw-logs.sqlite"),
    writeVerified(inventoryResponse, "inventory-sources.json"),
  ]);
  const memoryRoot = new URL("memory/", sourceUrl);
  const memoryManifestResponse = await fetcher(new URL("manifest.json", memoryRoot));
  if (!memoryManifestResponse.ok && memoryManifestResponse.status !== 404) {
    throw new Error(`Unable to download deployed repository memory: HTTP ${memoryManifestResponse.status}.`);
  }
  const memoryContent = memoryManifestResponse.ok
    ? Buffer.from(await memoryManifestResponse.arrayBuffer())
    : Buffer.from('{"version":1,"campaigns":[]}\n');
  const memoryManifest = JSON.parse(memoryContent.toString("utf8"));
  const memoryHash = digest(memoryContent);
  if (manifest["memory/manifest.json"] && memoryHash !== manifest["memory/manifest.json"].toLowerCase()) {
    throw new Error("Deployed dashboard payload checksum mismatch: memory/manifest.json.");
  }
  const memoryDirectory = join(destination, "memory");
  await mkdir(memoryDirectory, { recursive: true });
  await writeFile(join(memoryDirectory, "manifest.json"), memoryContent);
  preparedManifest["memory/manifest.json"] = memoryHash;
  const memoryFiles = [];
  for (const campaign of Array.isArray(memoryManifest.campaigns) ? memoryManifest.campaigns : []) {
    if (
      typeof campaign?.campaign !== "string"
      || !/^[a-z0-9](?:[a-z0-9._-]{0,99})$/.test(campaign.campaign)
      || !Array.isArray(campaign.files)
    ) continue;
    const campaignRoot = new URL(`${campaign.campaign}/`, memoryRoot);
    for (const file of campaign.files) {
      if (
        typeof file?.path !== "string"
        || !file.path
        || file.path.startsWith("/")
        || file.path.includes("\\")
      ) continue;
      const fileUrl = new URL(file.path, campaignRoot);
      if (fileUrl.origin !== campaignRoot.origin || !fileUrl.href.startsWith(campaignRoot.href)) continue;
      const relativePath = decodeURIComponent(
        fileUrl.pathname.slice(campaignRoot.pathname.length),
      );
      if (
        !relativePath
        || relativePath.startsWith("/")
        || relativePath.includes("\\")
        || relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")
      ) continue;
      memoryFiles.push({
        campaign: campaign.campaign,
        path: file.path,
        url: fileUrl,
        relativePath,
      });
    }
  }
  let nextMemoryFile = 0;
  await settleDownloads(Array.from({ length: Math.min(memoryDownloadConcurrency, memoryFiles.length) }, async () => {
    while (nextMemoryFile < memoryFiles.length) {
      const file = memoryFiles[nextMemoryFile];
      nextMemoryFile += 1;
      const response = await fetcher(file.url);
      if (!response.ok || !response.body) {
        throw new Error(`Unable to download deployed repository memory file: ${file.path}.`);
      }
      await writeVerified(response, `memory/${file.campaign}/${file.relativePath}`);
    }
  }));
  let activityBytes = 0;
  for (const { name, sourceName, hash } of shards) {
    const response = await fetcher(new URL(sourceName, sourceUrl));
    if (!response.ok || !response.body) throw new Error(`Unable to download deployed dashboard shard: ${sourceName}.`);
    await mkdir(dirname(join(destination, name)), { recursive: true });
    if (sourceName.endsWith(".json")) {
      const original = Buffer.from(await response.arrayBuffer());
      if (digest(original) !== hash.toLowerCase()) {
        throw new Error(`Deployed dashboard payload checksum mismatch: ${sourceName}.`);
      }
      const converted = legacyPhaseJsonToJsonl(original);
      await writeFile(join(destination, name), converted);
      preparedManifest[name] = digest(converted);
      activityBytes += Buffer.byteLength(converted);
    } else {
      activityBytes += await writeVerified(response, name);
    }
  }
  const retainedManifest = Object.fromEntries(Object.keys(preparedManifest).sort().map((name) => [name, preparedManifest[name]]));
  await writeFile(join(destination, "payload-hashes.json"), JSON.stringify(retainedManifest));
  return { manifest: retainedManifest, shards, activityBytes, inventoryBytes, snapshotBytes };
}
