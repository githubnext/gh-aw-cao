import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";

const directory = "docs/operational-value/proof/lint-rule";
const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const gitHash = (type, bytes) => createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
const write = (file, value) => {
  const bytes = gzipSync(Buffer.from(JSON.stringify(value)), { level: 9, mtime: 0 });
  if (bytes.length > 256 * 1024) throw new Error(`Oversized partition: ${file}`);
  writeFileSync(path.join(directory, file), bytes);
  return { file, bytes: bytes.length, sha256: sha256(bytes) };
};

const cache = process.argv[2];
if (!cache || !path.isAbsolute(cache)) throw new Error("Supply the explicitly authorized read-only Git cache");
const git = (args, input) => execFileSync("git", [`--git-dir=${cache}`, ...args], {
  input,
  encoding: null, maxBuffer: 16 * 1024 * 1024, timeout: 30000,
  env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
  stdio: ["pipe", "pipe", "pipe"],
});
mkdirSync(directory, { recursive: true });
const original = readFileSync("docs/operational-value/proof/cohort-inputs/lint-rule.json.gz");
if (sha256(original) !== "abde598e90796f2a84cdc088960af9f1e3ea581e40cf394a453d5235d0c9fe85") throw new Error("Bootstrap mismatch");
const bootstrap = JSON.parse(gunzipSync(original));
for (const row of bootstrap.objects) {
  const bytes = Buffer.from(row.contentBase64, "base64");
  if (row.bytes !== bytes.length || row.sha256 !== sha256(bytes) || row.gitBlob !== gitHash("blob", bytes)) throw new Error("Bootstrap blob mismatch");
}
copyFileSync("docs/operational-value/proof/cohort-inputs/lint-rule.json.gz", path.join(directory, "bootstrap.json.gz"));

const { index, entities } = readOutputHistory("docs/operational-value/gh-aw-workflows/evidence");
if (index.partitions.length !== 346 || entities.length !== 58048 || !index.complete) throw new Error("Incomplete discovery");
const names = ["eslint-miner", "eslint-refiner", "linter-miner"];
const direct = Object.fromEntries(names.map(name => [name, entities.filter(row =>
  row.workflowReference?.workflowId === name || row.unverifiedWorkflowId === name)]));
const selected = new Set(Object.values(direct).flat().map(row => row.number));
let changed = true;
while (changed) {
  changed = false;
  for (const row of entities) if (selected.has(row.number) || (row.relatedCandidates ?? []).some(n => selected.has(n))) {
    for (const n of [row.number, ...(row.relatedCandidates ?? [])]) if (!selected.has(n)) { selected.add(n); changed = true; }
  }
}
const custody = path.join(directory, "history");
mkdirSync(custody, { recursive: true });
for (const file of ["history.json.gz", ...index.partitions.map(p => p.file)]) {
  const bytes = readFileSync(path.join("docs/operational-value/gh-aw-workflows/evidence", file));
  if (bytes.length > 256 * 1024) throw new Error("Oversized history original");
  copyFileSync(path.join("docs/operational-value/gh-aw-workflows/evidence", file), path.join(custody, file));
}
const discovery = { repository: bootstrap.repository, revision, cutoff: bootstrap.cutoff,
  verified: { partitions: 346, entities: 58048 }, direct,
  closureNumbers: [...selected].sort((a, b) => a - b),
  limitation: "Complete issue/PR inventory; editable markers and related references are discovery, not attribution. Discussions/comments/deletions are outside acquisition." };
const discoveryPart = write("discovery.json.gz", discovery);

