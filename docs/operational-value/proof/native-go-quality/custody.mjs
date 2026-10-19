import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

export const base = new URL("./", import.meta.url);
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const gitId = (type, bytes) => createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
export const repository = "github/gh-aw";
export const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
export const cutoff = "2026-10-18T15:00:12Z";

// Portable skill JSON archive wire format, kept local for dependency-free replay.
export function readJson(file) {
  const filename = file instanceof URL ? file.pathname : file;
  const read = name => JSON.parse(name.endsWith(".gz")
    ? gunzipSync(readFileSync(name), { maxOutputLength: 64 * 1024 * 1024 }).toString() : readFileSync(name, "utf8"));
  const value = read(filename);
  if (value?.kind !== "partitioned-census-json") return value;
  if (value.schemaVersion !== 1 || value.encoding !== "base64-json-utf8"
    || !Array.isArray(value.parts) || !value.parts.length || value.parts.length > 512) throw new Error("Invalid portable archive");
  let size = 0;
  const chunks = value.parts.map(part => {
    if (typeof part.file !== "string" || !/^[\w.-]+-part-\d{3}\.json\.gz$/.test(part.file)) throw new Error("Unsafe archive part");
    const text = read(path.join(path.dirname(filename), part.file));
    if (typeof text !== "string") throw new Error("Invalid portable archive part");
    const bytes = Buffer.from(text, "base64");
    size += bytes.length;
    if (size > 64 * 1024 * 1024 || bytes.toString("base64") !== text || sha256(bytes) !== part.sha256) throw new Error("Archive part custody mismatch");
    return bytes;
  });
  const bytes = Buffer.concat(chunks);
  if (sha256(bytes) !== value.sha256) throw new Error("Portable archive digest mismatch");
  return JSON.parse(bytes);
}

export function writeJson(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  const compressed = gzipSync(bytes, { level: 9 });
  if (compressed.length <= 256 * 1024) { writeFileSync(file, compressed); return; }
  const prefix = path.basename(file).replace(/\.json(?:\.gz)?$/, ""), parts = [];
  for (let start = 0; start < bytes.length; start += 192 * 1024) {
    const chunk = bytes.subarray(start, start + 192 * 1024);
    const name = `${prefix}-part-${String(parts.length + 1).padStart(3, "0")}.json.gz`;
    writeFileSync(path.join(path.dirname(file), name), gzipSync(JSON.stringify(chunk.toString("base64")), { level: 9 }));
    parts.push({ file: name, sha256: sha256(chunk) });
  }
  writeFileSync(file, gzipSync(JSON.stringify({ schemaVersion: 1, kind: "partitioned-census-json",
    encoding: "base64-json-utf8", sha256: sha256(bytes), parts }), { level: 9 }));
}

export function apiOriginals() {
  const files = readdirSync(new URL("api", base)).filter(name => name.endsWith(".json.gz") && !/-part-\d{3}\.json\.gz$/.test(name));
  const rows = files.map(file => {
    const envelope = readJson(new URL(`api/${file}`, base));
    const bytes = Buffer.from(envelope.contentBase64, "base64");
    if (bytes.length !== envelope.bytes || bytes.toString("base64") !== envelope.contentBase64
      || sha256(bytes) !== envelope.sha256) throw new Error("API original custody mismatch");
    return { file, envelope, body: JSON.parse(bytes) };
  });
  const metadata = rows.find(row => row.file === "repository.json.gz")?.body;
  if (metadata?.id !== 1036865607 || metadata.full_name !== repository || metadata.private !== false
    || metadata.visibility !== "public") throw new Error("Public authority mismatch");
  return rows;
}

export function objectBytes(row) {
  if (!row || !["commit", "tree", "blob"].includes(row.type) || !/^[a-f0-9]{40}$/.test(row.id ?? "")
    || typeof row.contentBase64 !== "string") throw new Error("Invalid original object");
  const bytes = Buffer.from(row.contentBase64, "base64");
  if (bytes.length !== row.bytes || bytes.toString("base64") !== row.contentBase64
    || sha256(bytes) !== row.sha256 || gitId(row.type, bytes) !== row.id) throw new Error("Git object custody mismatch");
  return bytes;
}

