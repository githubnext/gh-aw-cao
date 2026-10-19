import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readOutputHistory } from "../../../../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { digest } from "./native-oracle.mjs";

export const custodyDirectory = path.dirname(fileURLToPath(import.meta.url));
const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

export function readCustody(directory = custodyDirectory) {
  const bytes = readFileSync(path.join(directory, "custody.json"));
  const archive = JSON.parse(bytes);
  if (archive.schemaVersion !== 1 || archive.repository !== "github/gh-aw" || archive.repositoryId !== 1036865607
    || archive.revision !== "c86377ec47b38f0b5af463277ee55d1d03d08da8"
    || archive.cutoff !== "2026-10-18T15:00:12Z") throw new Error("Custody scope mismatch");
  const objects = new Map();
  function readPart(part) {
    if (!/^(?:originals\/[a-f0-9]{40}-\d{3}\.bin|discovery\/(?:history|entities-\d{5,})\.json\.gz|provider\/[\w.-]+)$/.test(part.path)) throw new Error("Unsafe custody path");
    const filename = path.join(directory, part.path);
    if (!lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink()) throw new Error("Nonregular original");
    const value = readFileSync(filename);
    if (value.length > 262144 || value.length !== part.bytes || digest(value) !== part.sha256) throw new Error("Original integrity mismatch");
    return value;
  }
  for (const [oid, entry] of Object.entries(archive.objects)) {
    if (!sha(oid) || !["blob", "tree", "commit"].includes(entry.type) || !Array.isArray(entry.parts)
      || entry.parts.length === 0) throw new Error("Invalid Git custody entry");
    const value = Buffer.concat(entry.parts.map(readPart));
    if (value.length !== entry.bytes
      || createHash("sha1").update(`${entry.type} ${value.length}\0`).update(value).digest("hex") !== oid) throw new Error("Git original identity mismatch");
    objects.set(oid, { type: entry.type, bytes: value });
  }
  for (const part of archive.discovery.files) readPart(part);
  for (const part of archive.provider ?? []) readPart(part);
  const discovery = readOutputHistory(path.join(directory, "discovery"));
  if (!discovery.index.complete || discovery.index.repositoryId !== archive.repositoryId
    || discovery.index.sourceRevision !== archive.revision || discovery.index.until !== archive.cutoff
    || discovery.entities.length !== 58048 || discovery.index.partitions.length !== 346) throw new Error("Discovery scope mismatch");
  function object(oid, type) {
    if (!sha(oid)) throw new Error("Invalid Git reference");
    const value = objects.get(oid);
    if (!value) return null;
    if (value.type !== type) throw new Error("Git original type mismatch");
    return value.bytes;
  }
  function resolve(commit, filename) {
    if (!sha(commit) || typeof filename !== "string" || filename.startsWith("/") || filename.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Unsafe source reference");
    const value = object(commit, "commit");
    if (!value) return { status: "missing", missingObject: commit };
    let oid = /^tree ([a-f0-9]{40})$/m.exec(value.toString())?.[1];
    for (const [index, segment] of filename.split("/").entries()) {
      const tree = object(oid, "tree");
      if (!tree) return { status: "missing", missingObject: oid };
      let offset = 0, match;
      while (offset < tree.length) {
        const space = tree.indexOf(32, offset), nul = tree.indexOf(0, space);
        if (space < offset || nul < space || nul + 21 > tree.length) throw new Error("Malformed original tree");
        if (tree.subarray(space + 1, nul).toString() === segment) match = {
          mode: tree.subarray(offset, space).toString(), oid: tree.subarray(nul + 1, nul + 21).toString("hex"),
        };
        offset = nul + 21;
      }
      if (!match) return { status: "absent", bytes: null };
      const last = index === filename.split("/").length - 1;
      if (!last && match.mode !== "40000" || last && !["100644", "100755"].includes(match.mode)) throw new Error("Unsupported original file mode");
      oid = match.oid;
    }
    const content = object(oid, "blob");
    return content ? { status: "present", blob: oid, bytes: content } : { status: "missing", missingObject: oid };
  }
  for (const record of archive.paths) {
    if (!record.commit || !record.path) continue;
    const actual = resolve(record.commit, record.path);
    if (record.status !== actual.status || record.blob && record.blob !== actual.blob
      || record.missingObject && record.missingObject !== actual.missingObject) throw new Error("Source path proof mismatch");
  }
  return { archive, discovery, objects, object, resolve, sha256: digest(bytes) };
}

export function commitFacts(custody, oid) {
  const bytes = custody.object(oid, "commit");
  if (!bytes) return null;
  const text = bytes.toString(), parent = /^parent ([a-f0-9]{40})$/m.exec(text)?.[1];
  const epoch = /^committer .* ([0-9]+) [+-]\d{4}$/m.exec(text)?.[1];
  if (!epoch) throw new Error("Malformed original commit clock");
  const timestamp = new Date(Number(epoch) * 1000).toISOString().replace(".000Z", "Z");
  if (Date.parse(timestamp) >= Date.parse(custody.archive.cutoff)) throw new Error("Post-cutoff native commit");
  return { commit: oid, parent: parent ?? null, timestamp };
}