const objects = new Map(), missing = [], paths = [];
function object(id, type) {
  if (objects.has(id)) return Buffer.from(objects.get(id).base64, "base64");
  const status = git(["cat-file", "--batch-check"], `${id}\n`).toString().trim();
  if (status === `${id} missing`) {
    missing.push({ id, type, reason: "Object unavailable with lazy fetching disabled; not history absence" });
    return null;
  }
  if (!status.startsWith(`${id} ${type} `)) throw new Error(`Unexpected Git object type: ${status}`);
  const bytes = git(["cat-file", type, id]);
  if (gitHash(type, bytes) !== id) throw new Error("Git object identity mismatch");
  objects.set(id, { id, type, bytes: bytes.length, sha256: sha256(bytes), base64: bytes.toString("base64") });
  return bytes;
}
function file(commit, filename) {
  const raw = object(commit, "commit");
  if (!raw) return;
  let tree = raw.toString().match(/^tree ([a-f0-9]{40})$/m)?.[1];
  const chain = [];
  for (const component of filename.split("/")) {
    if (!tree) break;
    const bytes = object(tree, "tree");
    if (!bytes) return;
    chain.push(tree);
    let cursor = 0, found;
    while (cursor < bytes.length) {
      const space = bytes.indexOf(32, cursor), nul = bytes.indexOf(0, space);
      if (space < cursor || nul < space || nul + 21 > bytes.length) throw new Error("Invalid tree");
      const mode = bytes.subarray(cursor, space).toString();
      const name = bytes.subarray(space + 1, nul).toString();
      const id = bytes.subarray(nul + 1, nul + 21).toString("hex");
      if (name === component) found = { mode, id };
      cursor = nul + 21;
    }
    if (!found) { paths.push({ commit, path: filename, status: "absent", chain }); return; }
    tree = found.id;
  }
  const bytes = object(tree, "blob");
  paths.push({ commit, path: filename, blob: tree, status: bytes ? "available" : "missing", chain });
}
const selectedCommits = [
  ["35777da04c8f5230a9627bc0ad01f8a6b98dd72c", [".github/workflows/eslint-miner.md", ".github/workflows/eslint-miner.lock.yml", ".github/workflows/eslint-refiner.md", ".github/workflows/eslint-refiner.lock.yml"]],
  ["8786ae0ab416a1fc75ba97eadaa437cf3c45d670", [".github/workflows/linter-miner.md", ".github/workflows/linter-miner.lock.yml"]],
  ["d797de6185403ecaa69801d96dc7202ae9d5e6a5", ["eslint-factory/src/rules/require-mkdirsync-try-catch.ts", "eslint-factory/eslint.config.cjs"]],
  ["246fccc2e62edb9b0cef682f03be55234217ee99", ["actions/setup/js/apply_samples.cjs", "actions/setup/js/build_checkout_manifest.cjs"]],
  ["105625bf3cecaa89a9a9dfc940e79fea25fe7634", ["eslint-factory/src/rules/require-http-response-error-listener.ts"]],
  ["afbc96f5a367761183eb0bfd7eaa4e29fcfbef8f", ["pkg/cli/upgrade_command.go", "pkg/cli/exit_code_error.go", "cmd/gh-aw/main.go"]],
  ["66a6d5ae3fd3c4995675af74b59d5d7f5c76a5fc", ["pkg/linters/osexitinlibrary/osexitinlibrary.go", "cmd/linters/main.go"]],
];
for (const [commit, filenames] of selectedCommits) {
  const raw = object(commit, "commit");
  if (!raw) continue;
  const parent = raw.toString().match(/^parent ([a-f0-9]{40})$/m)?.[1];
  if (parent) object(parent, "commit");
  for (const filename of filenames) {
    file(commit, filename);
    if (parent) file(parent, filename);
  }
}
for (const filename of [...names.map(n => `.github/workflows/${n}.md`),
  ...names.map(n => `.github/workflows/${n}.lock.yml`),
  ".github/workflows/shared/reporting.md", ".github/workflows/shared/daily-audit-base.md",
  ".github/workflows/shared/otlp.md", ".github/workflows/shared/mcp/serena-go.md",
  "eslint-factory/src/rules/require-mkdirsync-try-catch.ts",
  "eslint-factory/src/rules/require-http-response-error-listener.ts",
  "eslint-factory/src/rules/try-catch-rule-utils.ts"]) file(revision, filename);

const partitions = [];
let rows = [], size = 0;
for (const row of objects.values()) {
  const n = JSON.stringify(row).length;
  if (size + n > 180000 && rows.length) { partitions.push(write(`objects-${partitions.length + 1}.json.gz`, rows)); rows = []; size = 0; }
  rows.push(row); size += n;
}
if (rows.length) partitions.push(write(`objects-${partitions.length + 1}.json.gz`, rows));
write("custody.json.gz", { schemaVersion: 1, repository: bootstrap.repository, repositoryId: bootstrap.repositoryId,
  revision, cutoff: bootstrap.cutoff, contractSha256: sha256(readFileSync(path.join(directory, "contract.json"))),
  discovery: discoveryPart, partitions, paths, missing,
  interpretation: "Exact raw Git objects and Merkle path proofs. Original source era only; source is never executed. Missing originals are explicit, not absent history." });
console.log(JSON.stringify({ objects: objects.size, paths: paths.length, missing: missing.length,
  direct: Object.fromEntries(names.map(name => [name, direct[name].length])), closure: selected.size }));
