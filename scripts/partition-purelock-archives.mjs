import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const fileLimit = 256 * 1024;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export function purelockFileSha256(file) {
  return hash(readFileSync(file));
}

export function verifyPurelockFileSha256(file, expected) {
  const bytes = readFileSync(file);
  if (file.endsWith(".json")) {
    const manifest = JSON.parse(bytes.toString());
    if (manifest?.kind === "partitioned-census-json") {
      readJsonArchive(file);
      if (manifest.sha256 === expected) return true;
    }
  }
  return hash(bytes) === expected;
}

export function partitionPurelockArchives(directory = "docs/operational-value/proof/purelock") {
  const converted = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      converted.push(...partitionPurelockArchives(file));
      continue;
    }
    if (!entry.isFile()) throw new Error(`Unsupported PureLock archive entry: ${file}`);
    const original = readFileSync(file);
    if (original.length <= fileLimit) continue;
    if (!file.endsWith(".json")) throw new Error(`Oversized non-JSON PureLock archive: ${file}`);
    const value = JSON.parse(original.toString());
    if (!original.equals(Buffer.from(`${JSON.stringify(value, null, 2)}\n`))) {
      throw new Error(`Cannot losslessly reencode noncanonical PureLock JSON: ${file}`);
    }
    const sha256 = hash(original), decodedSha256 = hash(JSON.stringify(value));
    const files = writeJsonArchive(file, value);
    if (!verifyPurelockFileSha256(file, sha256) || hash(JSON.stringify(readJsonArchive(file))) !== decodedSha256
      || files.some(part => readFileSync(part).length > fileLimit)) {
      throw new Error(`PureLock archive partition verification failed: ${file}`);
    }
    converted.push({ file, originalBytes: original.length, sha256, decodedSha256, files });
  }
  return converted;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify({ partitioned: partitionPurelockArchives() }));
}
