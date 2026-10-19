import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { readJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { objectBytes, treeEntries, validateCustody } from "../native-go-quality/custody.mjs";
import { sha256 } from "./native.mjs";

export const base = new URL("./", import.meta.url);
export const repository = "github/gh-aw";
export const cutoff = "2026-10-18T15:00:12Z";
export const read = file => readJsonArchive(file instanceof URL ? file.pathname : file, { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 });

export function verifyLock(expected) {
  const file = new URL("instrument-lock.json", base), bytes = readFileSync(file);
  if (sha256(bytes) !== expected) throw new Error("Frozen interpreter lock changed");
  const lock = JSON.parse(bytes);
  if (lock.kind !== "native-code-debt-closure" || !Array.isArray(lock.files)) throw new Error("Invalid interpreter lock");
  const names = new Set();
  for (const row of lock.files) {
    if (typeof row.path !== "string" || row.path.startsWith("/") || row.path.split("/").some(x => !x || x === "." || x === "..")
      || names.has(row.path)) throw new Error("Unsafe or repeated interpreter path");
    names.add(row.path);
    const bytes = readFileSync(new URL(`../../../../${row.path}`, base));
    if (bytes.length !== row.bytes || bytes.length > 256 * 1024 || sha256(bytes) !== row.sha256) throw new Error(`Frozen interpreter changed: ${row.path}`);
  }
  return lock;
}

export function originals() {
  return readdirSync(new URL("api", base)).filter(file => file.endsWith(".json.gz") && !/-part-\d{3}\.json\.gz$/.test(file)).map(file => {
    const envelope = read(new URL(`api/${file}`, base)), bytes = Buffer.from(envelope.contentBase64, "base64");
    if (bytes.toString("base64") !== envelope.contentBase64 || bytes.length !== envelope.bytes || sha256(bytes) !== envelope.sha256) throw new Error("API original custody mismatch");
    return { file, envelope, body: JSON.parse(bytes) };
  });
}

export function sourceCustody() {
  const data = read(new URL("custody.json.gz", base)), objects = read(new URL("objects.json.gz", base));
  const custody = validateCustody(data, objects);
  const byId = new Map(objects.map(row => [row.id, row]));
  function universe(commit) {
    const rows = [];
    function walk(tree, prefix) {
      const object = byId.get(tree);
      if (object?.type !== "tree") throw new Error("Incomplete tree universe");
      for (const [name, entry] of treeEntries(objectBytes(object))) {
        const file = `${prefix}${name}`;
        if (entry.mode === "40000") walk(entry.id, `${file}/`);
        else if (/\.(?:go|s|S|c|h|syso|o|a|so|ll|wasm)$/.test(file)) {
          if (!["100644", "100755"].includes(entry.mode) || !custody.has(commit, file)) throw new Error("Incomplete or opaque native universe");
          rows.push({ path: file, blob: entry.id, text: custody.source(commit, file) });
        }
      }
    }
    walk(custody.commit(commit).tree, "");
    return rows;
  }
  return { ...custody, universe };
}

export function packageFiles(rows, file) {
  const directory = path.posix.dirname(file);
  return rows.filter(row => path.posix.dirname(row.path) === directory && row.path.endsWith(".go"));
}
