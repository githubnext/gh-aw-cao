import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";

const execute = promisify(execFile);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export const lockfileStatsDirectory = "docs/operational-value/proof/lockfile-stats";

export async function acquireLockfileStats(cache) {
  const contract = readCensusJson(`${lockfileStatsDirectory}/contract.json`);
  mkdirSync(cache, { recursive: true });
  let calls = 0;
  const api = async endpoint => {
    const file = path.join(cache, `${digest(endpoint)}.json`);
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    if (++calls > 1800) throw new Error("Lockfile-statistics bounded acquisition exhausted; resume the same cache.");
    const { stdout } = await execute("gh", ["api", endpoint], {
      timeout: 90000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PAGER: "cat" },
    });
    const result = JSON.parse(stdout);
    writeFileSync(file, JSON.stringify(result));
    return result;
  };
  const repository = await api("repos/github/gh-aw");
  if (repository.id !== contract.repositoryId || repository.full_name !== contract.repository) throw new Error("Repository identity mismatch");
  const runs = [];
  let expected;
  for (let page = 1; ; page++) {
    const response = await api(`repos/github/gh-aw/actions/workflows/lockfile-stats.lock.yml/runs?per_page=100&page=${page}&created=${encodeURIComponent(`<=${contract.until}`)}`);
    if (!Number.isSafeInteger(response.total_count) || response.total_count > 1000 || !Array.isArray(response.workflow_runs)) {
      throw new Error("Run discovery exceeds the frozen bounded interface; partition time before resuming.");
    }
    expected ??= response.total_count;
    if (response.total_count !== expected) throw new Error("Run inventory changed during acquisition");
    runs.push(...response.workflow_runs.map(run => ({
      id: run.id, head_sha: run.head_sha, run_attempt: run.run_attempt, event: run.event,
      created_at: run.created_at, path: run.path, repositoryId: run.repository.id,
      headRepositoryId: run.head_repository?.id ?? null, head_branch: run.head_branch,
    })));
    if (runs.length === expected) break;
    if (!response.workflow_runs.length || runs.length > expected) throw new Error("Incomplete run pagination");
  }
  if (new Set(runs.map(run => run.id)).size !== runs.length) throw new Error("Duplicate original runs");
  const observations = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < runs.length) {
      const run = runs[cursor++];
      if (!Number.isSafeInteger(run.id) || run.repositoryId !== contract.repositoryId
        || !/^[a-f0-9]{40}$/.test(run.head_sha) || run.created_at > contract.until) throw new Error("Invalid execution identity");
      const artifacts = [];
      for (let page = 1; ; page++) {
        const response = await api(`repos/github/gh-aw/actions/runs/${run.id}/artifacts?per_page=100&page=${page}`);
        if (!Number.isSafeInteger(response.total_count) || !Array.isArray(response.artifacts)) throw new Error("Invalid artifact inventory");
        artifacts.push(...response.artifacts.map(row => ({
          id: row.id, name: row.name, expired: row.expired, size_in_bytes: row.size_in_bytes,
          digest: row.digest, created_at: row.created_at, workflow_run: row.workflow_run,
        })));
        if (artifacts.length === response.total_count) break;
        if (!response.artifacts.length || artifacts.length > response.total_count) throw new Error("Incomplete artifact pagination");
      }
      const row = { ...run, artifacts };
      observations.push(row);
      if (observations.length % 50 === 0) console.error(`Inventoried ${observations.length}/${runs.length} runs`);
    }
  }));
  observations.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  writeCensusJson(`${lockfileStatsDirectory}/inventory.json.gz`, observations);
  const index = { schemaVersion: 1, complete: true, contractSha256: censusDigest(contract),
    until: contract.until, runs: observations.length, inventorySha256: censusDigest(observations),
    artifacts: observations.reduce((sum, row) => sum + row.artifacts.length, 0),
    survivingCacheArtifacts: observations.flatMap(row => row.artifacts).filter(row => row.name === "cache-memory" && !row.expired).length };
  writeCensusJson(`${lockfileStatsDirectory}/inventory-index.json`, index);
  return { api, index, observations };
}

export function downloadLockfileArtifact(artifact, cache) {
  if (!Number.isSafeInteger(artifact.id) || artifact.id <= 0 || artifact.expired || artifact.size_in_bytes > 16 * 1024 * 1024) {
    throw new Error("Unavailable or over-budget lockfile artifact");
  }
  const file = path.join(cache, `${artifact.id}.zip`);
  if (!existsSync(file)) {
    const bytes = execFileSync("gh", ["api", `repos/github/gh-aw/actions/artifacts/${artifact.id}/zip`], {
      timeout: 90000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    writeFileSync(file, bytes);
  }
  const bytes = readFileSync(file);
  if (artifact.digest && artifact.digest !== `sha256:${digest(bytes)}`) throw new Error("Provider artifact digest mismatch");
  return { file, sha256: digest(bytes) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify((await acquireLockfileStats(process.argv[2] ?? ".cao-lockfile-stats-cache/api")).index));
}
