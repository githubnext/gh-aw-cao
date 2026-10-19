import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { joinPurelockCoverage, parsePurelockCoverage, scorePurelock } from "../../scripts/native-purelock-value.mjs";
import { purelockJob, purelockLogReceipt } from "../../scripts/collect-purelock-history.mjs";
import { censusDigest, readCensusJson } from "../../scripts/operational-value-census-io.mjs";
import { verifyPublicGitBlob } from "../../scripts/immutable-public-git-source.mjs";
import { acquirePurelockCiCoverage, eligiblePurelockCiRun, PendingPurelockEvidence } from "../../scripts/purelock-ci-coverage.mjs";
import { partitionPurelockArchives, verifyPurelockFileSha256 } from "../../scripts/partition-purelock-archives.mjs";

const text = "github.com/github/gh-aw/pkg/probe/pure.go:3:\tPure\t100.0%\n"
  + "github.com/github/gh-aw/pkg/probe/pure.go:7:\tPartial\t50.0%\n"
  + "total:\t(statements)\t75.0%\n";
const candidate = (name, line, coverage) => ({ name, line, file: "pkg/probe/pure.go",
  package: "github.com/github/gh-aw/pkg/probe", coverage_pct: coverage });
const report = { functions_analyzed: 4, pure_functions: 3, coverage_loaded: true,
  candidates: [candidate("Pure", 3, 100), candidate("Partial", 7, 50), candidate("Absent", 10, 0)] };

test("PureLock uses executed native coverage, never the analyzer's assumed zero", () => {
  const evidence = joinPurelockCoverage(report, text);
  assert.equal(evidence.functions.find(row => row.key.endsWith(":Absent")).coverage, null);
  assert.equal(evidence.functions.find(row => row.key.endsWith(":Partial")).coverage, 50);
  assert.equal(evidence.functions.find(row => row.key.endsWith(":Pure")).coverage, 100);
  assert.equal(scorePurelock("observed-fully-covered", evidence), 1);
  assert.equal(scorePurelock("observed-executed", evidence), 2);
  assert.equal(scorePurelock("complete-fully-covered", evidence), null);
  const absent = joinPurelockCoverage({ ...report, pure_functions: 1, candidates: [report.candidates[2]] }, text);
  assert.equal(scorePurelock("observed-fully-covered", absent), null);
});

test("PureLock refuses truncated rankings and conflicting or malformed native records", () => {
  assert.throws(() => joinPurelockCoverage({ ...report, candidates: report.candidates.slice(0, 2) }, text), /population/);
  assert.throws(() => joinPurelockCoverage({ ...report, candidates: [candidate("Pure", 3, 99), ...report.candidates.slice(1)] }, text), /disagree/);
  for (const invalid of ["", text.replace("100.0%", "101.0%"), text + text, text.replace("pkg/probe", "pkg/../probe"),
    "pkg/probe/pure.go:3: Pure NaN%\ntotal: (statements) 0.0%"]) {
    assert.throws(() => parsePurelockCoverage(invalid));
  }
  assert.throws(() => joinPurelockCoverage({ ...report, candidates: [report.candidates[0], report.candidates[0], report.candidates[2]] }, text), /Duplicate/);
});

test("PureLock preserves real zero and rejects malformed evidence across all metrics", () => {
  const functions = [{ key: "pkg/probe/pure.go:3:Pure", coverage: 0 }];
  assert.equal(scorePurelock("observed-fully-covered", { valid: true, functions }), 0);
  assert.equal(scorePurelock("observed-executed", { valid: true, functions }), 0);
  for (const id of ["observed-fully-covered", "complete-fully-covered", "observed-executed"]) {
    for (const invalid of [null, {}, { valid: true, functions: [] }, { valid: true, functions: [...functions, ...functions] },
      { valid: true, functions: [{ ...functions[0], coverage: "100" }] },
      { valid: true, functions: [{ ...functions[0], coverage: Infinity }] },
      { valid: true, functions: [{ ...functions[0], coverage: -1 }] }]) {
      assert.equal(scorePurelock(id, invalid), null);
    }
  }
});

