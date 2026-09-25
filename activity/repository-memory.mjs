import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const CAMPAIGN_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,99})$/;
const MEMORY_REF_PREFIX = "refs/remotes/origin/memory/";

function git(repository, arguments_, options = {}) {
  const result = spawnSync("git", ["-C", repository, ...arguments_], {
    encoding: options.encoding ?? "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString().trim() || `git ${arguments_[0]} failed`);
  }
  return result.stdout;
}

function campaignIds(inventory) {
  const rows = inventory?.campaigns?.rows;
  if (!Array.isArray(rows)) throw new Error("Campaign inventory is missing.");
  return new Set(rows
    .map((row) => String(row?.campaign ?? ""))
    .filter((campaign) => CAMPAIGN_PATTERN.test(campaign)));
}

function safeMemoryPath(value) {
  if (!value || value.startsWith("/") || value.includes("\\")) return "";
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return "";
  return segments.join("/");
}

function memoryRefs(repository, campaigns) {
  const output = git(repository, [
    "for-each-ref",
    "--format=%(refname)%09%(objectname)",
    MEMORY_REF_PREFIX,
  ]);
  return String(output).split("\n").filter(Boolean).flatMap((line) => {
    const [ref, commit] = line.split("\t");
    const campaign = ref?.slice(MEMORY_REF_PREFIX.length);
    return campaign && campaigns.has(campaign) && /^[0-9a-f]{40,64}$/i.test(commit ?? "")
      ? [{ campaign, ref, commit }]
      : [];
  }).sort((left, right) => left.campaign.localeCompare(right.campaign));
}

function memoryFiles(repository, ref) {
  const output = git(repository, ["ls-tree", "-rlz", "--full-tree", ref], { encoding: "buffer" });
  return output.toString("utf8").split("\0").filter(Boolean).flatMap((entry) => {
    const match = /^([0-9]{6}) blob ([0-9a-f]{40,64})\s+([0-9]+)\t([\s\S]+)$/i.exec(entry);
    if (!match || (match[1] !== "100644" && match[1] !== "100755")) return [];
    const filePath = safeMemoryPath(match[4]);
    return filePath ? [{ path: filePath, oid: match[2], size: Number(match[3]) }] : [];
  }).sort((left, right) => left.path.localeCompare(right.path));
}

async function writeBlob(repository, oid, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  const child = spawn("git", ["-C", repository, "cat-file", "blob", oid], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  await pipeline(child.stdout, createWriteStream(destination, { mode: 0o644 }));
  const status = await completion;
  if (status !== 0) throw new Error(stderr.trim() || `Unable to extract repository-memory blob ${oid}`);
}

export async function publishRepositoryMemory({ repository, inventory, output, generatedAt = new Date().toISOString() }) {
  const repositoryRoot = path.resolve(repository);
  const outputRoot = path.resolve(output);
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });

  const campaigns = [];
  for (const branch of memoryRefs(repositoryRoot, campaignIds(inventory))) {
    const files = memoryFiles(repositoryRoot, branch.ref);
    for (const file of files) {
      const destination = path.resolve(outputRoot, branch.campaign, ...file.path.split("/"));
      if (!destination.startsWith(`${path.join(outputRoot, branch.campaign)}${path.sep}`)) {
        throw new Error(`Repository-memory path escapes its campaign directory: ${file.path}`);
      }
      await writeBlob(repositoryRoot, file.oid, destination);
    }
    campaigns.push({
      campaign: branch.campaign,
      branch: `memory/${branch.campaign}`,
      commit: branch.commit,
      files,
    });
  }

  const manifest = { version: 1, generatedAt, campaigns };
  await writeFile(path.join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function main([repository, inventoryPath, output]) {
  if (!repository || !inventoryPath || !output) {
    throw new Error("Usage: repository-memory.mjs REPOSITORY INVENTORY OUTPUT");
  }
  await publishRepositoryMemory({
    repository,
    inventory: JSON.parse(await readFile(path.resolve(inventoryPath), "utf8")),
    output,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
