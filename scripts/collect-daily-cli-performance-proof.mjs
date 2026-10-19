#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";

export const scope = Object.freeze({
  repository: "github/gh-aw",
  repositoryId: 1036865607,
  revision: "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  cutoff: "2026-10-18T15:00:12Z",
  workflow: "daily-cli-performance",
  sourceBlob: "3c67fd8d57eeefa431030bc9c2c8e21618536f6e",
});

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const sourcePaths = [
  ".github/workflows/daily-cli-performance.md",
  ".github/workflows/daily-cli-performance.lock.yml",
  "pkg/workflow/compiler_performance_benchmark_test.go",
  "Makefile",
  "go.mod",
  ".github/workflows/ci.yml",
  ".github/workflows/cgo.yml",
  ".github/workflows/shared/mcp-pagination.md",
  ".github/workflows/shared/daily-audit-base.md",
  ".github/workflows/shared/daily-audit-discussion.md",
  ".github/workflows/shared/reporting.md",
  ".github/workflows/shared/go-make.md",
  ".github/workflows/shared/otlp.md",
  ".github/shared-instructions.md",
];
const adoption = "aa41ba8d8621fec20a40cece3832886dea3a6c98";
const parent = "1267f50853b056ed76611d77deffcbbf9b393c67";

export function readOfflineBlob(cache, revision, file, suppliedDirectory) {
  const git = args => execFileSync("git", [`--git-dir=${cache}`, ...args], {
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    timeout: 45000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  if (!/^[a-f0-9]{40}$/.test(revision) || !/^[\w./-]+$/.test(file)
    || file.startsWith("/") || file.split("/").some(part => ["", ".", ".."].includes(part))) {
    throw new Error("Invalid immutable source reference");
  }
  const tree = git(["ls-tree", revision, "--", file]).toString().trim();
  if (!tree) return { revision, path: file, status: "absent" };
  const entry = /^100644 blob ([a-f0-9]{40})\t(.+)$/.exec(tree);
  if (!entry || entry[2] !== file) throw new Error("Unsupported immutable source mode");
  const blob = entry[1];
  let bytes;
  try {
    const directories = Array.isArray(suppliedDirectory) ? suppliedDirectory : suppliedDirectory ? [suppliedDirectory] : [];
    const supplied = directories.map(directory => path.join(directory, `${blob}.blob`)).find(existsSync);
    bytes = supplied ? readFileSync(supplied) : git(["cat-file", "blob", blob]);
  } catch (error) {
    const missing = error.code === "ENOENT" || error.status === 128
      && /bad file|Not a valid object name|could not get object info/.test(String(error.stderr));
    if (!missing) throw error;
    return { revision, path: file, blob, status: "unavailable-offline",
      neededEndpoint: `repos/${scope.repository}/git/blobs/${blob}` };
  }
  if (bytes.length > 4 * 1024 * 1024
    || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== blob) {
    throw new Error("Immutable source blob identity mismatch");
  }
  return { revision, path: file, blob, status: "available", sha256: sha256(bytes),
    encoding: "base64", content: bytes.toString("base64") };
}

export function selectLineage(entities) {
  const direct = entities.filter(row => row.workflowReference?.workflowId === scope.workflow
    || row.workflowReference?.trackerId === scope.workflow);
  const selected = new Set(direct.map(row => row.number));
  const byNumber = new Map(entities.map(row => [row.number, row]));
  const neighbors = new Map();
  for (const row of entities) {
    for (const number of row.relatedCandidates) {
      if (!Number.isSafeInteger(number) || number < 1) throw new Error("Invalid candidate identity");
      for (const [from, to] of [[row.number, number], [number, row.number]]) {
        if (!neighbors.has(from)) neighbors.set(from, new Set());
        neighbors.get(from).add(to);
      }
    }
  }
  const queue = [...selected];
  for (let index = 0; index < queue.length; index += 1) {
    for (const next of neighbors.get(queue[index]) ?? []) {
      if (!selected.has(next)) { selected.add(next); queue.push(next); }
    }
  }
  const missing = [...selected].filter(number => !byNumber.has(number)).sort((a, b) => a - b);
  return { direct, closure: entities.filter(row => selected.has(row.number)), missing };
}

export function collectProof({ cache, history, output, suppliedDirectory }) {
  const { index, entities } = readOutputHistory(history);
  if (index.repository !== scope.repository || index.repositoryId !== scope.repositoryId
    || index.sourceRevision !== scope.revision || index.until !== scope.cutoff) {
    throw new Error("Output history scope mismatch");
  }
  const inventory = index.workflows.find(row => row.id === scope.workflow);
  if (inventory?.gitBlob !== scope.sourceBlob) throw new Error("Frozen workflow source mismatch");
  const sources = [
    ...sourcePaths.map(file => readOfflineBlob(cache, scope.revision, file, suppliedDirectory)),
    ...[adoption, parent].map(revision =>
      readOfflineBlob(cache, revision, sourcePaths[0], suppliedDirectory)),
    ...["pkg/workflow/compiler_performance_benchmark_test.go", "Makefile",
      ".github/workflows/shared/reporting.md", ".github/workflows/daily-cli-performance.lock.yml"]
      .map(file => readOfflineBlob(cache, adoption, file, suppliedDirectory)),
  ];
  const lineage = selectLineage(entities);
  const runs = [...new Set(lineage.direct.flatMap(row => [
    row.workflowReference.runId, ...row.workflowReference.additionalRunReferences.map(ref => ref.runId),
  ]).filter(Boolean))].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
  const census = readCensusJson("docs/operational-value/gh-aw-census/evidence.json.gz");
  const runInventory = census.runInventory.filter(row => row.path === inventory.path);
  const directories = Array.isArray(suppliedDirectory) ? suppliedDirectory : suppliedDirectory ? [suppliedDirectory] : [];
  const sourceAcquisitionReceipts = directories.flatMap(directory =>
    JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8")).receipts
      .filter(row => sources.some(source => source.blob === row.sha)).map(receipt => {
        const payload = readFileSync(path.join(directory, `${receipt.sha}.response.json`));
        const response = JSON.parse(payload);
        const bytes = Buffer.from(response.content, "base64");
        const source = sources.find(row => row.blob === receipt.sha);
        if (response.sha !== receipt.sha || response.encoding !== "base64"
          || response.size !== bytes.length || sha256(bytes) !== receipt.sha256
          || bytes.length !== receipt.bytes || source.content !== bytes.toString("base64")) {
          throw new Error("Provider source receipt digest mismatch");
        }
        return { ...receipt, digestAppliesTo: "decoded Git blob",
          providerPayloadSha256: sha256(payload), payloadEncoding: "base64", payload: payload.toString("base64") };
      }));
  const proof = {
    schemaVersion: 1, scope, adoption: { commit: adoption, parent },
    sources,
    sourceAcquisitionReceipts,
    history: { index, direct: lineage.direct, closure: lineage.closure,
      missingCandidateNumbers: lineage.missing,
      limitations: [
        "Editable output markers and body references are discovery candidates, not creation receipts or accepted graph edges.",
        "Terminal issue/PR state was observed after the cutoff and is not backdated.",
        "Comments, Discussions, deleted/transferred identities, edited-away markers and unmarked contributions remain outside retained inventory.",
      ] },
    runInventory,
    nativeEvidence: [],
    coverage: {
      retainedInventoryComplete: index.complete === true,
      directEntities: lineage.direct.length,
      candidateClosureEntities: lineage.closure.length,
      distinctReferencedRuns: runs.length,
      benchmarkResults: "not-acquired",
      protectedChecks: "not-acquired",
      comparableHardwareProfiles: "not-acquired",
      workflowContribution: "unknown",
    },
    acquisitionNeeds: [
      ...sources.filter(row => row.neededEndpoint).map(row => ({
        endpoint: row.neededEndpoint, purpose: `Read frozen source ${row.path} at ${row.revision}`,
      })),
      {
        endpoint: `repos/${scope.repository}/actions/workflows/cgo.yml/runs?branch=main&created=%3C${encodeURIComponent(scope.cutoff)}&per_page=100`,
        purpose: "Enumerate independent protected benchmark producers through the full frozen scope; partition date ranges at provider caps, exhaust every partition",
      },
      {
        endpoint: `repos/${scope.repository}/actions/artifacts?name=benchmark-results&per_page=100`,
        purpose: "Find independently produced original bench_results.txt payloads and provider digests; bind runs before cutoff, exhaust pagination, record expiry",
      },
      {
        endpoint: `repos/${scope.repository}/actions/workflows/daily-cli-performance.lock.yml/runs?created=${encodeURIComponent("2025-12-31T17:50:25Z")}..${encodeURIComponent(scope.cutoff)}&per_page=100`,
        purpose: "Discover all original executions, including no-output runs; partition bounded date ranges at provider caps and reconcile against the 121 retained referenced run IDs",
      },
      ...runs.flatMap(run => [
        { endpoint: `repos/${scope.repository}/actions/runs/${run}`,
          purpose: "Bind original workflow/head/run identity; success is not latency evidence" },
        { endpoint: `repos/${scope.repository}/actions/runs/${run}/artifacts?per_page=100`,
          purpose: "Discover original raw benchmark reports, if any; exhaust pagination" },
        { endpoint: `repos/${scope.repository}/actions/runs/${run}/jobs?per_page=100`,
          purpose: "Discover independent protected benchmark/correctness producers; exhaust pagination" },
        { endpoint: `repos/${scope.repository}/actions/runs/${run}/logs`,
          purpose: "Discover original host-captured raw benchmark/compile command results and toolchain/runner context; do not accept agent prose or execute archive contents" },
      ]),
      ...runInventory.flatMap(row => row.run?.headSha ? [
        { endpoint: `repos/${scope.repository}/commits/${row.run.headSha}/check-runs?per_page=100`,
          purpose: "Discover immutable-head independent fixture/correctness result producers; exhaust pagination, job success alone is not acceptance" },
        { endpoint: `repos/${scope.repository}/commits/${row.run.headSha}/status?per_page=100`,
          purpose: "Discover legacy required correctness contexts at the actual benchmark head; no terminal-state backdating" },
      ] : []),
      ...lineage.closure.filter(row => row.kind === "PullRequest").flatMap(row => [
        { endpoint: `repos/${scope.repository}/pulls/${row.number}`,
          purpose: "Bind merge/head/base revision and eligibility without backdating terminal state" },
        { endpoint: `repos/${scope.repository}/issues/${row.number}/timeline?per_page=100`,
          purpose: "Verify candidate graph edges and downstream contribution; exhaust pagination" },
      ]),
      ...lineage.missing.map(number => ({
        endpoint: `repos/${scope.repository}/issues/${number}`,
        purpose: "Resolve referenced identity absent from preserved inventory",
      })),
    ],
  };
  const nativeReplayFile = path.join(output, "native-replay.json.gz");
  if (existsSync(nativeReplayFile)) {
    const replay = readCensusJson(nativeReplayFile);
    if (replay.repositoryId !== scope.repositoryId || replay.sourceRevision !== scope.revision
      || replay.cutoff !== scope.cutoff || replay.acceptance.latencyValue !== null) {
      throw new Error("Native diagnostic replay scope mismatch");
    }
    proof.nativeDiagnostics = { file: "native-replay.json.gz", sha256: sha256(JSON.stringify(replay)) };
    proof.coverage.benchmarkResults = "one-original-protected-benchmark-diagnostic; accepted latency unavailable";
    proof.coverage.protectedChecks = "five original unit logs inspected; one failed shard; complete required checks unavailable";
  }
  proof.acquisitionLedger = { archives: [], completed: [], pendingPages: [], historyComplete: false };
  for (const file of ["native-discovery.json.gz", "native-receipts.json.gz"]) {
    const archived = path.join(output, file);
    if (!existsSync(archived)) continue;
    const acquired = readCensusJson(archived);
    if (acquired.repositoryId !== scope.repositoryId || acquired.revision !== scope.revision
      || acquired.cutoff !== scope.cutoff) throw new Error("Acquisition ledger scope mismatch");
    proof.acquisitionLedger.archives.push({ file, sha256: sha256(JSON.stringify(acquired)) });
    for (const receipt of acquired.receipts) {
      const body = Buffer.from(receipt.originalBody, "base64");
      if (sha256(body) !== receipt.bodySha256) throw new Error("Original acquisition body digest mismatch");
      const existing = proof.acquisitionNeeds.find(row =>
        decodeURIComponent(row.endpoint) === decodeURIComponent(receipt.endpoint));
      if (!existing) proof.acquisitionNeeds.push({ endpoint: receipt.endpoint,
        purpose: "Explicitly authorized original native benchmark/run/compile receipt, bound to discovered original head" });
      const need = existing ?? proof.acquisitionNeeds.at(-1);
      need.status = receipt.status === 200
        ? "acquired; native acceptance assessed separately" : "provider-refused-or-incomplete";
      proof.acquisitionLedger.completed.push({ endpoint: receipt.endpoint, status: receipt.status,
        receivedAt: receipt.receivedAt, bodySha256: receipt.bodySha256 });
      if (receipt.next) proof.acquisitionLedger.pendingPages.push(receipt.next);
    }
  }
  mkdirSync(output, { recursive: true });
  const destination = path.join(output, "investigation.json.gz");
  if (existsSync(destination)) {
    const previous = readCensusJson(destination);
    const { predecessors: previousReferences = [], ...previousFacts } = previous;
    if (sha256(JSON.stringify(previousFacts)) !== sha256(JSON.stringify(proof))) {
      const previousDigest = sha256(JSON.stringify(previous));
      const name = `predecessor-${previousDigest}.json.gz`;
      writeCensusJson(path.join(output, name), previous);
      proof.predecessors = [...previousReferences, { file: name, sha256: previousDigest }];
    } else if (previousReferences.length) proof.predecessors = previousReferences;
  }
  writeCensusJson(destination, proof);
  return proof;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [cache, history, output, ...suppliedDirectory] = process.argv.slice(2);
  if (!cache || !history || !output) {
    throw new Error("usage: collect-daily-cli-performance-proof.mjs GIT_CACHE HISTORY OUTPUT [SUPPLIED_BLOBS...]");
  }
  const proof = collectProof({ cache, history, output, suppliedDirectory });
  console.log(JSON.stringify({ coverage: proof.coverage,
    availableSources: proof.sources.filter(row => row.status === "available").length,
    acquisitionNeeds: proof.acquisitionNeeds.length }));
}
