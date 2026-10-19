import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const gitId = (type, bytes) => createHash("sha1")
  .update(Buffer.from(`${type} ${bytes.length}\0`)).update(bytes).digest("hex");
export const repository = "github/gh-aw";
export const repositoryId = 1036865607;
export const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
export const cutoff = "2026-10-18T15:00:12Z";
export const bootstrapSha256 = "05f2735a796ac6c833ef39bbab254bc23999fd22782e792f53c9232b416b0b8e";

export function objectBytes(object) {
  if (!object || !["commit", "tree", "blob"].includes(object.type)
    || !/^[a-f0-9]{40}$/.test(object.id ?? "") || typeof object.contentBase64 !== "string") {
    throw new Error("Malformed original Git object");
  }
  const bytes = Buffer.from(object.contentBase64, "base64");
  if (bytes.toString("base64") !== object.contentBase64 || bytes.length !== object.bytes
    || sha256(bytes) !== object.sha256 || gitId(object.type, bytes) !== object.id) {
    throw new Error("Original Git object custody mismatch");
  }
  return bytes;
}

export function readBootstrap(file = new URL("../cohort-inputs/go-dependency.json.gz", import.meta.url)) {
  const compressed = readFileSync(file);
  if (sha256(compressed) !== bootstrapSha256) throw new Error("Source bootstrap compressed digest mismatch");
  const data = JSON.parse(gunzipSync(compressed, { maxOutputLength: 1024 * 1024 }));
  if (data.repository !== repository || data.repositoryId !== repositoryId || data.revision !== revision
    || data.cutoff !== cutoff || data.objects.length !== 3 || data.paths.length !== 3) {
    throw new Error("Source bootstrap scope mismatch");
  }
  const objects = new Map(data.objects.map(object => {
    const bytes = objectBytes({ ...object, type: "blob", id: object.gitBlob });
    return [object.gitBlob, bytes.toString("utf8")];
  }));
  for (const row of data.paths) if (!objects.has(row.gitBlob)) throw new Error("Missing bootstrap source");
  return { data, source: slug => {
    const row = data.paths.find(row => row.path === `.github/workflows/${slug}.md`);
    if (!row) throw new Error("Unknown bootstrap workflow");
    return objects.get(row.gitBlob);
  } };
}

export function parseTree(bytes) {
  const entries = new Map();
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset), end = bytes.indexOf(0, space + 1);
    if (space < offset || end < space || end + 21 > bytes.length) throw new Error("Malformed original Git tree");
    const mode = bytes.subarray(offset, space).toString("ascii");
    const name = bytes.subarray(space + 1, end).toString("utf8");
    if (!/^(?:40000|100644|100755|120000|160000)$/.test(mode) || !name || name.includes("/")
      || entries.has(name)) throw new Error("Unsafe or repeated original tree entry");
    entries.set(name, { mode, id: bytes.subarray(end + 1, end + 21).toString("hex") });
    offset = end + 21;
  }
  return entries;
}

export function validateCustody(archive) {
  if (archive?.schemaVersion !== 1 || archive.repository !== repository || archive.repositoryId !== repositoryId
    || archive.revision !== revision || archive.cutoff !== cutoff || !Array.isArray(archive.objects)
    || !Array.isArray(archive.paths) || !Array.isArray(archive.missing)) throw new Error("Native custody scope mismatch");
  const objects = new Map();
  for (const object of archive.objects) {
    if (objects.has(object.id)) throw new Error("Repeated original Git object");
    objects.set(object.id, { type: object.type, bytes: objectBytes(object) });
  }
  const get = (id, type) => {
    const object = objects.get(id);
    if (!object || object.type !== type) throw new Error(`Missing original ${type} ${id}`);
    return object.bytes;
  };
  const commit = id => {
    const text = get(id, "commit").toString("utf8");
    const header = text.split("\n\n")[0];
    const tree = header.match(/^tree ([a-f0-9]{40})$/m)?.[1];
    const parents = [...header.matchAll(/^parent ([a-f0-9]{40})$/gm)].map(match => match[1]);
    const seconds = header.match(/^committer .* ([0-9]+) [+-][0-9]{4}$/m)?.[1];
    if (!tree || !seconds) throw new Error("Invalid original commit header");
    return { tree, parents, at: new Date(Number(seconds) * 1000).toISOString().replace(".000Z", "Z") };
  };
  const resolve = (id, file) => {
    if (typeof file !== "string" || file.startsWith("/") || file.split("/").some(p => !p || p === "." || p === "..")) {
      throw new Error("Unsafe original source path");
    }
    let tree = commit(id).tree;
    const parts = file.split("/");
    for (let index = 0; index < parts.length; index++) {
      const entry = parseTree(get(tree, "tree")).get(parts[index]);
      if (!entry) return null;
      if (index === parts.length - 1) {
        if (!["100644", "100755"].includes(entry.mode)) throw new Error("Native source is not a regular Git blob");
        return entry.id;
      }
      if (entry.mode !== "40000") throw new Error("Native source ancestor is not a Git tree");
      tree = entry.id;
    }
    throw new Error("Empty native source path");
  };
  const paths = new Set();
  for (const row of archive.paths) {
    const key = `${row.commit}:${row.path}`;
    if (paths.has(key)) throw new Error("Repeated source path proof");
    paths.add(key);
    if (resolve(row.commit, row.path) !== row.blob) throw new Error("Commit/tree/path proof mismatch");
    if (row.blob !== null && row.proofOnly !== true) get(row.blob, "blob");
  }
  return {
    archive, commit, resolve,
    source(id, file) {
      if (!paths.has(`${id}:${file}`)) throw new Error(`Unretained source path ${id}:${file}`);
      if (archive.paths.find(row => row.commit === id && row.path === file)?.proofOnly) {
        throw new Error(`Only path identity retained, not source bytes: ${id}:${file}`);
      }
      const blob = resolve(id, file);
      return blob === null ? null : get(blob, "blob").toString("utf8");
    },
    bytes: get,
  };
}

export function readCustody(file, expectedSha256) {
  const compressed = readFileSync(file);
  if (sha256(compressed) !== expectedSha256) throw new Error("Native custody archive compressed digest mismatch");
  return validateCustody(JSON.parse(brotliDecompressSync(compressed, { maxOutputLength: 48 * 1024 * 1024 })));
}
