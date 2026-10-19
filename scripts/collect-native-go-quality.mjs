import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { apiOriginals } from "../docs/operational-value/proof/native-go-quality/custody.mjs";

const dir = "docs/operational-value/proof/native-go-quality";
const cache = process.argv[2];
if (!cache || !path.isAbsolute(cache)) throw new Error("Supply authorized read-only Git cache");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const gitId = (type, bytes) => createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
const contract = JSON.parse(readFileSync(`${dir}/contracts-v1.json`));
const names = contract.contracts.map(row => row.slug);
const git = (args, input) => execFileSync("git", [`--git-dir=${cache}`, ...args], {
  input, maxBuffer: 64 * 1024 * 1024, timeout: 60000,
  env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
  stdio: ["pipe", "pipe", "pipe"],
});
const write = (file, data) => {
  const bytes = gzipSync(JSON.stringify(data), { level: 9 });
  if (bytes.length > 256 * 1024) throw new Error(`Oversized ${file}`);
  writeFileSync(`${dir}/${file}`, bytes);
  return { file, bytes: bytes.length, sha256: hash(bytes) };
};
const { index, entities } = readOutputHistory("docs/operational-value/gh-aw-workflows/evidence");
if (!index.complete || index.repositoryId !== contract.repositoryId || index.sourceRevision !== contract.revision
  || index.until !== contract.cutoff || index.partitions.length !== 346 || entities.length !== 58048) throw new Error("Discovery scope mismatch");
mkdirSync(`${dir}/history`, { recursive: true });
for (const file of ["history.json.gz", ...index.partitions.map(row => row.file)]) {
  copyFileSync(`docs/operational-value/gh-aw-workflows/evidence/${file}`, `${dir}/history/${file}`);
}
const direct = Object.fromEntries(names.map(slug => [slug, entities.filter(row =>
  row.workflowReference?.workflowId === slug || row.unverifiedWorkflowId === slug)]));
write("discovery.json.gz", { index, direct, entityCount: entities.length,
  limits: "Issue/PR discovery only; current markers are not creation receipts. Comments, Discussions and deleted objects are outside the inventory." });

const objects = new Map(), paths = new Map(), missing = [], workflows = [];
const originals = apiOriginals();
const publicMetadata = originals.find(row => row.file === "repository.json.gz")?.body;
if (publicMetadata?.private !== false || publicMetadata?.id !== contract.repositoryId
  || publicMetadata?.visibility !== "public") throw new Error("Public API authority required");
const apiBlobs = new Map(originals.filter(row => row.file.startsWith("blobs-")).flatMap(row =>
  Object.values(row.body.data.repository).filter(value => value?.oid).map(value => [value.oid, value])));
