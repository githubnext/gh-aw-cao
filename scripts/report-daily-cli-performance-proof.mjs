#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { definition, scoreMetric } from "../docs/operational-value/proof/functions/daily-cli-performance.mjs";
import { readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";

const root = "docs/operational-value/proof/daily-cli-performance";
const functionPath = "docs/operational-value/proof/functions/daily-cli-performance.mjs";
const reportRoot = "docs/operational-value/reports/github-gh-aw";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const previousReportRoot = `${root}/reports/github-gh-aw`;
if (existsSync(previousReportRoot)) {
  mkdirSync(reportRoot, { recursive: true });
  for (const entry of readdirSync(previousReportRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !/^daily-cli-performance-(?:timeline|definitions|pulse|evidence-archive)(?:-part-\d{3})?\.(?:json(?:\.gz)?|md|html)$/.test(entry.name)) {
      throw new Error("Unexpected file in owned generated report directory");
    }
    const from = path.join(previousReportRoot, entry.name), to = path.join(reportRoot, entry.name);
    if (existsSync(to)) throw new Error("Canonical report destination already exists; do not overwrite");
    renameSync(from, to);
  }
}
const definitions = `${reportRoot}/daily-cli-performance-definitions.md`;
const retainedDefinitions = `${definitions}.txt`;
if (existsSync(definitions)) {
  if (existsSync(retainedDefinitions)) {
    assert.equal(digest(readFileSync(definitions)), digest(readFileSync(retainedDefinitions)));
    unlinkSync(definitions);
  } else renameSync(definitions, retainedDefinitions);
}
const proof = readCensusJson(`${root}/investigation.json.gz`);
const replay = existsSync(`${root}/native-replay.json.gz`) ? readCensusJson(`${root}/native-replay.json.gz`) : null;
if (replay) assert.equal(digest(JSON.stringify(replay)), proof.nativeDiagnostics.sha256);
for (const archive of proof.acquisitionLedger.archives) {
  assert.match(archive.file, /^native-(?:discovery|receipts)\.json\.gz$/);
  const acquired = readCensusJson(path.join(root, archive.file));
  assert.equal(digest(JSON.stringify(acquired)), archive.sha256);
  for (const receipt of acquired.receipts) {
    assert.equal(digest(Buffer.from(receipt.originalBody, "base64")), receipt.bodySha256);
  }
}
const timeline = readCensusJson(`${reportRoot}/daily-cli-performance-timeline.json`);
const pulse = readCensusJson(`${reportRoot}/daily-cli-performance-pulse.json`);
const functionSha256 = digest(readFileSync(functionPath));
const retainedProofDigests = new Set([digest(JSON.stringify(proof))]);
for (const predecessor of proof.predecessors ?? []) {
  assert.match(predecessor.file, /^predecessor-[a-f0-9]{64}\.json\.gz$/);
  const retained = readCensusJson(path.join(root, predecessor.file));
  assert.equal(digest(JSON.stringify(retained)), predecessor.sha256);
  retainedProofDigests.add(predecessor.sha256);
}
assert.equal(timeline.valueFunction.sha256, functionSha256);
assert.deepEqual(timeline.valueFunction.definition, definition);
assert.equal(timeline.repository, proof.scope.repository);
assert.equal(timeline.workflowSlug, proof.scope.workflow);
assert.equal(timeline.window.endAt, proof.scope.cutoff);
assert.equal(pulse.valueFunctionSha256, functionSha256);
assert.equal(pulse.repository, proof.scope.repository);
assert.equal(pulse.workflowSlug, proof.scope.workflow);
assert.equal(pulse.metrics.length, 1);
assert.equal(pulse.metrics[0].unit, definition.metrics[0].unit);
assert.deepEqual(pulse.metrics[0].series.map(row => row.value),
  timeline.snapshots.map(row => row.metrics["simple-compile-latency"]));
for (const source of proof.sources.filter(row => row.status === "available")) {
  const bytes = Buffer.from(source.content, "base64");
  assert.equal(digest(bytes), source.sha256);
  assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), source.blob);
}
for (const receipt of proof.sourceAcquisitionReceipts) {
  const bytes = Buffer.from(receipt.payload, "base64");
  assert.equal(digest(bytes), receipt.providerPayloadSha256);
  const response = JSON.parse(bytes);
  assert.equal(response.sha, receipt.sha);
  assert.equal(digest(Buffer.from(response.content, "base64")), receipt.sha256);
}
for (let index = 0; index < timeline.snapshots.length; index += 1) {
  const snapshot = timeline.snapshots[index];
  assert.equal(snapshot.metrics["simple-compile-latency"], scoreMetric("simple-compile-latency", snapshot.evidence));
  assert.ok(snapshot.provenance.some(row => row.ref.startsWith("sha256:")
    && retainedProofDigests.has(row.ref.slice(7))));
  if (index) assert.equal(timeline.snapshots[index - 1].window.endAt, snapshot.window.startAt);
}
assert.equal(timeline.snapshots.at(-1).window.endAt, proof.scope.cutoff);
const sourceGaps = proof.sources.filter(row => row.status === "unavailable-offline");
const native = timeline.snapshots.filter(row => row.metrics["simple-compile-latency"] !== null);
const allFiles = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(directory, entry.name);
  return entry.isDirectory() ? allFiles(file) : [file];
});
const matchingReports = allFiles(reportRoot).filter(file => path.basename(file).startsWith("daily-cli-performance-"));
const oversized = [...allFiles(root), ...matchingReports, functionPath].filter(file => statSync(file).size > 256 * 1024);
assert.deepEqual(oversized, []);
const report = {
  schemaVersion: 1,
  workflow: proof.scope.workflow, repository: proof.scope.repository,
  repositoryId: proof.scope.repositoryId, revision: proof.scope.revision, cutoff: proof.scope.cutoff,
  valueFunction: { path: functionPath, sha256: functionSha256,
    sourceBlob: proof.scope.sourceBlob, sourceSha256: definition.source.sourceDigest,
    benchmarkBlob: definition.source.benchmarkBlob, contract: definition },
  analysis: {
    intent: "Keep workflow compilation fast; detect regressions and enable repairs, not merely create reports.",
    problem: "Workflow compiler latency exists independently of this automation and can improve through any actor.",
    nativeFacet: "Original reported BenchmarkCompileSimpleWorkflow nanoseconds per compile, lower is better.",
    sourceTarget: { strictLessThan: 100000000, unit: "nanoseconds per compile" },
    originalQuantities: "Raw Go benchmark line, positive completed iterations, reported ns/op, B/op and allocs/op. Standard ns/op is rounded; exact elapsed totals are not reconstructed.",
    aggregation: "Median retained original rows within one daily interval and exactly one immutable controlled profile; never pool different profiles.",
    sourceCaveats: [
      "Both adoption and frozen simple benchmarks discard compiler errors; independent fixture-success evidence is required.",
      "Frozen benchmark adds warm-up, b.Loop, no-emit/quiet/approval settings, read rather than write issue permissions and changed fixture expression. Adoption results cannot be relabeled as this profile.",
      "Adoption make bench uses fixed 3x iterations; frozen daily agent uses 2s. Independent protected CGO bench still uses make bench with 3x iterations.",
      "The source Make command pipes through tee without pipefail. Command success is not benchmark or correctness acceptance.",
      "Source history keeps only 14 entries at frozen revision, uses an integer-only timing parser and may silently omit decimal rows. Original raw results are required.",
      "CGO benchmark artifacts retain 14 days; protected unit results retain 7 days. Retention expiry is missingness, not evidence that latency was zero.",
      "Protected producer source configuration is not evidence that a protected benchmark or any correctness check actually ran at a historical head.",
      "Compiled daily workflow uploads repo-memory and agent logs, not an explicit protected raw bench-results artifact; both adoption and frozen agent jobs use ubuntu-latest without a pinned Go setup. Its memory payload and successful job cannot establish a controlled original latency profile.",
    ],
    antecedent: "Compilation latency pre-existed the workflow; the exact benchmark file was introduced with it. Earlier raw native evidence and controlled context are not supplied; historical reconstruction remains open.",
    retainedMeasure: "Simple native latency facet only; target attainment, full safeguards, downstream contribution and workflow keep/change rating are separate.",
    scopeNotImplementedAsOutcome: [
      "Complex and MCP compilation, allocations, parse/validation/YAML/CLI-helper outcomes.",
      "Native before/after measurements bound to verified downstream implementation, graph edges and original creation receipts.",
      "Full correctness/regression acceptance and unchanged opportunity/execution context.",
    ],
  },
  investigation: {
    inventoryComplete: proof.history.index.complete,
    inventoryEntities: proof.history.index.totalEntities,
    directEntities: proof.history.direct.length,
    directIssues: proof.history.direct.filter(row => row.kind === "Issue").length,
    directPullRequests: proof.history.direct.filter(row => row.kind === "PullRequest").length,
    referencedRuns: proof.coverage.distinctReferencedRuns,
    relatedCandidateClosureEntities: proof.history.closure.length,
    unresolvedCandidateNumbers: proof.history.missingCandidateNumbers,
    graphRule: "Full undirected transitive closure of retained body candidate references from every directly marked output. Discovery only; not accepted graph relationships or contribution.",
    availableSources: proof.sources.filter(row => row.status === "available").length,
    sourceGaps,
    exactAcquisitionNeeds: proof.acquisitionNeeds.length,
    originalRequestsCompleted: proof.acquisitionLedger.completed.length,
    pendingPlanRequests: proof.acquisitionNeeds.filter(row => !row.status).length,
    pendingPages: proof.acquisitionLedger.pendingPages,
    discoveryHistoryComplete: false,
    endpointManifest: `${root}/investigation.json.gz#acquisitionNeeds`,
    lineageLimitations: proof.history.limitations,
    access: "Read-only local immutable Git plus digest-verified retained output history/coordinator sources. Worker performed exactly three authorized discovery GETs and four authorized original-receipt GETs; actual headers and original bodies retained. No pagination, dispatch, credential changes or fetched-code execution.",
  },
  result: {
    periods: timeline.snapshots.length,
    firstPeriod: timeline.snapshots[0].window,
    lastPeriod: timeline.snapshots.at(-1).window,
    acceptedNativePeriods: native.length,
    acceptedHistoricalBenchmarkRecords: proof.nativeEvidence.length,
    reportedNanosecondsPerCompile: native.length ? native.at(-1).metrics["simple-compile-latency"] : null,
    originalElapsedNanoseconds: null,
    originalBenchmarkIterations: replay?.nativeDiagnostic.completedBenchmarkIterations ?? null,
    originalBenchmarkDiagnostic: replay?.nativeDiagnostic ?? null,
    protectedNativeFailures: replay?.protectedCorrectness.nativeFailureEvents ?? [],
    workflowLinkedDeliveredGain: null, nativeImprovement: null, fullGoalAcceptance: null,
    recentComparison: timeline.metricReview.metrics[0].recentComparison.status,
    adoptionComparison: timeline.metricReview.metrics[0].adoptionComparison.status,
    decision: timeline.valueReview.decision,
    cost: "not measured", savedTime: "not estimated",
    fixtureCredit: false,
    plot: `${reportRoot}/daily-cli-performance-pulse.html`,
    plotData: `${reportRoot}/daily-cli-performance-pulse.json`,
    originalDiagnosticPlot: replay ? `${reportRoot}/daily-cli-performance-native-diagnostic.html` : null,
    definitionsArtifact: retainedDefinitions,
    pulseSchemaVersion: pulse.schemaVersion,
    interpretation: "All accepted historical latency values are unavailable. One original native benchmark diagnostic is preserved independently; it does not prove successful fixture compilation. Missing acceptance is not zero delivered work or proof of full success. No keep/retire conclusion, trend or causal claim is supported.",
  },
  readiness: {
    nativeFunctionImplemented: true,
    actualOfflineCollectorVerified: true,
    nativePositiveNegativeBoundaryTests: true,
    deterministicEvaluationAndPlot: true,
    originalNativeHistoricalEvidence: replay !== null,
    acceptedNativeHistoricalLatency: false,
    sourceClosureComplete: sourceGaps.length === 0,
    fullHistoricalEvidenceScopeComplete: false,
    acceptedWorkflowContribution: false,
    fullGoalAcceptance: false,
    portfolioMeasuredValueCredit: false,
  },
  validation: {
    tests: "node --test tests/unit/daily-cli-performance-value.test.mjs",
    collector: `node .github/skills/add-operational-value/scripts/verify-value-function.mjs --collector ${functionPath}`,
    lint: `npx --no-install eslint scripts/collect-daily-cli-performance-proof.mjs scripts/report-daily-cli-performance-proof.mjs scripts/discover-daily-cli-performance-native.mjs scripts/replay-daily-cli-performance-native.mjs ${functionPath}`,
    repositoryTypecheck: "Passed: npm run typecheck:cao after restoring declared dependencies with npm ci. No manifest or registry configuration changed.",
    workflowCompilation: "Passed: npm run compile, 72 workflows succeeded; no lock writes.",
    documentationBuild: "Passed: npm run docs:build, 79 pages; routing/context limit retained (64958/65536 bytes). Generated Markdown definitions preserved byte-for-byte as .md.txt to avoid accidental public routing ingestion.",
    reportIdentity: "Definition, function SHA256, source Git blob/SHA256, provider payload, all period scores, contiguous cohort boundaries and source provenance checked by this script.",
  },
  seedDependency: {
    archiveSha256: "b51243e0777815f56b9e782825af50256d1b9ea68470857c7873a8a3275188ea",
    manifestSha256: "f38fb273e21b5114c9181836974cfa179b5b188e11d9e94258057fab39301ae3",
    version: "0.18.0",
    ownership: "Shared seed files excluded from worker handoff; executable entrypoint modes were needed locally by the evaluator.",
  },
};
writeCensusJson(`${root}/analysis.json.gz`, report);
console.log(JSON.stringify({ functionSha256, periods: report.result.periods,
  acceptedNativePeriods: native.length, sourceGaps: sourceGaps.length,
  report: `${root}/analysis.json.gz` }));
