import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { writeCensusEvidence } from "./operational-value-census-io.mjs";

const execute = promisify(execFile);
export const repository = "github/gh-aw";
export const revision = "d3915e4a21040c00a6e11e1acb0aac42605abc4c";
export const historicalRevisions = [
  ["2026-09-19T10:16:09Z", "00457477720387bcc7d7baaf841dedb22ad06617"],
  ["2026-09-26T10:16:09Z", "4740543b75dfeb74d973b194163c83f22c7936e9"],
  ["2026-10-03T10:16:09Z", "306bc6bdf8df80f039c69df518a2dc4b73a0f544"],
  ["2026-10-10T10:16:09Z", "595e115b17a9378895d4a37298f60f91f64719ad"],
  ["2026-10-17T10:16:09Z", revision],
];
const hash = value => createHash("sha256").update(value).digest("hex");
const workflowPath = file => /^\.github\/workflows\/[^/]+\.(md|ya?ml)$/.test(file);
const git = (checkout, args) => execFileSync("git", ["-C", checkout, ...args], {
  encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
});
const firstParent = (checkout, commit) => {
  const match = git(checkout, ["cat-file", "-p", commit]).match(/^parent ([a-f0-9]{40})$/m);
  if (!match) throw new Error(`No first parent for ${commit}`);
  return match[1];
};

export function treeEntries(checkout, commit) {
  return git(checkout, ["ls-tree", "-r", "-z", commit, "--", ".github/workflows"]).split("\0")
    .filter(Boolean).map(entry => {
      const [metadata, file] = entry.split("\t");
      const [, type, blob] = metadata.split(" ");
      return { path: file, type, blob };
    }).filter(entry => entry.type === "blob");
}

export function lockPairGuard(changedPaths, presentPaths) {
  const changed = new Set(changedPaths);
  const present = new Set(presentPaths);
  const eligible = changedPaths.filter(file => workflowPath(file) && file.endsWith(".md") && present.has(file));
  const violations = eligible.filter(file => {
    const lock = file.replace(/\.md$/, ".lock.yml");
    return !present.has(lock) || !changed.has(lock);
  });
  return { eligibleCount: eligible.length, count: violations.length, eligible, violations };
}

export function parseGoTestEvidence(text) {
  const tests = new Map();
  const packages = new Map();
  for (const line of text.split("\n").filter(Boolean)) {
    const event = JSON.parse(line);
    if (typeof event.Package !== "string" || typeof event.Action !== "string") {
      throw new Error("Malformed Go test event");
    }
    if (!event.Test) {
      if (event.Action === "start") packages.set(event.Package, "running");
      else if (["pass", "fail", "skip"].includes(event.Action)) packages.set(event.Package, event.Action);
    } else if (!event.Test.includes("/")) {
      const id = `${event.Package}:${event.Test}`;
      if (event.Action === "run") {
        if (tests.has(id)) throw new Error(`Repeated top-level test execution: ${id}`);
        tests.set(id, { id, status: "running" });
      } else if (["pass", "fail", "skip"].includes(event.Action)) {
        if (!tests.has(id) || tests.get(id).status !== "running") throw new Error(`Unmatched terminal test event: ${id}`);
        tests.set(id, { id, status: event.Action });
      }
    }
  }
  const testOutcomes = [...tests.values()].sort((left, right) => left.id.localeCompare(right.id));
  const unfinishedPackages = [...packages.values()].filter(status => status === "running").length;
  const unfinishedTests = testOutcomes.filter(test => test.status === "running").length;
  const missingReason = !packages.size || !tests.size || unfinishedPackages || unfinishedTests
    ? `Incomplete or empty Go test population: ${packages.size} packages, ${tests.size} tests, `
      + `${unfinishedPackages} unfinished packages, ${unfinishedTests} unfinished tests.`
    : [...packages.values()].includes("fail") && !testOutcomes.some(test => test.status === "fail")
      ? "Package failed without a counted terminal failing test." : null;
  return { testOutcomes, packages: Object.fromEntries([...packages.entries()].sort()),
    coverageStatus: missingReason ? "partial" : "complete", missingReason,
    eligibleCount: testOutcomes.filter(test => test.status !== "skip").length,
    failedCount: testOutcomes.filter(test => test.status === "fail").length,
    skippedCount: testOutcomes.filter(test => test.status === "skip").length };
}

