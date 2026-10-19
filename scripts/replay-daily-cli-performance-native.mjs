#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { parseOriginalBenchmark } from "../docs/operational-value/proof/functions/daily-cli-performance.mjs";
import { readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { readOfflineBlob } from "./collect-daily-cli-performance-proof.mjs";

const root = "docs/operational-value/proof/daily-cli-performance";
const reportRoot = "docs/operational-value/reports/github-gh-aw";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const discovery = readCensusJson(`${root}/native-discovery.json.gz`);
const receipts = readCensusJson(`${root}/native-receipts.json.gz`);
const body = receipt => {
  const bytes = Buffer.from(receipt.originalBody, "base64");
  assert.equal(digest(bytes), receipt.bodySha256);
  assert.equal(receipt.status, 200);
  return bytes;
};
const inventory = discovery.receipts.map(receipt => JSON.parse(body(receipt)));
const originalRun = inventory[0].workflow_runs.find(run => run.id === 39099938569);
const artifact = inventory[1].artifacts.find(row => row.id === 12126257720);
assert.equal(originalRun.repository.id, 1036865607);
assert.equal(originalRun.path, ".github/workflows/cgo.yml");
assert.equal(originalRun.head_sha, "10f9281950798beb307862f81caf03807d48e89e");
assert.equal(artifact.workflow_run.id, originalRun.id);
assert.equal(artifact.workflow_run.head_sha, originalRun.head_sha);
assert.equal(artifact.digest, `sha256:${receipts.receipts[0].bodySha256}`);
assert.equal(body(receipts.receipts[0]).length, artifact.size_in_bytes);
const jobs = JSON.parse(body(receipts.receipts[1]));
const checks = JSON.parse(body(receipts.receipts[3]));
const benchJob = jobs.jobs.find(job => job.name === "bench");
assert.equal(benchJob.run_id, originalRun.id);
assert.equal(jobs.total_count, jobs.jobs.length);
const python = `
import sys, json, base64, zipfile, io, hashlib, re
request = json.load(sys.stdin)
result = {}
for key in ("artifact", "logs"):
    z = zipfile.ZipFile(io.BytesIO(base64.b64decode(request[key])))
    entries = z.infolist()
    names = [e.filename for e in entries]
    if len(names) != len(set(names)): raise ValueError("Duplicate ZIP members")
    selected = [e for e in entries if e.filename == "bench_results.txt"] if key == "artifact" else [
        e for e in entries if re.fullmatch(r"\\d+_bench\\.txt", e.filename) or re.fullmatch(r"\\d+_Unit tests \\(.+\\)\\.txt", e.filename)]
    if key == "artifact" and len(selected) != 1: raise ValueError("Missing original benchmark payload")
    if key == "logs" and len(selected) != 6: raise ValueError("Missing original benchmark/unit producer logs")
    if sum(e.file_size for e in selected) > 64*1024*1024: raise ValueError("Expanded native closure exceeds budget")
    rows = []
    for e in selected:
        if e.file_size > 16*1024*1024 or e.flag_bits & 1: raise ValueError("Unsupported native log member")
        h = hashlib.sha256()
        failures = []
        malformed = []
        native_events = 0
        saved = bytearray()
        with z.open(e) as stream:
            for line in stream:
                h.update(line)
                if e.filename == "bench_results.txt" or re.fullmatch(r"\\d+_bench\\.txt", e.filename):
                    saved.extend(line)
                at = line.find(b'{"Time":')
                if at >= 0:
                    try: event = json.loads(line[at:])
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        malformed.append(hashlib.sha256(line).hexdigest())
                        continue
                    native_events += 1
                    if event.get("Action") == "fail":
                        failures.append({k:event[k] for k in ("Time","Action","Package","Test","Elapsed") if k in event})
        row = {"member":e.filename, "bytes":e.file_size, "sha256":h.hexdigest(),
               "nativeJsonEvents":native_events, "failedEvents":failures, "malformedJsonLineDigests":malformed}
        if saved: row["contentBase64"] = base64.b64encode(saved).decode()
        rows.append(row)
    result[key] = rows
json.dump(result, sys.stdout)
`;
const decoded = spawnSync("python3", ["-c", python], {
  input: JSON.stringify({ artifact: receipts.receipts[0].originalBody, logs: receipts.receipts[2].originalBody }),
  encoding: "utf8", timeout: 45000, maxBuffer: 4 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
});
if (decoded.error || decoded.status !== 0) throw new Error(decoded.error?.message ?? decoded.stderr);
const extracted = JSON.parse(decoded.stdout);
const raw = Buffer.from(extracted.artifact[0].contentBase64, "base64");
const rows = parseOriginalBenchmark(raw.toString("utf8"));
assert.equal(rows.length, 1);
const log = extracted.logs.find(row => /_bench\.txt$/.test(row.member));
const logText = Buffer.from(log.contentBase64, "base64").toString("utf8");
assert.ok(logText.includes(rows[0].line));
const sourcePaths = ["pkg/workflow/compiler_performance_benchmark_test.go", "Makefile", "go.mod", ".github/workflows/cgo.yml"];
const [cache, ...suppliedDirectory] = process.argv.slice(2);
if (!cache) throw new Error("usage: replay-daily-cli-performance-native.mjs GIT_CACHE [SUPPLIED_BLOBS...]");
const sources = sourcePaths.map(file => readOfflineBlob(cache, originalRun.head_sha, file, suppliedDirectory));
const frozen = readCensusJson(`${root}/investigation.json.gz`);
for (const source of sources) {
  assert.equal(source.status, "available");
  assert.ok(frozen.sources.some(row => row.blob === source.blob && row.sha256 === source.sha256));
}
const benchmarkEvents = logText.split(/\r?\n/).filter(line =>
  /go version go|go1\.26|Image Version:|Runner Image|CPU|cpu:|BenchmarkCompileSimpleWorkflow|benchtime=|Run benchmarks/.test(line));
const result = {
  schemaVersion: 1, repository: "github/gh-aw", repositoryId: 1036865607,
  cutoff: frozen.scope.cutoff, sourceRevision: frozen.scope.revision,
  originalRun: { id: originalRun.id, head: originalRun.head_sha, createdAt: originalRun.created_at,
    conclusionObserved: originalRun.conclusion, jobId: benchJob.id, jobCompletedAt: benchJob.completed_at },
  originalArtifact: { id: artifact.id, name: artifact.name, createdAt: artifact.created_at,
    providerDigest: artifact.digest, sizeBytes: artifact.size_in_bytes,
    rawMember: extracted.artifact[0].member, rawMemberSha256: digest(raw) },
  sourceProfile: sources,
  nativeDiagnostic: {
    benchmark: "BenchmarkCompileSimpleWorkflow", reportedNanosecondsPerAttemptedOperation: rows[0].reportedNsPerOp,
    completedBenchmarkIterations: rows[0].iterations, bytesPerOperation: rows[0].bytesPerOp,
    allocationsPerOperation: rows[0].allocationsPerOp, gomaxprocs: rows[0].gomaxprocs,
    exactElapsedNanoseconds: null, rawLine: rows[0].line,
    hardwareLabel: raw.toString("utf8").match(/^cpu: (.+)$/m)?.[1] ?? null,
    sourceCommand: "make bench", benchtime: "3x",
    independentlyProducedAndReadBack: true,
    successfulFixtureCompilation: "unknown: benchmark suppresses compile return errors",
    interpretation: "Original native benchmark subtotal, not accepted successful-compilation latency, full acceptance, delivered improvement, or workflow contribution.",
  },
  protectedCorrectness: {
    unitJobs: jobs.jobs.filter(job => job.name.startsWith("Unit tests")).map(job => ({
      id: job.id, name: job.name, conclusion: job.conclusion,
    })),
    nativeFailureEvents: extracted.logs.flatMap(row => row.failedEvents),
    unparsedNativeJsonRows: extracted.logs.reduce((sum, row) => sum + row.malformedJsonLineDigests.length, 0),
    checkRunsReturned: checks.check_runs.length, checkRunsTotal: checks.total_count,
    checkRunsComplete: checks.check_runs.length === checks.total_count && !receipts.receipts[3].next,
    fixtureAcceptance: "not established",
    fullSafeguardAcceptance: "not established; one protected unit shard failed and checks discovery is incomplete",
  },
  originalPayloads: extracted,
  benchmarkLogContext: benchmarkEvents,
  acceptance: { latencyValue: null, goalCompleted: null, workflowContribution: null,
    reason: "Controlled timing subtotal retained, but independent successful compilation of the benchmark fixture and complete correctness acceptance are not demonstrated." },
  missingScope: {
    historicalDiscoveryComplete: false, adjacentOriginalBenchmarks: "not acquired",
    comparableHardwareHistory: "not acquired", originalWorkflowContributionGraph: "unverified",
    nextCheckRuns: receipts.receipts[3].next,
  },
};
writeCensusJson(`${root}/native-replay.json.gz`, result);
const value = rows[0].reportedNsPerOp, y = 260 - value / 100000000 * 210;
writeFileSync(`${reportRoot}/daily-cli-performance-native-diagnostic.html`, `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Daily CLI performance: original native diagnostic</title>
<body style="font:16px system-ui;max-width:900px;margin:2em auto;padding:1em;overflow-wrap:anywhere">
<h1>Original native benchmark diagnostic</h1>
<p><strong>${value.toLocaleString("en-US")} nanoseconds per attempted benchmark operation</strong>,
${rows[0].iterations} original iterations. Not accepted successful-compilation latency or workflow value.</p>
<svg viewBox="0 0 800 320" role="img" aria-label="One original benchmark diagnostic; no trend">
<path d="M150 40V260H760" fill="none" stroke="black"/>
<path d="M150 50H760" stroke="gray" stroke-dasharray="4 4"/>
<text x="0" y="55">100,000,000 ns</text><text x="100" y="265">0 ns</text>
<circle cx="460" cy="${y}" r="7" fill="#176b8b"/>
<text x="480" y="${y - 10}">${value} ns/attempt</text>
<text x="300" y="300">2026-10-18T05:25:51Z (single observation)</text></svg>
<p>The dashed line is the source's &lt;100ms goal, not proof of accepted attainment.
The benchmark ignores compile errors. One protected unit shard failed; fixture success and unchanged
hardware/toolchain history are not established. No line, trend, improvement, saved-time estimate or causal claim is drawn.</p>
<p>Original artifact 12126257720, run 39099938569, head ${originalRun.head_sha}.
Provider ZIP SHA256: ${receipts.receipts[0].bodySha256}.</p>
<p>Authoritative replay: <code>docs/operational-value/proof/daily-cli-performance/native-replay.json.gz</code>.
The separately frozen accepted-value pulse retains explicit missing values.</p></body></html>\n`);
console.log(JSON.stringify({ nativeDiagnostic: result.nativeDiagnostic,
  nativeFailedEvents: result.protectedCorrectness.nativeFailureEvents,
  acceptedValue: null, report: `${reportRoot}/daily-cli-performance-native-diagnostic.html` }));
