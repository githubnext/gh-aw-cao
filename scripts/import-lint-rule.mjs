import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { directory, hash, gitHash, read, validateCustody } from "../docs/operational-value/proof/lint-rule/native.mjs";

const [archive, manifestPath] = process.argv.slice(2);
if (!archive || !manifestPath) throw new Error("usage: import-lint-rule.mjs ARCHIVE EXTERNAL_MANIFEST");
const archiveBytes = readFileSync(archive), manifestBytes = readFileSync(manifestPath);
if (hash(archiveBytes) !== "9d672a2fea6b9dcd942d7b9b1ffba0b3f83cf479a52e15313ff962826018fc1a" ||
  hash(manifestBytes) !== "3c94f57d77c57823fb7e5b7278914324d8bd74f854ec9cf1b041e35d17abc853") throw new Error("Coordinated input digest mismatch");
const manifest = JSON.parse(manifestBytes);
if (manifest.repository !== "github/gh-aw" || manifest.repositoryId !== 1036865607 ||
  manifest.archive.bytes !== archiveBytes.length || manifest.archive.sha256 !== hash(archiveBytes)) throw new Error("Input scope mismatch");
const members = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n").filter(name => !name.endsWith("/"));
if (members.length !== manifest.files.length || members.some(name => !manifest.files.some(row => row.path === name))) throw new Error("Unexpected input archive members");
const originals = [];
for (const row of manifest.files) {
  if (!/^[a-z0-9-]+\/[a-z0-9.-]+$/.test(row.path) || row.path.includes("..")) throw new Error("Invalid archive path");
  const bytes = execFileSync("tar", ["-xOf", archive, row.path], { maxBuffer: 4 * 1024 * 1024 });
  if (row.bytes !== bytes.length || row.sha256 !== hash(bytes)) throw new Error("Original input integrity mismatch");
  originals.push({ ...row, content: bytes });
}
const write = (filename, value) => {
  const bytes = gzipSync(Buffer.from(JSON.stringify(value)), { level: 9, mtime: 0 });
  if (bytes.length > 256 * 1024) throw new Error("Oversized coordinated partition");
  writeFileSync(path.join(directory, filename), bytes);
  return { file: filename, bytes: bytes.length, sha256: hash(bytes) };
};
mkdirSync(path.join(directory, "coordinated"), { recursive: true });
const files = [];
let serial = 0;
for (const original of originals) {
  const parts = [];
  for (let offset = 0; offset < original.content.length; offset += 128 * 1024) {
    parts.push(write(`coordinated/original-${++serial}.json.gz`, {
      sourcePath: original.path, offset,
      base64: original.content.subarray(offset, offset + 128 * 1024).toString("base64"),
    }));
  }
  files.push({ path: original.path, bytes: original.bytes, sha256: original.sha256, parts });
}
write("coordinated/index.json.gz", { schemaVersion: 1, repository: manifest.repository,
  repositoryId: manifest.repositoryId, originalManifestSha256: hash(manifestBytes),
  archiveSha256: hash(archiveBytes), files, originalManifestBase64: manifestBytes.toString("base64") });

const packet = validateCustody(), objects = [...packet.objects.values()].map(({ content, ...row }) => row);
const ids = new Set(objects.map(row => row.id));
for (const original of originals.filter(row => row.path.endsWith(".blob"))) {
  const id = path.basename(original.path, ".blob");
  if (gitHash("blob", original.content) !== id) throw new Error("Coordinated Git blob identity mismatch");
  if (!ids.has(id)) {
    objects.push({ id, type: "blob", bytes: original.bytes, sha256: original.sha256, base64: original.content.toString("base64") });
    ids.add(id);
  }
}
const partitions = [];
let rows = [], size = 0;
for (const row of objects) {
  const n = JSON.stringify(row).length;
  if (rows.length && size + n > 180000) {
    partitions.push(write(`objects-${partitions.length + 1}.json.gz`, rows)); rows = []; size = 0;
  }
  rows.push(row); size += n;
}
if (rows.length) partitions.push(write(`objects-${partitions.length + 1}.json.gz`, rows));
const custody = read("custody.json.gz");
custody.partitions = partitions;
for (const row of custody.paths) if (row.status === "missing" && ids.has(row.blob)) row.status = "available";
custody.missing = custody.missing.filter(row => !ids.has(row.id));
custody.coordinatedInput = { index: "coordinated/index.json.gz", archiveSha256: hash(archiveBytes),
  manifestSha256: hash(manifestBytes), originalFiles: originals.length };
write("custody.json.gz", custody);
validateCustody();
console.log(JSON.stringify({ originalFiles: originals.length, gitObjects: objects.length, unresolvedObjects: custody.missing.length }));