async function readTestArtifact(artifact) {
  if (artifact.expired || artifact.size_in_bytes > 8 * 1024 * 1024) {
    throw new Error("Test artifact expired or exceeds the 8 MiB compressed acquisition bound");
  }
  const endpoint = `repos/${repository}/actions/artifacts/${artifact.id}/zip`;
  const { stdout: archive } = await execute("gh", ["api", endpoint], {
    encoding: "buffer", maxBuffer: 8 * 1024 * 1024, timeout: 60_000,
  });
  const archiveSha256 = hash(archive);
  if (artifact.digest && artifact.digest !== `sha256:${archiveSha256}`) {
    throw new Error("Downloaded artifact digest differs from GitHub's immutable digest");
  }
  const temporary = mkdtempSync(path.join(path.resolve(".tmp"), "gh-aw-test-evidence-"));
  try {
    const zip = path.join(temporary, "test-results.zip");
    writeFileSync(zip, archive);
    const names = (await execute("unzip", ["-Z1", zip], { encoding: "utf8" })).stdout.trim().split("\n");
    if (names.length !== 1 || !/^[a-zA-Z0-9_.-]+\.json$/.test(names[0])) {
      throw new Error("Expected exactly one safe-named Go test JSON entry");
    }
    const { stdout } = await execute("unzip", ["-p", zip, names[0]], {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60_000,
    });
    return { artifactId: artifact.id, artifactName: artifact.name, endpoint, archiveSha256,
      sourceSha256: hash(stdout), ...parseGoTestEvidence(stdout) };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function collectGoUnitEvidence() {
  const expected = ["a-c", "d-g", "h-m", "n-r", "s-z"].map(group => `test-result-cgo-unit-${group}`);
  const observations = [];
  for (const [windowEnd] of historicalRevisions) {
    const endpoint = `repos/${repository}/actions/workflows/cgo.yml/runs?per_page=1&branch=main&status=completed`
      + `&created=${encodeURIComponent(`<=${windowEnd}`)}`;
    try {
      const runs = await api(endpoint);
      const run = runs.workflow_runs?.[0];
      if (!run) {
        observations.push({ windowEnd, status: "missing", endpoint, reason: "No matching Go unit-test execution." });
        continue;
      }
      if (Date.parse(run.updated_at) >= Date.parse(windowEnd)) {
        observations.push({ windowEnd, status: "missing", endpoint, runId: run.id,
          reason: "Latest selected execution has no established terminal assessment before the cutoff." });
        continue;
      }
      const artifactsEndpoint = `repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`;
      const artifacts = await api(artifactsEndpoint);
      if (!Array.isArray(artifacts.artifacts) || artifacts.total_count > artifacts.artifacts.length) {
        throw new Error("Incomplete Go test artifact inventory");
      }
      const selected = expected.map(name => artifacts.artifacts.find(artifact => artifact.name === name));
      const missing = expected.filter((name, index) => !selected[index] || selected[index].expired);
      if (missing.length) {
        observations.push({ windowEnd, status: "missing", endpoint, artifactsEndpoint, runId: run.id,
          runCreatedAt: run.created_at, headSha: run.head_sha,
          reason: `The complete frozen five-shard unit-test evidence is unavailable: ${missing.join(", ")}` });
        continue;
      }
      const shards = [];
      for (const artifact of selected) shards.push(await readTestArtifact(artifact));
      const incomplete = shards.filter(shard => shard.coverageStatus !== "complete");
      observations.push({ windowEnd, status: incomplete.length ? "partial" : "available", endpoint, artifactsEndpoint,
        runId: run.id, runCreatedAt: run.created_at, runUpdatedAt: run.updated_at, headSha: run.head_sha,
        reason: incomplete.length ? incomplete.map(shard => `${shard.artifactName}: ${shard.missingReason}`).join(" ") : null,
        expectedShards: expected, shards });
    } catch (error) {
      observations.push({ windowEnd, status: "error", endpoint,
        reason: String(error.stderr || error.message).slice(0, 500) });
    }
  }
  return observations;
}

export function collectGitSnapshots(checkout) {
  return historicalRevisions.map(([windowEnd, commit]) => {
    const parent = firstParent(checkout, commit);
    const paths = treeEntries(checkout, commit).map(entry => entry.path);
    const changed = git(checkout, ["diff-tree", "--no-commit-id", "--no-renames", "--name-only", "-r",
      parent, commit, "--", ".github/workflows"]).trim().split("\n").filter(Boolean);
    return {
      windowEnd, commit, parent,
      commitAt: git(checkout, ["show", "-s", "--format=%cI", commit]).trim(),
      presentWorkflowPaths: paths.filter(file => workflowPath(file) && !file.endsWith(".lock.yml")),
      presentLockPaths: paths.filter(file => file.endsWith(".lock.yml")),
      guard: lockPairGuard(changed, paths),
      changedPaths: changed,
      provenance: [{ repository, kind: "git-first-parent-tree-difference",
        ref: `${parent}..${commit}` }],
    };
  });
}

export function prepareGitSnapshots(checkout) {
  git(checkout, ["fetch", "--quiet", "--depth=1", "origin", ...historicalRevisions.map(([, commit]) => commit)]);
  const parents = historicalRevisions.map(([, commit]) => firstParent(checkout, commit));
  git(checkout, ["fetch", "--quiet", "--depth=1", "origin", ...parents]);
  return collectGitSnapshots(checkout);
}

async function api(endpoint) {
  const { stdout } = await execute("gh", ["api", endpoint], {
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 60_000,
  });
  return JSON.parse(stdout);
}

export async function collectRunInventory(files, cutoff) {
  const results = Array(files.length);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const index = next++;
      const file = files[index];
      const runtimePath = file.endsWith(".md") ? file.replace(/\.md$/, ".lock.yml") : file;
      const endpoint = `repos/${repository}/actions/workflows/${encodeURIComponent(path.basename(runtimePath))}/runs`
        + `?per_page=1&branch=main&status=completed&created=${encodeURIComponent(`<=${cutoff}`)}`;
      try {
        const runs = await api(endpoint);
        if (!Array.isArray(runs.workflow_runs)) throw new Error("Workflow-runs response has no inventory");
        const run = runs.workflow_runs[0];
        if (!run) {
          results[index] = { path: file, status: "no-matching-run", endpoint };
          continue;
        }
        const artifactsEndpoint = `repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`;
        const record = {
          path: file, status: "available", endpoint,
          run: { id: run.id, headSha: run.head_sha, createdAt: run.created_at, updatedAt: run.updated_at,
            conclusionObservedAtCollection: run.conclusion, url: run.html_url },
        };
        results[index] = record;
        try {
          const artifacts = await api(artifactsEndpoint);
          if (!Array.isArray(artifacts.artifacts)) throw new Error("Artifacts response has no inventory");
          record.artifacts = {
            status: "available", endpoint: artifactsEndpoint, total: artifacts.total_count,
            complete: artifacts.total_count <= artifacts.artifacts.length,
            items: artifacts.artifacts.map(artifact => ({
              id: artifact.id, name: artifact.name, expired: artifact.expired,
              sizeBytes: artifact.size_in_bytes, digest: artifact.digest ?? null,
            })),
          };
        } catch (error) {
          record.artifacts = { status: "error", endpoint: artifactsEndpoint,
            error: String(error.stderr || error.message).slice(0, 500) };
        }
      } catch (error) {
        results[index] = { path: file, status: "error", endpoint,
          error: String(error.stderr || error.message).slice(0, 500) };
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return results;
}

export async function collectEvidence(checkout) {
  if (git(checkout, ["rev-parse", "HEAD"]).trim() !== revision) {
    throw new Error("Checkout must be at the pinned census revision");
  }
  if (git(checkout, ["status", "--porcelain"]).trim()) throw new Error("Pinned source checkout must be clean");
  const entries = treeEntries(checkout, revision)
    .filter(entry => workflowPath(entry.path) && !entry.path.endsWith(".lock.yml"));
  const sources = entries.map(entry => ({
    path: entry.path, gitBlob: entry.blob,
    sha256: hash(readFileSync(path.join(checkout, entry.path))),
    kind: entry.path.endsWith(".md") ? "agentic" : "native",
  })).sort((left, right) => left.path.localeCompare(right.path));
  const snapshots = prepareGitSnapshots(checkout);
  const capturedAt = new Date().toISOString();
  const runInventory = await collectRunInventory(sources.map(source => source.path), "2026-10-17T10:16:09Z");
  const goUnitEvidence = await collectGoUnitEvidence();
  return {
    schemaVersion: 1, repository, revision, capturedAt, completedAt: new Date().toISOString(),
    scope: "Top-level .github/workflows/*.{md,yml,yaml}; generated *.lock.yml excluded as duplicate executions.",
    historicalSelection: "Latest ancestor commit before each of five fixed weekly cutoffs, resolved through the commit API.",
    runInventoryLimit: "One latest completed main-branch run created before 2026-10-17T10:16:09Z per source; at most 100 artifact metadata records per run.",
    runInventoryCaveat: "Conclusions are observed at collection, not reconstructed historical outcome evidence. Artifact metadata does not validate its contents.",
    sources, snapshots, runInventory, goUnitEvidence,
    probes: [{
      endpoint: `repos/${repository}/actions/artifacts?per_page=1`,
      status: "error", httpStatus: 500,
      limitation: "Repeated global artifact-list failures; per-run artifact inventories were used instead.",
    }],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [checkout, output] = process.argv.slice(2);
  if (!checkout || !output || process.argv.length !== 4) {
    throw new Error("usage: node scripts/collect-gh-aw-operational-evidence.mjs CHECKOUT OUTPUT.json");
  }
  const result = await collectEvidence(path.resolve(checkout));
  writeCensusEvidence(output, result);
  console.log(JSON.stringify({
    sources: result.sources.length, snapshots: result.snapshots.length,
    availableRunInventories: result.runInventory.filter(row => row.status === "available").length,
    runInventoryErrors: result.runInventory.filter(row => row.status === "error").length,
    lockGuard: result.snapshots.map(({ windowEnd, guard }) => ({ windowEnd, ...guard })),
  }, null, 2));
}