test("Protected log decoder requires executed output rather than printed shell source", () => {
  const receipt = purelockLogReceipt([
    '2026-10-18T12:38:19.1812254Z   echo "No CI coverage artifacts available; computing coverage locally."',
    "2026-10-18T12:38:19.0250945Z go version go1.26.9 linux/amd64",
    "2026-10-18T12:42:50.8802268Z analyzed 100 functions, 20 pure, 10 candidates written to /tmp/purelock/candidates.json",
    "2026-10-18T12:38:18.1709573Z [command]/usr/bin/git log -1 --format=%H",
    "2026-10-18T12:38:18.1726672Z c86377ec47b38f0b5af463277ee55d1d03d08da8",
  ].join("\n"));
  assert.equal(receipt.localCoverage, false);
  assert.equal(receipt.pureFunctions, 20);
  assert.equal(receipt.version, "go version go1.26.9 linux/amd64");
  assert.equal(receipt.checkout, "c86377ec47b38f0b5af463277ee55d1d03d08da8");
  assert.equal(purelockLogReceipt("c86377ec47b38f0b5af463277ee55d1d03d08da8").checkout, null);
  assert.equal(purelockLogReceipt("No CI coverage artifacts available; computing coverage locally.").localCoverage, true);
  assert.equal(purelockLogReceipt("go version go1.26.9 linux/amd64\ngo version go1.26.8 linux/amd64").version, null);
});

test("Compiled job isolation excludes agent-controlled jobs and trailing workflow content", () => {
  assert.equal(purelockJob("jobs:\n  agent:\n    name: agent\n  purelock_precompute:\n    name: native\n\n  safe_outputs:\n    name: agent\n"),
    "  purelock_precompute:\n    name: native");
  assert.equal(purelockJob("jobs:\n  agent:\n    name: agent"), null);
});

test("CI evidence follows every source-declared trigger, requiring the same protected checkout", () => {
  const item = { head_sha: "checkout", repository: { id: 1036865607 }, head_repository: { id: 1036865607 },
    path: ".github/workflows/ci.yml", head_branch: "main", run_attempt: 1,
    created_at: "2026-10-16T12:23:17Z", updated_at: "2026-10-16T12:32:04Z" };
  const run = { headSha: "checkout" }, before = "2026-10-16T12:43:29Z";
  for (const event of ["push", "schedule", "workflow_dispatch"]) {
    assert.equal(eligiblePurelockCiRun({ ...item, event }, run, before, 1036865607), true);
  }
  for (const change of [{ event: "pull_request" }, { event: "push", head_sha: "other" },
    { event: "push", run_attempt: 2 }, { event: "push", updated_at: "2026-10-16T13:00:00Z" }]) {
    assert.equal(eligiblePurelockCiRun({ ...item, ...change }, run, before, 1036865607), false);
  }
});

