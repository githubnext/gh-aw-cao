import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { brotliCompressSync, constants } from "node:zlib";
import { cutoff, gitId, parseTree, repository, repositoryId, revision, sha256, validateCustody } from "./custody.mjs";

// Explicit local originals only. No refs, configuration, HEAD or network mutation.
const [cache, planFile, output] = process.argv.slice(2);
if (!cache || !planFile || !output) throw new Error("usage: preserve-cache.mjs BARE_CACHE PLAN.json OUTPUT.json.br");
const plan = JSON.parse(readFileSync(planFile));
const objects = new Map(), paths = [], missing = [];
const git = args => execFileSync("git", [`--git-dir=${cache}`, ...args], {
  env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
  stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024,
});
const retain = (id, type) => {
  if (!/^[a-f0-9]{40}$/.test(id)) throw new Error("Explicit immutable Git object required");
  if (objects.has(id)) return Buffer.from(objects.get(id).contentBase64, "base64");
  const bytes = git(["cat-file", type, id]);
  if (gitId(type, bytes) !== id) throw new Error("Cache returned wrong Git object");
  objects.set(id, { type, id, bytes: bytes.length, sha256: sha256(bytes), contentBase64: bytes.toString("base64") });
  return bytes;
};
for (const row of plan.paths) {
  const prior = new Set(objects.keys());
  try {
    const header = retain(row.commit, "commit").toString("utf8").split("\n\n")[0];
    let tree = header.match(/^tree ([a-f0-9]{40})$/m)[1];
    const components = row.path.split("/");
    if (components.some(p => !p || p === "." || p === "..")) throw new Error("Unsafe requested path");
    let blob = null;
    for (let index = 0; index < components.length; index++) {
      const entry = parseTree(retain(tree, "tree")).get(components[index]);
      if (!entry) break;
      if (index === components.length - 1) {
        if (!["100644", "100755"].includes(entry.mode)) throw new Error("Requested path is not a regular blob");
        if (!row.proofOnly) retain(entry.id, "blob");
        blob = entry.id;
      } else {
        if (entry.mode !== "40000") throw new Error("Requested ancestor is not a tree");
        tree = entry.id;
      }
    }
    paths.push({ ...row, blob });
  } catch (error) {
    if (!error.stderr || !/missing|bad (?:object|file)|not a valid|could not|unable to read/i.test(error.stderr.toString())) throw error;
    missing.push({ ...row, reason: "Required Git object unavailable with lazy fetching disabled; not absent or exhausted history." });
    for (const id of objects.keys()) if (!prior.has(id)) objects.delete(id);
  }
}
const archive = { schemaVersion: 1, repository, repositoryId, revision, cutoff,
  objects: [...objects.values()], paths, missing };
validateCustody(archive);
const compressed = brotliCompressSync(Buffer.from(`${JSON.stringify(archive)}\n`),
  { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24 } });
writeFileSync(output, compressed);
console.log(JSON.stringify({ output, bytes: compressed.length, sha256: sha256(compressed),
  objects: objects.size, paths: paths.length, missing }, null, 2));