export function treeEntries(bytes) {
  const entries = new Map();
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset), end = bytes.indexOf(0, space + 1);
    if (space < offset || end < space || end + 21 > bytes.length) throw new Error("Malformed tree");
    const mode = bytes.subarray(offset, space).toString(), name = bytes.subarray(space + 1, end).toString();
    if (!["40000", "100644", "100755", "120000", "160000"].includes(mode)
      || !name || name.includes("/") || name === "." || name === ".." || entries.has(name)) throw new Error("Unsafe tree entry");
    entries.set(name, { mode, id: bytes.subarray(end + 1, end + 21).toString("hex") });
    offset = end + 21;
  }
  return entries;
}

export function validateCustody(data, originals) {
  if (data.repository !== repository || data.repositoryId !== 1036865607 || data.revision !== revision
    || data.cutoff !== cutoff || !Array.isArray(data.paths)) throw new Error("Source scope mismatch");
  const objects = new Map();
  for (const row of originals) {
    if (objects.has(row.id)) throw new Error("Repeated original object");
    objects.set(row.id, { type: row.type, bytes: objectBytes(row) });
  }
  const get = (id, type) => {
    const row = objects.get(id);
    if (!row || row.type !== type) throw new Error(`Missing original ${type} ${id}`);
    return row.bytes;
  };
  const commit = id => {
    const header = get(id, "commit").toString().split("\n\n")[0];
    const tree = header.match(/^tree ([a-f0-9]{40})$/m)?.[1];
    const seconds = header.match(/^committer .* (\d+) [+-]\d{4}$/m)?.[1];
    if (!tree || !seconds) throw new Error("Malformed commit");
    return { tree, parents: [...header.matchAll(/^parent ([a-f0-9]{40})$/gm)].map(row => row[1]),
      at: new Date(Number(seconds) * 1000).toISOString().replace(".000Z", "Z") };
  };
  const resolve = (id, file) => {
    if (typeof file !== "string" || file.startsWith("/") || file.split("/").some(p => !p || p === "." || p === "..")) throw new Error("Unsafe source path");
    let tree = commit(id).tree;
    const parts = file.split("/");
    for (let i = 0; i < parts.length; i++) {
      const row = treeEntries(get(tree, "tree")).get(parts[i]);
      if (!row) return null;
      if (i === parts.length - 1) {
        if (!["100644", "100755"].includes(row.mode)) throw new Error("Non-regular source");
        return row.id;
      }
      if (row.mode !== "40000") throw new Error("Non-tree ancestor");
      tree = row.id;
    }
    throw new Error("Empty source path");
  };
  const paths = new Map();
  for (const row of data.paths) {
    const key = `${row.commit}:${row.path}`;
    if (paths.has(key)) throw new Error("Repeated source proof");
    if (resolve(row.commit, row.path) !== row.blob) throw new Error("Source path custody mismatch");
    if (row.blob !== null && !row.proofOnly) get(row.blob, "blob");
    paths.set(key, row);
  }
  return { data, commit, resolve, source(id, file) {
    const row = paths.get(`${id}:${file}`);
    if (!row || row.proofOnly) throw new Error(`Unretained source ${id}:${file}`);
    return row.blob === null ? null : get(row.blob, "blob").toString();
  }, has: (id, file) => paths.has(`${id}:${file}`) };
}

export function readCustody() {
  const data = readJson(new URL("custody.json.gz", base));
  if (data.contractSha256 !== sha256(readFileSync(new URL("contracts-v1.json", base)))) throw new Error("Frozen contract changed");
  const rows = data.partitions.flatMap(part => {
    if (!/^git-\d+\.json\.gz$/.test(part.file)) throw new Error("Unsafe Git partition");
    const file = new URL(part.file, base), bytes = readFileSync(file);
    if (bytes.length !== part.bytes || sha256(bytes) !== part.sha256) throw new Error("Git partition custody mismatch");
    return readJson(file);
  });
  return validateCustody(data, rows);
}

export function verifyLock() {
  const lock = readJson(new URL("instrument-lock.json", base));
  if (lock.schemaVersion !== 1 || lock.kind !== "native-go-quality-closure" || !Array.isArray(lock.files)) throw new Error("Invalid closure lock");
  const names = new Set();
  for (const row of lock.files) {
    if (typeof row.file !== "string" || row.file.startsWith("/") || row.file.split("/").some(p => !p || p === "." || p === "..") || names.has(row.file)) throw new Error("Unsafe/repeated closure path");
    names.add(row.file);
    const bytes = readFileSync(new URL(row.file, base));
    if (bytes.length !== row.bytes || sha256(bytes) !== row.sha256 || bytes.length > 256 * 1024) throw new Error(`Closure custody mismatch: ${row.file}`);
  }
  return lock;
}
