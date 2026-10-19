import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { apiOriginals, gitId, readJson, writeJson } from "../docs/operational-value/proof/native-go-quality/custody.mjs";

const dir = "docs/operational-value/proof/native-go-quality";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const discovery = JSON.parse(gunzipSync(readFileSync(`${dir}/discovery.json.gz`)));
mkdirSync(`${dir}/api`, { recursive: true });
function acquire(name, endpoint, query) {
  const file = `${dir}/api/${name}.json.gz`;
  if (existsSync(file)) {
    const original = readJson(file);
    const bytes = Buffer.from(original.contentBase64, "base64");
    if (original.sha256 !== hash(bytes) || original.bytes !== bytes.length
      || original.endpoint !== endpoint || original.query !== (query ?? null)) throw new Error("Original response mismatch");
    return JSON.parse(bytes);
  }
  const result = spawnSync("gh", ["api", endpoint, ...(query ? ["-f", `query=${query}`] : [])], {
    maxBuffer: 16 * 1024 * 1024, timeout: 120000, stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  const bytes = result.stdout;
  const body = JSON.parse(bytes);
  if (result.status !== 0 && !body.errors?.every(error => error.type === "NOT_FOUND")) {
    throw new Error(`Acquisition failed: ${result.stderr.toString()}`);
  }
  if (body.errors) console.error(`Retaining explicit unavailable identities: ${JSON.stringify(body.errors)}`);
  writeJson(file, { endpoint, query: query ?? null, observedAt: new Date().toISOString(),
    exitStatus: result.status, bytes: bytes.length, sha256: hash(bytes), contentBase64: bytes.toString("base64") });
  return body;
}
const metadata = acquire("repository", "repos/github/gh-aw");
if (metadata.id !== 1036865607 || metadata.private !== false || metadata.visibility !== "public"
  || metadata.full_name !== "github/gh-aw") throw new Error("Public authority mismatch");
if (process.argv.includes("--pattern-search")) {
  const q = 'repo:github/gh-aw is:issue created:<2026-10-18 "ast-grep" in:title';
  const result = acquire("pattern-search", `search/issues?q=${encodeURIComponent(q)}&per_page=100`);
  if (result.incomplete_results || result.total_count > 100) throw new Error("Unexhausted pattern search");
  for (const issue of result.items) acquire(`pattern-issue-${issue.number}`, `repos/github/gh-aw/issues/${issue.number}`);
  console.log(JSON.stringify({ query: q, issues: result.items.map(row => row.number) }));
  process.exit(0);
}
if (process.argv.includes("--standards")) {
  const custody = readJson(`${dir}/custody.json.gz`);
  const objects = custody.partitions.flatMap(part => readJson(`${dir}/${part.file}`));
  const row = custody.paths.find(row => row.commit === "c5f36dd7a6c6309dead5ba037920324d08419ca5" && row.path === "go.mod");
  if (!row) throw new Error("Missing target dependency pins");
  const mod = Buffer.from(objects.find(object => object.id === row.blob).contentBase64, "base64").toString();
  for (const [repo, module, files] of [
    ["spf13/cobra", "github.com/spf13/cobra", ["command.go"]],
    ["spf13/pflag", "github.com/spf13/pflag", ["flag.go"]],
    ["stretchr/testify", "github.com/stretchr/testify", ["require/require.go", "assert/assertions.go"]],
  ]) {
    const version = mod.match(new RegExp(`^\\s*${module.replaceAll(".", "\\.")} (v[^\\s]+)`, "m"))?.[1];
    if (!version) throw new Error(`Missing actual pin ${module}`);
    const metadata = acquire(`standard-${repo.replace("/", "-")}`, `repos/${repo}`);
    if (metadata.private !== false || metadata.visibility !== "public" || metadata.full_name.toLowerCase() !== repo.toLowerCase()) throw new Error("Dependency public authority");
    for (const file of files) acquire(`standard-${repo.split("/")[1]}-${file.replaceAll("/", "-")}`, `repos/${repo}/contents/${file}?ref=${version}`);
    console.log(repo, version);
  }
  process.exit(0);
}
if (process.argv.includes("--blobs")) {
  const custody = JSON.parse(gunzipSync(readFileSync(`${dir}/custody.json.gz`)));
  const missing = [...new Set(custody.missing.filter(row => row.type === "blob").map(row => row.id))];
  for (let start = 0; start < missing.length; start += 10) {
    const batch = missing.slice(start, start + 10);
    const fields = batch.map(id => `b${id}:object(oid:"${id}"){... on Blob{oid byteSize isBinary text}}`).join("\n");
    acquire(`blobs-${batch[0]}`, "graphql", `query{repository(owner:"github",name:"gh-aw"){id ${fields}}}`);
  }
  for (const original of apiOriginals().filter(row => row.file.startsWith("blobs-"))) {
    for (const blob of Object.values(original.body.data.repository).filter(value => value?.oid)) {
      const bytes = Buffer.from(blob.text ?? "");
      if (bytes.length === blob.byteSize && gitId("blob", bytes) === blob.oid) continue;
      const exact = acquire(`blob-${blob.oid}`, `repos/github/gh-aw/git/blobs/${blob.oid}`);
      const decoded = Buffer.from(exact.content, "base64");
      if (exact.encoding !== "base64" || decoded.length !== exact.size || gitId("blob", decoded) !== blob.oid) throw new Error("Non-lossless REST blob");
    }
  }
  console.log(JSON.stringify({ requestedImmutableBlobs: missing.length }));
  process.exit(0);
}
const issues = discovery.direct["daily-testify-uber-super-expert"].map(row => row.number);
const pulls = discovery.direct["go-logger"].filter(row => row.mergedAt).map(row => row.number);
const pr = "number url body mergedAt mergeCommit { oid } baseRefOid headRefOid files(first:100) { totalCount pageInfo { hasNextPage } nodes { path } }";
const issueField = n => `i${n}:issue(number:${n}){number url body state timelineItems(first:100,itemTypes:[CROSS_REFERENCED_EVENT,CONNECTED_EVENT]){pageInfo{hasNextPage endCursor} nodes{__typename ... on CrossReferencedEvent{createdAt source{__typename ... on PullRequest{${pr}}}} ... on ConnectedEvent{createdAt subject{__typename ... on PullRequest{${pr}}}}}}}`;
if (process.argv.includes("--pattern-graph")) {
  acquire("pattern-graph", "graphql", `query{repository(owner:"github",name:"gh-aw"){id ${issueField(4145)}}}`);
  process.exit(0);
}
for (let start = 0; start < issues.length; start += 10) {
  const numbers = issues.slice(start, start + 10);
  const fields = numbers.map(issueField).join("\n");
  acquire(`issues-${start}`, "graphql", `query{repository(owner:"github",name:"gh-aw"){id ${fields}}}`);
}
for (let start = 0; start < pulls.length; start += 20) {
  const fields = pulls.slice(start, start + 20).map(n => `p${n}:pullRequest(number:${n}){${pr}}`).join("\n");
  acquire(`pulls-${start}`, "graphql", `query{repository(owner:"github",name:"gh-aw"){id ${fields}}}`);
}
console.log(JSON.stringify({ issues: issues.length, mergedLoggerPulls: pulls.length, acquisition: "Exact public originals retained; graph edges are corroboration, not acceptance." }));
