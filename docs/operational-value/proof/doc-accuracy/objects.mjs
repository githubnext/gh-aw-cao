import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const gitId = (type, bytes) => createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
export const base = path.dirname(fileURLToPath(import.meta.url));
export const readJson = file => JSON.parse(readFileSync(file, "utf8"));
export const contract = readJson(path.join(base, "contract-v1.json"));
export const iso = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace(".000Z", "Z") === value;

export function verifyCompiler(directory = base) {
  const lock = readJson(path.join(directory, "compiler-lock.json"));
  for (const entry of lock.files) {
    if (typeof entry.path !== "string" || entry.path.startsWith("/")
      || entry.path.split("/").some(segment => !segment || segment === "." || segment === "..")) {
      throw new Error("Unsafe compiler lock path");
    }
    const bytes = readFileSync(path.join(directory, entry.path));
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      throw new Error(`Frozen compiler/source mutation: ${entry.path}`);
    }
  }
  return lock;
}

export function archive(directory = base) {
  const manifest = readJson(path.join(directory, "originals.json"));
  const objects = new Map();
  for (const entry of manifest.objects) {
    if (!/^[a-f0-9]{40}$/.test(entry.oid) || !["blob", "tree", "commit"].includes(entry.type)) {
      throw new Error("Invalid original object identity");
    }
    const chunks = entry.parts.map(part => {
      if (!/^[a-f0-9]{40}\.\d+\.gz$/.test(part.file)) throw new Error("Unsafe original path");
      const bytes = readFileSync(path.join(directory, "originals", part.file));
      if (sha256(bytes) !== part.sha256 || bytes.length !== part.bytes) throw new Error("Original custody mismatch");
      return gunzipSync(bytes);
    });
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256 || gitId(entry.type, bytes) !== entry.oid) {
      throw new Error("Original Git object mismatch");
    }
    if (objects.has(entry.oid)) throw new Error("Duplicate original");
    objects.set(entry.oid, { type: entry.type, bytes });
  }
  const object = (oid, type) => {
    const value = objects.get(oid);
    if (!value || value.type !== type) throw new Error(`Missing ${type} original ${oid}`);
    return value.bytes;
  };
  const tree = oid => {
    const bytes = object(oid, "tree"), entries = [];
    let offset = 0;
    while (offset < bytes.length) {
      const space = bytes.indexOf(32, offset), end = bytes.indexOf(0, space);
      if (space < 0 || end < 0 || end + 21 > bytes.length) throw new Error("Malformed original tree");
      entries.push({ mode: bytes.subarray(offset, space).toString(), name: bytes.subarray(space + 1, end).toString(),
        oid: bytes.subarray(end + 1, end + 21).toString("hex") });
      offset = end + 21;
    }
    return entries;
  };
  const commit = oid => {
    const raw = object(oid, "commit").toString("utf8"), header = raw.split("\n\n")[0];
    const root = /^tree ([a-f0-9]{40})$/m.exec(header)?.[1];
    const parents = [...header.matchAll(/^parent ([a-f0-9]{40})$/gm)].map(match => match[1]);
    const seconds = /^committer .* ([0-9]+) [+-][0-9]{4}$/m.exec(header)?.[1];
    if (!root || !seconds) throw new Error("Malformed original commit");
    return { oid, tree: root, parents, at: new Date(Number(seconds) * 1000).toISOString().replace(".000Z", "Z") };
  };
  const resolve = (commitId, file) => {
    if (typeof file !== "string" || file.startsWith("/") || file.split("/").some(p => !p || p === "." || p === "..")) {
      throw new Error("Unsafe repository path");
    }
    const segments = file.split("/");
    let oid = commit(commitId).tree;
    for (let i = 0; i < segments.length; i++) {
      const entry = tree(oid).find(e => e.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) return entry;
      if (entry.mode !== "40000") return null;
      oid = entry.oid;
    }
    return null;
  };
  const text = (commitId, file) => {
    const entry = resolve(commitId, file);
    if (!entry) return null;
    if (!["100644", "100755"].includes(entry.mode)) throw new Error("Non-regular evidence path");
    return object(entry.oid, "blob").toString("utf8");
  };
  return { manifest, object, tree, commit, resolve, text };
}
