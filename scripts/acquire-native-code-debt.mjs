import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const root = "docs/operational-value/proof/native-code-debt";
mkdirSync(`${root}/api`, { recursive: true });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function acquire(name, endpoint, query) {
  const file = `${root}/api/${name}.json.gz`;
  if (existsSync(file)) {
    const row = readJsonArchive(file);
    const bytes = Buffer.from(row.contentBase64, "base64");
    if (row.endpoint !== endpoint || row.query !== (query ?? null) || row.sha256 !== hash(bytes) || row.bytes !== bytes.length) throw new Error("Original mismatch");
    return JSON.parse(bytes);
  }
  const result = spawnSync("gh", ["api", endpoint, ...(query ? ["-f", `query=${query}`] : [])], { timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.toString());
  const bytes = result.stdout, body = JSON.parse(bytes);
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  writeJsonArchive(file, { endpoint, query: query ?? null, observedAt: new Date().toISOString(), bytes: bytes.length,
    sha256: hash(bytes), contentBase64: bytes.toString("base64") });
  return body;
}
const metadata = acquire("repository", "repos/github/gh-aw");
if (metadata.id !== 1036865607 || metadata.private !== false || metadata.visibility !== "public" || metadata.full_name !== "github/gh-aw") throw new Error("Public authority mismatch");
if (process.argv.includes("--selected-run")) {
  const run = acquire("selected-run-24439426053", "repos/github/gh-aw/actions/runs/24439426053");
  if (run.repository.id !== metadata.id || run.id !== 24439426053 || run.path !== ".github/workflows/code-simplifier.lock.yml") throw new Error("Selected run identity mismatch");
  console.log(JSON.stringify({ id: run.id, head: run.head_sha, createdAt: run.created_at, path: run.path }));
  process.exit(0);
}
const { index, entities } = readOutputHistory("docs/operational-value/gh-aw-workflows/evidence");
const keys = ["daily-code-debt-aider", "code-simplifier"];
const direct = Object.fromEntries(keys.map(key => [key, entities.filter(row => row.workflowReference?.workflowId === key)]));
const census = readJsonArchive("docs/operational-value/gh-aw-census/contracts.json.gz");
writeJsonArchive(`${root}/discovery.json.gz`, { index: { totalEntities: index.totalEntities, partitions: index.partitions.length,
  until: index.until, repository: index.repository }, direct, originalCensus: census.contracts.filter(row => keys.some(key => row.path.endsWith(`/${key}.md`))),
  contractSha256: hash(readFileSync(`${root}/contract-v1.json`)) });
const fields = "number url body createdAt mergedAt mergeCommit{oid} baseRefOid headRefOid files(first:100){totalCount pageInfo{hasNextPage} nodes{path}}";
const issueFields = `number url body timelineItems(first:100,itemTypes:[CROSS_REFERENCED_EVENT,CONNECTED_EVENT]){
  pageInfo{hasNextPage}
  nodes{
    __typename
    ... on CrossReferencedEvent{createdAt source{__typename ... on PullRequest{${fields}}}}
    ... on ConnectedEvent{createdAt subject{__typename ... on PullRequest{${fields}}}}
  }
}`;
for (const key of keys) {
  const rows = direct[key];
  for (let start = 0; start < rows.length; start += 10) {
    const batch = rows.slice(start, start + 10);
    const selections = batch.map(row => row.kind === "PullRequest" ? `n${row.number}:pullRequest(number:${row.number}){${fields}}`
      : `n${row.number}:issue(number:${row.number}){${issueFields}}`).join("\n");
    const body = acquire(`${key}-${start}`, "graphql", `query{repository(owner:"github",name:"gh-aw"){id ${selections}}}`);
    for (const row of Object.values(body.data.repository)) {
      if (row?.timelineItems?.pageInfo.hasNextPage || row?.files?.pageInfo.hasNextPage) throw new Error("Incomplete bounded graph/files; preserve original and extend explicitly");
    }
  }
}
console.log(JSON.stringify({ candidates: Object.fromEntries(keys.map(key => [key, direct[key].length])), status: "discovery only" }));
