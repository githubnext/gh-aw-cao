import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const directory = "docs/operational-value/proof/mcp-auth-native";
const contract = JSON.parse(readFileSync(`${directory}/contract.json`));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const receipts = [], cache = new Map();
const archive = path.join(directory, "originals.json.gz");
const limits = { maxDecodedBytes: 32 * 1024 * 1024, maxParts: 256 };
const contractSha256 = hash(readFileSync(`${directory}/contract.json`));
mkdirSync(directory, { recursive: true });
if (existsSync(archive)) {
  const previous = readJsonArchive(archive, limits);
  if (previous.contractSha256 !== contractSha256) throw new Error("Original acquisition contract changed");
  for (const receipt of previous.receipts) {
    const bytes = Buffer.from(receipt.bodyBase64, "base64");
    if (hash(bytes) !== receipt.sha256 || bytes.length !== receipt.bytes || cache.has(receipt.endpoint)) {
      throw new Error("Original acquisition checkpoint changed");
    }
    cache.set(receipt.endpoint, bytes);
    receipts.push(receipt);
  }
}
function acquire(endpoint) {
  if (cache.has(endpoint)) return cache.get(endpoint);
  const bytes = execFileSync("gh", ["api", ...(endpoint.endsWith("/logs") ? ["--allow-escape-sequences"] : []), endpoint],
    { maxBuffer: 32 * 1024 * 1024 });
  const receipt = { endpoint, observedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    bytes: bytes.length, sha256: hash(bytes), bodyBase64: bytes.toString("base64") };
  receipts.push(receipt);
  cache.set(endpoint, bytes);
  writeJsonArchive(archive, { schemaVersion: 1, contractSha256, receipts }, limits);
  return bytes;
}
const json = endpoint => JSON.parse(acquire(endpoint));
const prefix = `repos/${contract.repository}`;
const repository = json(prefix);
if (repository.id !== contract.repositoryId || repository.full_name !== contract.repository
  || repository.private !== false || repository.visibility !== "public") throw new Error("Public repository authority mismatch");
const frozen = `${prefix}/contents/.github/workflows/${contract.workflow}.md?ref=${contract.revision}`;
json(frozen);
const introduction = json(`${prefix}/git/commits/b68086a128bfe94b7d17d08821167f4915f123c4`);
if (introduction.parents?.length !== 1) throw new Error("Unexpected source introduction parents");
for (const sha of [introduction.sha, introduction.parents[0].sha]) {
  const commit = json(`${prefix}/git/commits/${sha}`);
  json(`${prefix}/git/trees/${commit.tree.sha}?recursive=1`);
}
for (const id of contract.selection.runIds) {
  const run = json(`${prefix}/actions/runs/${id}/attempts/1`);
  if (run.id !== id || run.run_attempt !== 1 || run.repository?.id !== contract.repositoryId
    || run.path !== `.github/workflows/${contract.workflow}.lock.yml`
    || !/^[a-f0-9]{40}$/.test(run.head_sha)) throw new Error("Run identity mismatch");
  const jobs = json(`${prefix}/actions/runs/${id}/attempts/1/jobs?per_page=100`);
  if (jobs.total_count !== jobs.jobs?.length) throw new Error("Incomplete original job page");
  const selected = jobs.jobs.filter(job => job.name === contract.selection.jobName);
  if (selected.length !== 1) throw new Error("Raw canary job missing or ambiguous");
  acquire(`${prefix}/actions/jobs/${selected[0].id}/logs`);
  for (const extension of ["md", "lock.yml"]) {
    json(`${prefix}/contents/.github/workflows/${contract.workflow}.${extension}?ref=${run.head_sha}`);
  }
}
console.log(JSON.stringify({ receipts: receipts.length, rawBytes: receipts.reduce((sum, row) => sum + row.bytes, 0) }));