const exactBlobs = new Map(originals.filter(row => row.file.startsWith("blob-")).map(row => [row.body.sha, row.body]));
function object(id, type) {
  if (objects.has(id)) return Buffer.from(objects.get(id).contentBase64, "base64");
  const status = git(["cat-file", "--batch-check"], `${id}\n`).toString().trim();
  if (status === `${id} missing`) {
    const blob = apiBlobs.get(id);
    const exact = exactBlobs.get(id);
    if (type === "blob" && exact) {
      const bytes = Buffer.from(exact.content, "base64");
      if (exact.encoding !== "base64" || bytes.length !== exact.size || gitId(type, bytes) !== id) throw new Error("Exact public blob identity mismatch");
      objects.set(id, { id, type, bytes: bytes.length, sha256: hash(bytes), contentBase64: bytes.toString("base64") });
      return bytes;
    }
    if (type === "blob" && blob && !blob.isBinary && typeof blob.text === "string") {
      const bytes = Buffer.from(blob.text);
      if (bytes.length !== blob.byteSize || gitId(type, bytes) !== id) throw new Error("Public blob identity mismatch");
      objects.set(id, { id, type, bytes: bytes.length, sha256: hash(bytes), contentBase64: bytes.toString("base64") });
      return bytes;
    }
    missing.push({ id, type }); return null;
  }
  if (!status.startsWith(`${id} ${type} `)) throw new Error(`Unexpected object ${status}`);
  const bytes = git(["cat-file", type, id]);
  if (gitId(type, bytes) !== id) throw new Error("Git identity mismatch");
  objects.set(id, { id, type, bytes: bytes.length, sha256: hash(bytes), contentBase64: bytes.toString("base64") });
  return bytes;
}
function file(commit, filename, proofOnly = false) {
  const key = `${commit}:${filename}`;
  if (paths.has(key) && (!paths.get(key).proofOnly || proofOnly)) return;
  const raw = object(commit, "commit");
  if (!raw) return;
  let id = raw.toString().match(/^tree ([a-f0-9]{40})$/m)[1];
  const parts = filename.split("/");
  for (let i = 0; i < parts.length; i++) {
    const bytes = object(id, "tree");
    if (!bytes) return;
    let entry;
    for (let offset = 0; offset < bytes.length;) {
      const space = bytes.indexOf(32, offset), end = bytes.indexOf(0, space);
      if (space < offset || end < space || end + 21 > bytes.length) throw new Error("Malformed tree");
      if (bytes.subarray(space + 1, end).toString() === parts[i]) entry = {
        mode: bytes.subarray(offset, space).toString(), id: bytes.subarray(end + 1, end + 21).toString("hex"),
      };
      offset = end + 21;
    }
    if (!entry) { paths.set(key, { commit, path: filename, blob: null }); return; }
    if (i < parts.length - 1 && entry.mode !== "40000") throw new Error("Non-tree path");
    if (i === parts.length - 1 && !["100644", "100755"].includes(entry.mode)) throw new Error("Non-regular source");
    id = entry.id;
  }
  if (!proofOnly && !object(id, "blob")) return;
  paths.set(key, { commit, path: filename, blob: id, ...(proofOnly ? { proofOnly: true } : {}) });
}
const imports = [
  "AGENTS.md", ".github/shared-instructions.md", "scratchpad/testing.md", "pkg/logger/logger.go",
  ".github/workflows/shared/reporting.md", ".github/workflows/shared/otlp.md",
  ".github/workflows/shared/ast-grep.md",
  ".github/workflows/shared/mcp/ast-grep.md", ".github/workflows/shared/go-source-analysis.md",
  ".github/workflows/shared/mcp/serena-go.md", ".github/workflows/shared/daily-issue-base.md",
  ".github/workflows/shared/skip-if-issue-open.md", ".github/workflows/shared/safe-output-app.md",
];
for (const slug of names) {
  const sourcePath = `.github/workflows/${slug}.md`, lockPath = `.github/workflows/${slug}.lock.yml`;
  const history = git(["log", "--format=%H", contract.revision, "--", sourcePath]).toString().trim().split("\n");
  const additions = git(["log", "--diff-filter=A", "--format=%H", contract.revision, "--", sourcePath]).toString().trim().split("\n");
  if (additions.length !== 1 || !/^[a-f0-9]{40}$/.test(additions[0])) throw new Error("Ambiguous adoption");
  const intro = additions[0], raw = object(intro, "commit");
  const parent = raw.toString().match(/^parent ([a-f0-9]{40})$/m)?.[1];
  if (!parent) throw new Error("Adoption requires actual parent");
  object(parent, "commit");
  file(parent, sourcePath); file(parent, lockPath);
  for (const revision of new Set([contract.revision, ...history])) {
    file(revision, sourcePath); file(revision, lockPath);
  }
  for (const revision of [intro, contract.revision]) for (const name of imports) file(revision, name);
  const seconds = raw.toString().split("\n\n")[0].match(/^committer .* (\d+) [+-]\d{4}$/m)[1];
  workflows.push({ slug, history, adoption: { commit: intro, parent, adoptedAt: new Date(Number(seconds) * 1000).toISOString().replace(".000Z", "Z") } });
}
const implementations = [];
const apiPulls = new Map(originals.filter(row => row.file.startsWith("pulls-")).flatMap(row =>
  Object.values(row.body.data.repository).filter(value => value?.number).map(value => [value.number, value])));
