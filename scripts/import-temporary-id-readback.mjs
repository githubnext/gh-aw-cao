import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { readTemporaryId, temporaryIdDirectory as directory } from "./native-temporary-id-value.mjs";

const [manifestFile, requestsFile] = process.argv.slice(2);
if (!manifestFile || !requestsFile) throw new Error("Usage: import-temporary-id-readback.mjs <provider-manifest.json> <requested-scopes.json>");
const provider = readTemporaryId(manifestFile);
const requested = readTemporaryId(requestsFile);
const contract = readTemporaryId(`${directory}/contract.json`);
if (provider.repository !== contract.repository || provider.repositoryId !== contract.repositoryId
  || requested.repository !== contract.repository || requested.sourceRevision !== contract.sourceRevision
  || requested.cutoff !== contract.until) throw new Error("Public readback has the wrong repository, revision or cutoff");
const endpoints = new Set(["repos/github/gh-aw", "graphql",
  "repos/github/gh-aw/issues/comments/5486743629",
  "repos/github/gh-aw/issues/comments/5518452885",
  "repos/github/gh-aw/issues/comments/5548053158"]);
const responses = provider.requests.filter(row => endpoints.has(row.endpoint)).map(row => {
  const bytes = readFileSync(row.file);
  if (row.status !== 200 || createHash("sha256").update(bytes).digest("hex") !== row.sha256
    || bytes.length !== row.bytes || !Number.isFinite(Date.parse(row.acquiredAt))) throw new Error("Invalid coordinated response identity");
  return { endpoint: row.endpoint, method: row.method, status: row.status, acquiredAt: row.acquiredAt,
    startedAt: row.startedAt, headers: row.headers, query: row.query, sha256: row.sha256,
    bytes: row.bytes, original: bytes.toString("base64") };
});
if (responses.length !== endpoints.size || new Set(responses.map(row => row.endpoint)).size !== endpoints.size) {
  throw new Error("The exact coordinated public read set is incomplete");
}
const decode = row => JSON.parse(Buffer.from(row.original, "base64"));
const repository = decode(responses.find(row => row.endpoint === "repos/github/gh-aw"));
if (repository.id !== contract.repositoryId || repository.full_name !== contract.repository || repository.private !== false) {
  throw new Error("Coordinated target is not the assigned public repository");
}
const graphql = responses.find(row => row.endpoint === "graphql");
const graph = decode(graphql);
if (graph.errors || graph.data?.repository?.databaseId !== contract.repositoryId) throw new Error("Coordinated GraphQL read failed");
const numbers = requested.issues.map(row => row.number);
if (Object.keys(graph.data.repository).filter(key => key !== "databaseId").length !== numbers.length) {
  throw new Error("Coordinated graph read has unexpected target scopes");
}
function validateRelated(value) {
  if (!value || typeof value !== "object") return;
  if (value.repository && (value.repository.databaseId !== contract.repositoryId || value.repository.isPrivate !== false)) {
    throw new Error("Unexpected cross-repository or private issue relationship; no wider target was fetched");
  }
  for (const nested of Object.values(value)) validateRelated(nested);
}
const issues = numbers.map(number => {
  const issue = graph.data.repository[`i${number}`];
  if (!issue || issue.number !== number || typeof issue.id !== "string" || typeof issue.body !== "string") {
    throw new Error(`Unacquired mapped public issue ${number}`);
  }
  validateRelated(issue);
  if (issue.timelineItems.pageInfo.hasNextPage || issue.timelineItems.totalCount !== issue.timelineItems.nodes.length
    || issue.subIssues.pageInfo.hasNextPage || issue.subIssues.totalCount !== issue.subIssues.nodes.length) {
    throw new Error(`Unacquired graph pagination remains for public issue ${number}`);
  }
  return issue;
});
for (const response of responses.filter(row => row.endpoint.includes("/issues/comments/"))) {
  const comment = decode(response);
  const id = Number(response.endpoint.split("/").at(-1));
  if (comment.id !== id || !/^https:\/\/api\.github\.com\/repos\/github\/gh-aw\/issues\/[0-9]+$/.test(comment.issue_url)
    || typeof comment.body !== "string" || !comment.body.trim()) throw new Error("Invalid independent public comment readback");
}
writeFileSync(`${directory}/supplemental-readback.json.gz`, gzipSync(JSON.stringify({
  repository: contract.repository, repositoryId: contract.repositoryId,
  sourceRevision: contract.sourceRevision, cutoff: contract.until, requested, responses,
})));
writeFileSync(`${directory}/github-graph-008.json.gz`, gzipSync(JSON.stringify({
  observedAt: graphql.acquiredAt, responseDigest: graphql.sha256, issues,
})));
console.log(JSON.stringify({ publicResponses: responses.length, mappedIssues: issues.length, comments: responses.length - 2,
  networkRequests: 0 }));
