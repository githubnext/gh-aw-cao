import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const CAMPAIGN_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,99})$/;
const MEMORY_REF_PREFIX = "refs/remotes/origin/memory/";
export const REPOSITORY_MEMORY_LIMITS = Object.freeze({
  allowedExtensions: Object.freeze([".json", ".jsonl", ".md", ".txt", ".yaml", ".yml"]),
  maxFileCount: 400,
  maxFileSize: 1024 * 1024,
  maxNesting: 10,
  maxTotalSize: 64 * 1024 * 1024,
});
const ALLOWED_EXTENSIONS = new Set(REPOSITORY_MEMORY_LIMITS.allowedExtensions);

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

function classifyMemoryPath(value) {
  if (!value || value.startsWith("/") || value.includes("\\")) return "unsafePath";
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return "unsafePath";
  if (segments.length - 1 > REPOSITORY_MEMORY_LIMITS.maxNesting) return "nesting";
  if (!ALLOWED_EXTENSIONS.has(path.posix.extname(value).toLowerCase())) return "extension";
  return "";
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

async function memoryFiles(repository, ref) {
  const child = spawn("git", ["-C", repository, "ls-tree", "-rlz", "--full-tree", ref], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-65536); });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal }));
  });

  const files = [];
  const omitted = {
    fileLimit: 0,
    fileSize: 0,
    totalSize: 0,
    extension: 0,
    nesting: 0,
    unsafePath: 0,
    invalidContent: 0,
    unsupportedType: 0,
  };
  let pending = Buffer.alloc(0);
  try {
    for await (const chunk of child.stdout) {
      pending = Buffer.concat([pending, chunk]);
      let separator;
      while ((separator = pending.indexOf(0)) >= 0) {
        const entry = pending.subarray(0, separator).toString("utf8");
        pending = pending.subarray(separator + 1);
        const match = /^([0-9]{6}) (?:blob|commit) ([0-9a-f]{40,64})\s+(?:([0-9]+)|-)\t([\s\S]+)$/i.exec(entry);
        if (!match) continue;
        if ((match[1] !== "100644" && match[1] !== "100755") || match[3] === undefined) {
          omitted.unsupportedType += 1;
          continue;
        }
        const pathReason = classifyMemoryPath(match[4]);
        if (pathReason) {
          omitted[pathReason] += 1;
          continue;
        }
        const size = Number(match[3]);
        if (!Number.isSafeInteger(size) || size > REPOSITORY_MEMORY_LIMITS.maxFileSize) {
          omitted.fileSize += 1;
          continue;
        }
        if (files.length >= REPOSITORY_MEMORY_LIMITS.maxFileCount) {
          omitted.fileLimit += 1;
          continue;
        }
        files.push({ path: match[4], oid: match[2], size });
      }
    }
    const { status } = await completion;
    if (status !== 0) throw new Error(stderr.trim() || "git ls-tree failed");
    return { files, omitted };
  } catch (error) {
    child.kill();
    await completion.catch(() => undefined);
    throw error;
  }
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
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let validUtf8 = true;
  const hasher = new Transform({
    transform(chunk, encoding, callback) {
      hash.update(chunk);
      try {
        decoder.decode(chunk, { stream: true });
      } catch {
        validUtf8 = false;
      }
      callback(null, chunk);
    },
    flush(callback) {
      try {
        decoder.decode();
      } catch {
        validUtf8 = false;
      }
      callback();
    },
  });
  await pipeline(child.stdout, hasher, createWriteStream(destination, { mode: 0o644 }));
  const status = await completion;
  if (status !== 0) throw new Error(stderr.trim() || `Unable to extract repository-memory blob ${oid}`);
  if (!validUtf8) {
    await rm(destination, { force: true });
    return null;
  }
  return hash.digest("hex");
}

export async function publishRepositoryMemory({ repository, inventory, output, generatedAt = new Date().toISOString() }) {
  const repositoryRoot = path.resolve(repository);
  const outputRoot = path.resolve(output);
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });

  const campaigns = [];
  let totalSize = 0;
  for (const branch of memoryRefs(repositoryRoot, campaignIds(inventory))) {
    const { files, omitted } = await memoryFiles(repositoryRoot, branch.ref);
    const publishedFiles = [];
    for (const file of files) {
      if (totalSize + file.size > REPOSITORY_MEMORY_LIMITS.maxTotalSize) {
        omitted.totalSize += 1;
        continue;
      }
      const destination = path.resolve(outputRoot, branch.campaign, ...file.path.split("/"));
      if (!destination.startsWith(`${path.join(outputRoot, branch.campaign)}${path.sep}`)) {
        throw new Error(`Repository-memory path escapes its campaign directory: ${file.path}`);
      }
      const sha256 = await writeBlob(repositoryRoot, file.oid, destination);
      if (!sha256) {
        omitted.invalidContent += 1;
        continue;
      }
      totalSize += file.size;
      publishedFiles.push({ ...file, sha256 });
    }
    campaigns.push({
      campaign: branch.campaign,
      branch: `memory/${branch.campaign}`,
      commit: branch.commit,
      files: publishedFiles,
      omitted,
    });
  }

  const manifest = { version: 1, generatedAt, limits: REPOSITORY_MEMORY_LIMITS, campaigns };
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
