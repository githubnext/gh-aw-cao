import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";

const repository = "github/gh-aw";
const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
const cutoff = "2026-10-18T15:00:12Z";
const benchmarkBlob = "64356d580f083070879242b472a85c91179776ab";
const sourceBlob = "3c67fd8d57eeefa431030bc9c2c8e21618536f6e";
const protectedProducerBlob = "9f23e662b4f4ed70f3771eae570c11fa236db9eb";
const sourceDigest = "ce3bae3ebc5996b4196f81b20fbe2e66cb3ec8d667f084d30c73f695e9904286";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const utc = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)
  && Number.isFinite(Date.parse(value));
const positive = value => Number.isSafeInteger(value) && value > 0;
const median = values => {
  const sorted = values.toSorted((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : sorted[mid - 1] / 2 + sorted[mid] / 2;
};
const example = latency => ({
  valid: true, reportedNanosecondsPerCompile: [latency], profileDigest: "a".repeat(64),
});

export const definition = {
  schemaVersion: 3, slug: "daily-cli-performance", repository,
  workflowName: "Daily CLI Performance",
  sourcePath: ".github/workflows/daily-cli-performance.md",
  intent: {
    goal: "Keep workflow compilation fast, detect regressions, and support independently verified latency improvements.",
    acceptance: "Original independently produced BenchmarkCompileSimpleWorkflow timing rows, bound to immutable compiler/benchmark revisions and unchanged controlled execution/correctness profiles; successful compilation of the fixture is independently demonstrated.",
    temporalAnchor: "workflow-adoption",
  },
  adoption: {
    commit: "aa41ba8d8621fec20a40cece3832886dea3a6c98", adoptedAt: "2025-12-31T17:50:25Z",
    baselineCommit: "1267f50853b056ed76611d77deffcbbf9b393c67", baselineAt: "2025-12-31T17:42:04Z",
  },
  evaluation: {
    mode: "attainment-only",
    reason: "Compilation latency pre-existed automation; this benchmark file was introduced with the workflow. No original pre-adoption timing, iteration, fixture-success or controlled-profile evidence is preserved in the supplied sources. Historical reconstructability remains open, not exhausted.",
  },
  evidence: {
    key: "daily-cli-performance-original-simple-latency",
    repositories: [repository],
    opportunity: "Original completed operations of BenchmarkCompileSimpleWorkflow, from independent protected producers, in each inclusive-start/exclusive-end daily cohort.",
    filters: [
      `Frozen intent blob ${sourceBlob}; benchmark blob ${benchmarkBlob}.`,
      "Retain original raw Go timing output, positive completed iterations, producer/run/artifact digest and immutable compiler head.",
      "Require independent fixture-success and unchanged protected correctness scope at the measured head; the benchmark discards CompileWorkflow errors.",
      "Never combine hardware, runner image, Go version, dependency, benchmark, flags, CPU or correctness profiles.",
      `Current protected producer profile: cgo.yml job bench at blob ${protectedProducerBlob}, make bench, -benchtime=3x. The agent's two-second profile is not interchangeable.`,
      "Agent prose, self-generated JSON, example code, successful jobs and fresh local benchmark runs are not accepted historical measurements.",
      "Missing original timings or profiles are unknown, not zero; rounded ns/op does not reconstruct exact elapsed nanoseconds.",
    ],
    collection: "Read digest-checked offline preserved investigation once per batch. Separate bounded public acquisition from scoring; no API, code execution, lazy Git fetch or local rerun. Retain all candidate lineage and all unresolved scope.",
    measurementKind: "interval",
    window: { durationDays: 1, cadenceDays: 1, maturationDays: 0 },
    zeroRule: "No accepted raw benchmark operations means null, including a verified empty cohort. Zero latency is not inferred from zero opportunities.",
  },
  source: { repositoryId: 1036865607, revision, cutoff, sourceBlob, sourceDigest, benchmarkBlob,
    definitionBoundary: "Fixed from complete frozen workflow, benchmark, Make targets and independent protected producer job sources; before original native results." },
  model: {
    architecture: "One native simple-compilation latency facet, with workflow-linked delivered change and full-goal acceptance kept separate.",
    recommendation: "Measure original reported latency; acquire original protected benchmark and correctness facts before rating value. No keep bar or causal inference.",
    presentation: { label: "Reported simple compilation latency", betterLabel: "Lower latency with unchanged correctness" },
  },
  summary: { nativeLabel: "nanoseconds per compile" },
  metrics: [
    {
      id: "simple-compile-latency", name: "Simple compilation latency", role: "primary",
      formula: "Median original reported ns/op for BenchmarkCompileSimpleWorkflow within one daily cohort and exactly one controlled profile. Preserve reported precision and iteration counts; never invent elapsed totals.",
      direction: "decrease", unit: "nanoseconds per compile", target: 100000000,
      targetRule: "Strictly less than 100000000 ns/compile, from the source's <100ms target.",
      presentation: { name: "Simple compilation latency", legendLabel: "Simple compile ns/op", transform: "identity" },
    },
  ],
  rejected: [
    { measure: "Successful jobs or benchmark command exit", reason: "Neither proves native latency nor fixture correctness; benchmark loops ignore compilation errors and Make uses a pipe without pipefail." },
    { measure: "Issues, PRs, discussions, report counts, closed/completed state", reason: "Discovery/activity, not latency or independent acceptance." },
    { measure: "Agent-parsed JSON and trend/regression classification", reason: "Self-produced interpretation; source history is pruned to 14 entries and may mix uncontrolled runners. Integer-only parser omits valid decimal timing rows." },
    { measure: "10% regression, 5% warning, median of seven and multi-benchmark noise heuristic", reason: "Source diagnostic policies, not verified simple-latency outcome or a keep policy." },
    { measure: "Complex/MCP, allocations, parsing, validation, YAML and CLI helpers", reason: "Separate facets; no invented weighted suite score. Their acceptance remains open." },
    { measure: "Dollars or time saved", reason: "No matching usage/exposure or cost data; latency change is not cumulative human time saved." },
  ],
  validationExamples: {
    targetAttained: example(50000000),
    targetMissed: example(120000000),
    missing: { valid: false, missingReason: "Original benchmark facts unavailable" },
    malformed: { valid: true, reportedNanosecondsPerCompile: ["fast"], profileDigest: "bad" },
  },
};

export function parseOriginalBenchmark(raw) {
  if (typeof raw !== "string" || raw.length > 4 * 1024 * 1024) throw new Error("Invalid raw benchmark payload");
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!/^BenchmarkCompileSimpleWorkflow(?:-\d+)?\s/.test(line)) continue;
    const match = /^BenchmarkCompileSimpleWorkflow(?:-([1-9]\d*))?\s+([1-9]\d*)\s+(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s+ns\/op\s+(\d+)\s+B\/op\s+(\d+)\s+allocs\/op\s*$/.exec(line);
    if (!match) throw new Error("Malformed simple-compilation benchmark row");
    const [, cpu = "1", iterations, ns, bytes, allocs] = match;
    if (![Number(cpu), Number(iterations)].every(positive)
      || !Number.isFinite(Number(ns)) || Number(ns) <= 0
      || ![Number(bytes), Number(allocs)].every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw new Error("Invalid native benchmark quantities");
    }
    rows.push({ line, iterations: Number(iterations), reportedNsPerOp: Number(ns),
      bytesPerOp: Number(bytes), allocationsPerOp: Number(allocs), gomaxprocs: Number(cpu) });
  }
  return rows;
}

export function acceptedMeasurement(record) {
  if (!record || record.kind !== "original-protected-benchmark" || record.repository !== repository
    || !sha(record.compilerHead) || record.benchmarkBlob !== benchmarkBlob
    || !utc(record.completedAt) || Date.parse(record.completedAt) >= Date.parse(cutoff)
    || typeof record.raw !== "string" || !hash(record.rawSha256)
    || digest(record.raw) !== record.rawSha256 || !positive(record.runId)
    || !positive(record.artifactId) || !hash(record.artifactSha256)
    || record.producer?.independent !== true || record.producer?.workflowBlob !== protectedProducerBlob
    || record.producer?.job !== "bench"
    || record.producer?.head !== record.compilerHead
    || record.correctness?.fixtureCompiled !== true
    || record.correctness?.head !== record.compilerHead
    || !hash(record.correctness?.scopeDigest) || !hash(record.correctness?.evidenceDigest)
    || !hash(record.receiptSha256)) return null;
  const p = record.profile;
  if (!p || !["linux", "darwin", "windows"].includes(p.goos)
    || !/^[\w.-]+$/.test(p.goarch ?? "") || !/^go\d+\.\d+(?:\.\d+)?$/.test(p.goVersion ?? "")
    || !hash(p.hardwareDigest) || !hash(p.runnerImageDigest) || !hash(p.dependenciesDigest)
    || !positive(p.gomaxprocs) || p.correctnessScopeDigest !== record.correctness.scopeDigest
    || p.command !== "make bench" || p.benchtime !== "3x"
    || p.benchmarkBlob !== benchmarkBlob) return null;
  const rows = parseOriginalBenchmark(record.raw);
  if (!rows.length || rows.some(row => row.gomaxprocs !== p.gomaxprocs || row.iterations !== 3)
    || !record.raw.includes("pkg: github.com/github/gh-aw/pkg/workflow")
    || !record.raw.includes(`goos: ${p.goos}\n`) || !record.raw.includes(`goarch: ${p.goarch}\n`)) return null;
  return { ...record, rows, profileDigest: digest(JSON.stringify(p)) };
}

export function scoreMetric(id, evidence) {
  if (!evidence || evidence.valid !== true || !hash(evidence.profileDigest)
    || !Array.isArray(evidence.reportedNanosecondsPerCompile)
    || !evidence.reportedNanosecondsPerCompile.length
    || !evidence.reportedNanosecondsPerCompile.every(value => typeof value === "number"
      && Number.isFinite(value) && value > 0)) return null;
  if (id === "simple-compile-latency") return median(evidence.reportedNanosecondsPerCompile);
  return null;
}

export async function collectBatch(requests, context = {}) {
  if (!Array.isArray(requests)) throw new Error("Expected batch requests");
  const proofPath = context.proofPath ?? fileURLToPath(new URL("../daily-cli-performance/investigation.json.gz", import.meta.url));
  const proof = readJsonArchive(path.resolve(proofPath));
  if (proof.schemaVersion !== 1 || proof.scope?.repository !== repository
    || proof.scope?.repositoryId !== 1036865607 || proof.scope?.revision !== revision
    || proof.scope?.cutoff !== cutoff || proof.scope?.sourceBlob !== sourceBlob
    || !Array.isArray(proof.nativeEvidence)) throw new Error("Native evidence scope mismatch");
  const source = proof.sources.find(row => row.blob === sourceBlob);
  if (source?.status !== "available" || source.sha256 !== sourceDigest
    || digest(Buffer.from(source.content, "base64")) !== sourceDigest) throw new Error("Frozen source integrity mismatch");
  const native = proof.nativeEvidence.map(record => {
    const accepted = acceptedMeasurement(record);
    if (!accepted) throw new Error("Unaccepted record in protected native evidence");
    return accepted;
  });
  const receipts = new Set();
  for (const record of native) {
    const key = `${record.runId}:${record.artifactId}:${record.rawSha256}`;
    if (receipts.has(key)) throw new Error("Repeated native benchmark receipt");
    receipts.add(key);
  }
  const proofDigest = digest(JSON.stringify(proof));
  return requests.map(request => {
    if (!utc(request.windowStart) || !utc(request.windowEnd) || !utc(request.observedAt)
      || Date.parse(request.windowStart) >= Date.parse(request.windowEnd)
      || Date.parse(request.windowEnd) > Date.parse(request.observedAt)
      || request.repository && request.repository.toLowerCase() !== repository.toLowerCase()) {
      throw new Error("Invalid bounded native evidence request");
    }
    const selected = native.filter(record => Date.parse(record.completedAt) >= Date.parse(request.windowStart)
      && Date.parse(record.completedAt) < Date.parse(request.windowEnd));
    const profiles = [...new Set(selected.map(row => row.profileDigest))];
    const valid = selected.length > 0 && profiles.length === 1;
    const values = selected.flatMap(record => record.rows.map(row => row.reportedNsPerOp));
    const missingReason = valid ? null : profiles.length > 1
      ? "Incompatible controlled benchmark profiles in this cohort; preserve native subtotals without pooling."
      : "No original protected simple-compilation benchmark rows with immutable timing, iteration, environment and independent fixture/correctness evidence were acquired. Retained reports, successful runs and merges are not substitutes.";
    const evidence = {
      valid, windowStart: request.windowStart, windowEnd: request.windowEnd,
      coverageStatus: valid ? "partial" : "missing",
      maturityStatus: valid ? "matured" : "unavailable",
      missingReason, reportedNanosecondsPerCompile: valid ? values : [],
      profileDigest: valid ? profiles[0] : null,
      populationDigest: valid ? profiles[0] : null,
      eligibleCount: valid ? selected.reduce((n, record) => n + record.rows.reduce((m, row) => m + row.iterations, 0), 0) : null,
      workflowLatencyGain: null,
      workflowContributionStatus: "unknown: independent creation/downstream graph plus matched before/after benchmarks not acquired",
      goalCompletion: valid ? median(values) < 100000000 : null,
      completeGoalAcceptance: "unknown: simple latency alone does not prove other benchmark facets or full regression safety",
      nativeRecords: selected.map(({ raw, ...record }) => ({ ...record, rawSha256: digest(raw) })),
      samplingCoverage: "Unknown until the full independent producer inventory and original payloads are reconciled.",
      comparisonStatus: "unavailable: complete adjacent equal-profile evidence is not established",
      costs: "not measured",
    };
    return {
      evidence,
      provenance: [
        { repository, kind: "immutable-intent", ref: `git:${revision}:${sourceBlob}:sha256:${sourceDigest}` },
        { repository, kind: "immutable-benchmark", ref: `git:${revision}:${benchmarkBlob}` },
        { repository, kind: "preserved-offline-investigation", ref: `sha256:${proofDigest}` },
      ],
    };
  });
}