test("CI replay requires all protected shards, matching source and native output, and provider digests", () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "cao-purelock-ci-"));
  try {
    const target = path.join(scratch, "source"), bundle = path.join(scratch, "bundle");
    mkdirSync(target);
    mkdirSync(bundle);
    const content = Buffer.from("package probe\nfunc Pure() int { return 1 }\n");
    const hash = bytes => createHash("sha256").update(bytes).digest("hex");
    const profile = "mode: set\ngithub.com/github/gh-aw/pkg/probe/pure.go:2.17,2.29 1 1\n";
    writeFileSync(path.join(bundle, "coverage-integration-Probe.out"), profile);
    writeFileSync(path.join(bundle, "test-result-integration-Probe.json"), "{}\n");
    const archive = path.join(scratch, "1.zip");
    execFileSync("zip", ["-q", archive, "coverage-integration-Probe.out", "test-result-integration-Probe.json"], { cwd: bundle });
    const run = { headSha: "checkout" }, ci = { id: 2, head_sha: "checkout", repository: { id: 7 }, head_repository: { id: 7 },
      path: ".github/workflows/ci.yml", head_branch: "main", run_attempt: 1, event: "schedule",
      created_at: "2026-10-16T12:00:00Z", updated_at: "2026-10-16T12:10:00Z" };
    const artifact = { id: 1, name: "ci-integration-coverage-Probe", size_in_bytes: 100,
      digest: `sha256:${hash(readFileSync(archive))}`, created_at: ci.updated_at,
      workflow_run: { id: 2, head_sha: "checkout", repository_id: 7 } };
    const producer = { id: 3, name: "Integration: Probe", conclusion: "success", steps: [
      { name: "Run integration tests - Probe", conclusion: "success" },
      { name: "Upload integration coverage artifacts", conclusion: "success" }] };
    const contract = { repositoryId: 7, ciSourceSha256: "ci-source", directory: scratch };
    const api = endpoint => endpoint.includes("/workflows/") ? { total_count: 1, workflow_runs: [ci] }
      : endpoint.includes("/artifacts?") ? { total_count: 1, artifacts: [artifact] }
        : { total_count: 1, jobs: [producer] };
    const reader = { read: (_commit, file) => file.endsWith("ci.yml") ? { sha256: "ci-source", id: "ci-blob" }
      : { sha256: hash(content), bytes: content, id: "source-blob" } };
    const input = { api, reader, run, receipt: { job: { steps: [{ name: "Collect per-function coverage", startedAt: "2026-10-16T12:20:00Z" }] } },
      scratch, contract, target, runGo: args => {
        assert.deepEqual(args, ["tool", "cover", "-func=purelock-ci-profile.out"]);
        return text;
      }, coverage: text };
    assert.equal(acquirePurelockCiCoverage(input).exactNativeCoverageMatch, true);
    const originalDigest = artifact.digest;
    artifact.digest = `sha256:${"0".repeat(64)}`;
    assert.throws(() => acquirePurelockCiCoverage(input), /digest/);
    artifact.digest = originalDigest;
    producer.steps[0].conclusion = "skipped";
    assert.throws(() => acquirePurelockCiCoverage(input), /protected native producer/);
    producer.steps[0].conclusion = "success";
    assert.equal(acquirePurelockCiCoverage({ ...input, runGo: () => text.replace("100.0%", "0.0%") }), null);
    assert.equal(acquirePurelockCiCoverage({ ...input, api: endpoint => endpoint.includes("/jobs?")
      ? { total_count: 2, jobs: [producer, { ...producer, name: "Integration: Missing" }] } : api(endpoint) }), null);
    rmSync(archive);
    assert.throws(() => acquirePurelockCiCoverage({ ...input, offline: true }), error =>
      error instanceof PendingPurelockEvidence && error.endpoint === "repos/github/gh-aw/actions/artifacts/1/zip");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("Retained real PureLock observations replay from complete native outputs and checked source identities", async () => {
  const base = "docs/operational-value/proof/purelock", index = readCensusJson(`${base}/index.json`);
  const facts = readCensusJson(`${base}/facts.json.gz`), [contract] = readCensusJson(`${base}/contracts.json`);
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  assert.equal(index.complete, true);
  assert.equal(index.acquisitionComplete, true);
  assert.deepEqual(index.pendingAcquisition, []);
  assert.equal(index.factsSha256, censusDigest(facts));
  assert.equal(index.contractSha256, censusDigest(contract));
  assert.equal(contract.producerSha256, hash(readFileSync("scripts/collect-purelock-history.mjs")));
  assert.equal(contract.ciInterpreterSha256, hash(readFileSync("scripts/purelock-ci-coverage.mjs")));
  assert.equal(facts.runs.length, 74);
  for (const entry of index.sources) {
    const source = readCensusJson(`${base}/sources/${entry.gitBlob}.json.gz`);
    assert.equal(censusDigest(source), entry.sha256);
    verifyPublicGitBlob(Buffer.from(source.native, "base64"), entry.gitBlob);
    assert.equal(hash(Buffer.from(source.content, "base64")), source.sha256);
  }
  const measured = facts.observations.filter(row => row.known);
  assert.equal(measured.length, 3);
  for (const state of measured) {
    const bundle = readCensusJson(`${base}/bundle-${state.runId}.json.gz`);
    const replay = readCensusJson(`${base}/replay-${state.runId}.json.gz`);
    assert.equal(bundle.receipt.protectedReceipt.checkout, state.commit);
    assert.equal(replay.report.functions_analyzed, bundle.report.functions_analyzed);
    assert.equal(replay.report.pure_functions, bundle.report.pure_functions);
    assert.equal(replay.report.candidates.length, replay.report.pure_functions);
    assert.deepEqual(joinPurelockCoverage(replay.report, bundle.coverage).functions, state.functions);
    assert.equal(state.functions.filter(row => row.coverage !== null).length,
      state.coverageKind === "ci-integration" ? 2141 : state.functions.length);
  }
  const previous = `${base}/versions/${contract.predecessorSha256}`;
  assert.equal(hash(readFileSync(`${previous}/function.txt`)), contract.predecessorSha256);
  const closure = readCensusJson(`${previous}/closure.json`);
  for (const file of closure.files) assert.ok(verifyPurelockFileSha256(`${previous}/${file.path}`, file.sha256), file.path);
  for (const old of readCensusJson(`${previous}/facts.json.gz`).observations.filter(row => row.known)) {
    assert.deepEqual(measured.find(row => row.runId === old.runId).functions, old.functions);
  }
  const { collectBatch, scoreMetric } = await import("../../docs/operational-value/proof/functions/purelock.mjs");
  const request = { windowStart: "2026-10-17T15:00:12Z", windowEnd: contract.until, observedAt: contract.until };
  const [current] = collectBatch([request]);
  assert.equal(scoreMetric("observed-fully-covered", current.evidence), 1696);
  assert.equal(current.evidence.coverageStatus, "partial");
  assert.throws(() => collectBatch([{ ...request, repository: "github/other" }]), /repository/);
  assert.throws(() => collectBatch([{ ...request, observedAt: request.windowStart }]), /window/);
  const [missing] = collectBatch([{ windowStart: "2026-08-08T15:00:12Z", windowEnd: "2026-08-09T15:00:12Z",
    observedAt: "2026-08-09T15:00:12Z" }]);
  assert.equal(scoreMetric("observed-fully-covered", missing.evidence), null);
});

test("The real CI join retains every declared shard and reproduces native output without assuming missing coverage is zero", () => {
  const base = "docs/operational-value/proof/purelock", [contract] = readCensusJson(`${base}/contracts.json`);
  const facts = readCensusJson(`${base}/facts.json.gz`), ci = readCensusJson(`${base}/ci-replay-38900146742.json.gz`);
  const acquisition = readCensusJson(`${base}/ci-acquisition-38900146742.json`);
  const artifacts = readCensusJson(`${base}/ci-artifacts-38900146742.json.gz`);
  const jobs = readCensusJson(`${base}/ci-jobs-38900146742.json.gz`);
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const source = readCensusJson(`${base}/sources/${ci.proof.sourceGitBlob}.json.gz`);
  const bytes = Buffer.from(source.content, "base64");
  assert.equal(hash(bytes), contract.ciSourceSha256);
  const matrix = bytes.toString().match(/      matrix:\r?\n        test-group:\r?\n([\s\S]*?)\r?\n    concurrency:/)?.[1];
  assert.ok(matrix);
  const declared = [...matrix.matchAll(/^        - name: "([^"]+)"/gm)].map(match => `Integration: ${match[1]}`).sort();
  assert.equal(declared.length, 27);
  assert.deepEqual(ci.proof.artifacts.map(row => row.producer.name).sort(), declared);
  assert.equal(acquisition.complete, true);
  for (const record of acquisition.records) {
    assert.equal(censusDigest(readCensusJson(`${base}/${record.file}`)), record.sha256);
    const response = acquisition.responses.find(row => row.endpoint === `repos/github/gh-aw/actions/runs/38900146742/${record.kind}?per_page=100`);
    assert.equal(response?.status, 200);
    assert.equal(response.responseSha256, record.sha256);
  }
  assert.equal(artifacts.total_count, artifacts.artifacts.length);
  assert.equal(jobs.total_count, jobs.jobs.length);
  assert.equal(ci.proof.exactNativeCoverageMatch, true);
  assert.equal(hash(ci.output), ci.proof.outputSha256);
  const bodies = ci.proof.artifacts.map(artifact => {
    const metadata = artifacts.artifacts.find(row => row.id === artifact.id);
    assert.equal(metadata?.digest, artifact.digest);
    assert.equal(metadata.workflow_run.head_sha, ci.proof.commit);
    assert.equal(metadata.workflow_run.repository_id, contract.repositoryId);
    const response = acquisition.responses.find(row => row.endpoint === `repos/github/gh-aw/actions/artifacts/${artifact.id}/zip`);
    assert.equal(response?.status, 200);
    assert.equal(`sha256:${response.responseSha256}`, artifact.digest);
    const producer = jobs.jobs.find(row => row.id === artifact.jobId);
    assert.equal(producer?.name, artifact.producer.name);
    assert.equal(producer.conclusion, "success");
    assert.equal(artifact.profileRecord.file, path.basename(artifact.profileRecord.file));
    const record = readCensusJson(`${base}/${artifact.profileRecord.file}`);
    assert.equal(censusDigest(record), artifact.profileRecord.sha256);
    assert.equal(record.runId, ci.proof.runId);
    assert.equal(record.artifactId, artifact.id);
    assert.equal(hash(record.profile), artifact.profileSha256);
    return record.profile.split("\n").slice(1).join("\n");
  });
  const merged = `mode: atomic\n${bodies.join("")}`;
  assert.ok(Buffer.byteLength(merged) > 64 * 1024 * 1024);
  assert.ok(Buffer.byteLength(merged) <= 128 * 1024 * 1024);
  assert.equal(hash(merged), ci.proof.profileSha256);
  const bundle = readCensusJson(`${base}/bundle-38902336947.json.gz`);
  const entries = text => [...parsePurelockCoverage(text)].sort(([a], [b]) => a.localeCompare(b));
  assert.deepEqual(entries(ci.output), entries(bundle.coverage));
  const receipt = facts.receipts.find(row => row.run.id === 38902336947);
  assert.deepEqual(receipt.ciProof, ci.proof);
  const observation = facts.observations.find(row => row.runId === 38902336947);
  assert.equal(observation.functions.length, 2424);
  assert.equal(observation.functions.filter(row => row.coverage === null).length, 283);
  assert.equal(scorePurelock("observed-fully-covered", { valid: true, functions: observation.functions }), 576);
  assert.equal(scorePurelock("complete-fully-covered", { valid: true, functions: observation.functions }), null);
});

test("Portable PureLock metadata preserves original bytes and verifies partitioned sealed predecessors", () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "cao-purelock-portable-"));
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  try {
    const file = path.join(scratch, "index.json");
    const original = Buffer.from(`${JSON.stringify({ data: "x".repeat(300000) }, null, 2)}\n`);
    writeFileSync(file, original);
    const closureFile = path.join(scratch, "closure.json");
    const closure = { files: [{ path: "index.json", sha256: hash(original) }], data: "y".repeat(300000) };
    const originalClosure = Buffer.from(`${JSON.stringify(closure, null, 2)}\n`);
    writeFileSync(closureFile, originalClosure);
    assert.equal(partitionPurelockArchives(scratch).length, 2);
    assert.equal(verifyPurelockFileSha256(file, hash(original)), true);
    assert.equal(verifyPurelockFileSha256(closureFile, hash(originalClosure)), true);
    assert.equal(verifyPurelockFileSha256(file, hash(readFileSync(file))), true);
    assert.deepEqual(readCensusJson(closureFile), closure);
    const manifest = JSON.parse(readFileSync(file));
    const decoded = Buffer.concat(manifest.parts.map(part =>
      Buffer.from(readCensusJson(path.join(scratch, part.file)), "base64")));
    assert.deepEqual(decoded, original);
    for (const entry of readdirSync(scratch)) {
      assert.ok(readFileSync(path.join(scratch, entry)).length <= 256 * 1024);
    }
    assert.deepEqual(partitionPurelockArchives(scratch), []);
    writeFileSync(path.join(scratch, manifest.parts[0].file), "{}");
    assert.throws(() => verifyPurelockFileSha256(file, hash(original)));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  const versions = "docs/operational-value/proof/purelock/versions";
  let sealed = 0;
  for (const entry of readdirSync(versions, { withFileTypes: true })) {
    const directory = path.join(versions, entry.name);
    if (!entry.isDirectory() || !readdirSync(directory).includes("closure.json")) continue;
    const closure = readCensusJson(path.join(directory, "closure.json"));
    for (const file of closure.files) {
      assert.ok(verifyPurelockFileSha256(path.join(directory, file.path), file.sha256), `${entry.name}/${file.path}`);
    }
    sealed++;
  }
  assert.ok(sealed >= 5);
});