for (const row of direct["go-logger"].filter(row => row.mergedAt && row.mergedAt < contract.cutoff)) {
  const original = apiPulls.get(row.number);
  if (!original?.mergeCommit || original.mergedAt !== row.mergedAt || original.files.pageInfo.hasNextPage) throw new Error("Incomplete logger merge identity");
  const commit = original.mergeCommit.oid, raw = object(commit, "commit");
  if (!raw) {
    implementations.push({ slug: "go-logger", number: row.number, commit, mergedAt: row.mergedAt, reason: "Missing actual merge commit original" });
    continue;
  }
  if (original.mergeCommit.oid !== commit) throw new Error("API and Git merge identity disagree");
  const parent = raw.toString().match(/^parent ([a-f0-9]{40})$/m)[1];
  object(parent, "commit");
  const changed = git(["diff-tree", "--no-commit-id", "--name-only", "-r", parent, commit]).toString().trim().split("\n");
  const sources = changed.filter(name => /^pkg\/.*\.go$/.test(name) && !name.endsWith("_test.go"));
  for (const filename of [...sources, "pkg/logger/logger.go", ".github/workflows/go-logger.md"]) {
    file(parent, filename); file(commit, filename);
  }
  implementations.push({ slug: "go-logger", number: row.number, commit, parent, paths: sources, mergedAt: row.mergedAt,
    discoveryOnly: "Subject and editable marker corroborate identity, not workflow creation" });
}
const downstream = new Map();
for (const original of originals.filter(row => row.file.startsWith("issues-") || row.file === "pattern-graph.json.gz")) {
  for (const issue of Object.values(original.body.data.repository).filter(row => row?.number)) {
    if (issue.timelineItems.pageInfo.hasNextPage) throw new Error("Unexhausted issue graph");
    for (const event of issue.timelineItems.nodes) {
      const pull = event.source ?? event.subject;
      if (!pull?.mergeCommit || !pull.mergedAt || pull.mergedAt >= contract.cutoff) continue;
      if (!pull.url.startsWith("https://github.com/github/gh-aw/pull/")) throw new Error("Out-of-scope graph target");
      if (pull.files.pageInfo.hasNextPage) throw new Error("Unexhausted downstream file list");
      const current = downstream.get(pull.number) ?? { ...pull, issues: [],
        slug: original.file === "pattern-graph.json.gz" ? "go-pattern-detector" : "daily-testify-uber-super-expert" };
      current.issues.push(issue.number);
      downstream.set(pull.number, current);
    }
  }
}
for (const pull of downstream.values()) {
  const commit = pull.mergeCommit.oid, raw = object(commit, "commit");
  if (!raw) { implementations.push({ slug: pull.slug, number: pull.number, commit, issues: pull.issues, reason: "Missing commit" }); continue; }
  const parent = raw.toString().match(/^parent ([a-f0-9]{40})$/m)[1];
  object(parent, "commit");
  const sources = git(["diff-tree", "--no-commit-id", "--name-only", "-r", parent, commit]).toString().trim().split("\n").filter(name =>
    pull.slug === "go-pattern-detector" ? name.endsWith(".go") : name.endsWith("_test.go"));
  for (const filename of [...sources, `.github/workflows/${pull.slug}.md`]) {
    file(parent, filename); file(commit, filename);
  }
  if (pull.number === 28622) for (const filename of ["go.mod", "pkg/cli/health_command.go"]) {
    file(parent, filename); file(commit, filename);
  }
  implementations.push({ slug: pull.slug, number: pull.number, commit, parent,
    issues: [...new Set(pull.issues)].sort((a,b) => a-b), paths: sources, mergedAt: pull.mergedAt });
}
function partition(rows, prefix) {
  const parts = []; let batch = [], size = 0;
  for (const row of rows) {
    const n = Buffer.byteLength(JSON.stringify(row));
    if (size + n > 175000 && batch.length) { parts.push(write(`${prefix}-${parts.length + 1}.json.gz`, batch)); batch = []; size = 0; }
    batch.push(row); size += n;
  }
  if (batch.length) parts.push(write(`${prefix}-${parts.length + 1}.json.gz`, batch));
  return parts;
}
const partitions = partition([...objects.values()], "git");
write("custody.json.gz", { ...contract, contractSha256: hash(readFileSync(`${dir}/contracts-v1.json`)),
  partitions, paths: [...paths.values()], missing, workflows, implementations });
console.log(JSON.stringify({ workflows, implementations: implementations.length, objects: objects.size, paths: paths.size, missing: missing.length }));
