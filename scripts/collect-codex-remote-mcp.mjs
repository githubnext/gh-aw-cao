import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const root = "docs/operational-value/proof/codex-remote-mcp";
const contractBytes = readFileSync(`${root}/contract.json`);
const contract = JSON.parse(contractBytes);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const contractSha256 = hash(contractBytes), file = `${root}/originals.json.gz`;
const limits = { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 };
const packet = existsSync(file) ? readJsonArchive(file, limits) : { schemaVersion: 1, contractSha256, receipts: [] };
if (packet.contractSha256 !== contractSha256) throw new Error("Codex MCP acquisition contract changed");
const cache = new Map();
for (const row of packet.receipts) {
  const bytes = Buffer.from(row.bodyBase64, "base64");
  if (hash(bytes) !== row.sha256 || bytes.length !== row.bytes || cache.has(row.endpoint)) throw new Error("Original Codex MCP receipt changed");
  cache.set(row.endpoint, row);
}
function acquire(endpoint) {
  if (cache.has(endpoint)) return cache.get(endpoint);
  if (packet.receipts.length >= contract.selection.requestBudget) throw new Error("Codex MCP request budget exhausted");
  const result = spawnSync("gh", ["api", ...(endpoint.endsWith("/logs") ? ["--allow-escape-sequences"] : []), endpoint],
    { maxBuffer: 16 * 1024 * 1024, timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  let status = 200;
  if (result.status !== 0) {
    const failure = JSON.parse(result.stdout);
    status = Number(failure.status);
    if (![404, 410].includes(status)) throw new Error(`Unexpected Codex MCP acquisition failure: ${result.stderr}`);
  }
  const bytes = result.stdout;
  const receipt = { endpoint, status, observedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    bytes: bytes.length, sha256: hash(bytes), bodyBase64: bytes.toString("base64") };
  packet.receipts.push(receipt);
  cache.set(endpoint, receipt);
  writeJsonArchive(file, packet, limits);
  return receipt;
}
function json(endpoint) {
  const receipt = acquire(endpoint);
  if (receipt.status !== 200) throw new Error(`Required Codex MCP metadata unavailable: ${endpoint}`);
  return JSON.parse(Buffer.from(receipt.bodyBase64, "base64"));
}
const prefix = `repos/${contract.repository}`;
const repository = json(prefix);
if (repository.id !== contract.repositoryId || repository.private !== false || repository.visibility !== "public"
  || repository.full_name !== contract.repository) throw new Error("Public Codex MCP repository authority changed");
const inventoryEndpoint = `${prefix}/actions/workflows/${contract.workflow}.lock.yml/runs?per_page=100&created=%3C2026-10-18T15%3A00%3A12Z`;
const inventory = json(inventoryEndpoint);
if (inventory.total_count !== inventory.workflow_runs.length
  || JSON.stringify(inventory.workflow_runs.map(run => run.id)) !== JSON.stringify(contract.selection.runIds)) {
  throw new Error("Complete frozen Codex MCP opportunity population changed");
}
json(`${prefix}/contents/.github/workflows/${contract.workflow}.md?ref=${contract.revision}`);
const sourceHistory = json(`${prefix}/commits?path=.github/workflows/${contract.workflow}.md&sha=${contract.revision}&per_page=100`);
if (!sourceHistory.length || sourceHistory.length >= 100) throw new Error("Incomplete Codex MCP source history");
const introduction = json(`${prefix}/git/commits/${sourceHistory.at(-1).sha}`);
if (introduction.parents?.length !== 1) throw new Error("Ambiguous Codex MCP introduction parent");
const previous = json(`${prefix}/git/commits/${introduction.parents[0].sha}`);
for (const commit of [introduction, previous]) json(`${prefix}/git/trees/${commit.tree.sha}?recursive=1`);
for (const id of contract.selection.runIds) {
  const run = json(`${prefix}/actions/runs/${id}/attempts/1`);
  if (run.id !== id || run.run_attempt !== 1 || run.repository?.id !== contract.repositoryId
    || run.path !== `.github/workflows/${contract.workflow}.lock.yml` || run.created_at >= contract.cutoff
    || !/^[a-f0-9]{40}$/.test(run.head_sha)) throw new Error("Codex MCP run identity mismatch");
  for (const extension of ["md", "lock.yml"]) {
    acquire(`${prefix}/contents/.github/workflows/${contract.workflow}.${extension}?ref=${run.head_sha}`);
  }
  const jobs = json(`${prefix}/actions/runs/${id}/attempts/1/jobs?per_page=100`);
  if (jobs.total_count !== jobs.jobs.length) throw new Error("Incomplete original Codex MCP job page");
  for (const job of jobs.jobs.filter(job => job.name === "agent")) {
    if (job.run_id !== id || job.run_attempt !== 1) throw new Error("Codex MCP job/attempt identity mismatch");
    acquire(`${prefix}/actions/jobs/${job.id}/logs`);
  }
  const artifacts = json(`${prefix}/actions/runs/${id}/artifacts?per_page=100`);
  if (artifacts.total_count !== artifacts.artifacts.length) throw new Error("Incomplete Codex MCP artifact page");
  for (const artifact of artifacts.artifacts.filter(row => row.name === "agent" && !row.expired)) {
    if (artifact.workflow_run?.id !== id || artifact.size_in_bytes > 8 * 1024 * 1024) throw new Error("Codex MCP agent artifact outside scope/budget");
    acquire(`${prefix}/actions/artifacts/${artifact.id}/zip`);
  }
}
console.log(JSON.stringify({ receipts: packet.receipts.length,
  unavailable: packet.receipts.filter(row => row.status !== 200).map(row => ({ endpoint: row.endpoint, status: row.status })) }));
