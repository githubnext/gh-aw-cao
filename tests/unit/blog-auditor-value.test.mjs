import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { readJsonArchive } from "../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { discoverBlogCandidates, scope } from "../../scripts/collect-blog-auditor-value.mjs";
import { assessCapture, capturePayload, collectBatch, definition, scoreMetric, workflowSnippet }
  from "../../docs/operational-value/proof/functions/blog-auditor.mjs";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const capture = () => structuredClone(definition.validationExamples.targetAttained.captures[0]);
const seal = row => {
  row.captureReceipt.payloadSha256 = digest(capturePayload(row));
  return row;
};

const inventory = entities => ({
  index: {
    repository: scope.repository, repositoryId: scope.repositoryId,
    sourceRevision: scope.revision, until: scope.cutoff, complete: true,
    workflows: [{ id: "blog-auditor", path: scope.sourcePath, gitBlob: scope.sourceBlob }],
  },
  entities,
});

test("blog discovery exhausts both directions and downstream transitive references", () => {
  const result = discoverBlogCandidates(inventory([
    { number: 6, relatedCandidates: [5] },
    { number: 5, relatedCandidates: [2] },
    { number: 1, workflowReference: { workflowId: "blog-auditor" }, relatedCandidates: [2] },
    { number: 2, relatedCandidates: [3] },
    { number: 4, workflowReference: { workflowId: "different" }, relatedCandidates: [] },
  ]));
  assert.deepEqual(result.seedNumbers, [1]);
  assert.deepEqual(result.candidates.map(row => row.number), [6, 5, 1, 2]);
  assert.deepEqual(result.unresolvedReferences, [3]);
  assert.equal(result.nativeEvidence.length, 0);
  assert.equal(result.coverage.historicalPageState, "missing");
});

test("blog discovery rejects wrong immutable identity and malformed graph references", () => {
  const history = inventory([]);
  history.index.repositoryId++;
  assert.throws(() => discoverBlogCandidates(history), /frozen blog scope/);
  assert.throws(() => discoverBlogCandidates(inventory([
    { number: 1, workflowReference: { workflowId: "blog-auditor" }, relatedCandidates: ["2"] },
  ])), /Invalid discovery reference/);
});

test("complete empty discovery is not native zero delivery", () => {
  const result = discoverBlogCandidates(inventory([]));
  assert.equal(result.coverage.survivingIssuePrInventory, "complete");
  assert.equal(result.coverage.historicalPageState, "missing");
  assert.deepEqual(result.nativeEvidence, []);
});

test("retained production discovery remains explicitly unmeasured and identity-bound", () => {
  const retained = readJsonArchive(fileURLToPath(new URL(
    "../../docs/operational-value/proof/blog-auditor/discovery.json.gz", import.meta.url,
  )));
  assert.equal(retained.scope.sourceBlob, scope.sourceBlob);
  assert.equal(retained.historyIndex.totalEntities, 58048);
  assert.equal(retained.historyIndex.partitions.length, 346);
  assert.equal(retained.seedNumbers.length, 8);
  assert.equal(retained.candidates.length, 10);
  assert.deepEqual(retained.unresolvedReferences, []);
  assert.deepEqual(retained.nativeEvidence, []);
  assert.equal(retained.coverage.snippetCompilation, "missing");
});

test("page predicates enforce exact 5000/5001 boundary, domain and native keyword rules", () => {
  const row = capture();
  row.snapshot = "agentic workflows GitHub workflow compile".padEnd(5000, "x");
  assert.equal(row.snapshot.length, 5000);
  assert.equal(assessCapture(seal(row)).pagePassed, 3);
  row.snapshot += "x";
  assert.equal(assessCapture(seal(row)).pagePassed, 4);
  row.finalUrl = "https://githubnext.com.evil.example/projects/agentic-workflows/";
  assert.equal(assessCapture(seal(row)).pagePassed, 3);
  row.finalUrl = "https://githubnext.com@evil.example/";
  assert.equal(assessCapture(seal(row)).pagePassed, 3);
  row.finalUrl = "https://www.githubnext.com/projects/agentic-workflows/";
  assert.equal(assessCapture(seal(row)).pagePassed, 4);
  row.status = 301;
  assert.equal(assessCapture(seal(row)).pagePassed, 3);
});

test("native snippet predicate excludes prose, unsupported languages and nested config", () => {
  assert.equal(workflowSnippet({ language: "markdown", text: "---\non: push\n---\nbody" }), true);
  assert.equal(workflowSnippet({ language: "yaml", text: "---\ntools: {}\n---" }), true);
  assert.equal(workflowSnippet({ language: "javascript", text: "---\non: push\n---" }), false);
  assert.equal(workflowSnippet({ language: "yaml", text: "on: push" }), false);
  assert.equal(workflowSnippet({ language: "yaml", text: "---\ncustom:\n  on: push\n---" }), false);
  assert.equal(workflowSnippet({ language: "yaml", text: "---\ntitle: tools\n---" }), false);
});

test("partial native coverage survives missing snippet and attribution evidence", () => {
  const row = capture();
  row.codeBlocks = null;
  row.snippetChecks = [];
  row.contribution = null;
  const evidence = { ...definition.validationExamples.targetMissed, captures: [seal(row)] };
  assert.equal(scoreMetric("page-checks", evidence), 4);
  assert.equal(scoreMetric("passing-page-checks", evidence), 4);
  assert.equal(scoreMetric("validated-snippets", evidence), null);
  assert.equal(scoreMetric("complete-checkpoints", evidence), null);
  assert.equal(scoreMetric("linked-page-checks", evidence), null);
  const latestMissing = capture();
  delete latestMissing.latestSchemaReceipt;
  assert.equal(scoreMetric("complete-checkpoints", { ...evidence, captures: [latestMissing] }), null);
  assert.equal(scoreMetric("page-checks", { ...evidence, captures: [latestMissing] }), 4);
});

test("compiler results are independent, exhaustive and bound to actual snippet bytes", () => {
  const row = capture();
  assert.equal(assessCapture(row).allPassed, true);
  row.snippetChecks[0].snippetSha256 = "0".repeat(64);
  assert.throws(() => assessCapture(row), /compiler observation/);
  const incomplete = capture();
  incomplete.snippetChecks = [];
  assert.equal(assessCapture(incomplete).allKnown, false);
  const empty = capture();
  empty.codeBlocks = [];
  empty.snippetChecks = [];
  assert.equal(assessCapture(seal(empty)).eligibleSnippets, 0);
  assert.equal(assessCapture(empty).allKnown, true);
});

test("unprotected claims and repeated weekly captures never become delivery", () => {
  const row = capture();
  row.captureReceipt.kind = "agent-report";
  assert.throws(() => assessCapture(row), /independent browser capture/);
  const evidence = structuredClone(definition.validationExamples.targetAttained);
  evidence.captures[1].capturedAt = evidence.captures[0].capturedAt;
  seal(evidence.captures[1]);
  assert.equal(scoreMetric("page-checks", evidence), null);
  assert.equal(scoreMetric("page-checks", { ...evidence, captures: [row] }), null);
});

test("production collector emits explicit unavailable assessments without fixture leakage", async () => {
  const [result] = await collectBatch([{
    windowStart: "2026-10-11T15:00:12Z", windowEnd: "2026-10-18T15:00:12Z",
    observedAt: "2026-10-18T15:00:12Z",
  }]);
  assert.equal(result.evidence.coverageStatus, "missing");
  assert.deepEqual(result.evidence.captures, []);
  assert.ok(result.provenance.length > 0);
  for (const metric of definition.metrics) assert.equal(scoreMetric(metric.id, result.evidence), null);
});

test("batch collector deduplicates first capture independently of verdict and honors half-open windows", async () => {
  const directory = mkdtempSync(path.join(process.cwd(), ".blog-value-fixture-"));
  try {
    const first = capture();
    const second = capture();
    second.capturedAt = "2026-10-02T12:00:00Z";
    seal(second);
    const file = path.join(directory, "observations.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, repository: scope.repository,
      revision: scope.revision, coverageStatus: "partial", captures: [second, first] }));
    const requests = [
      { windowStart: "2026-09-30T11:26:00Z", windowEnd: "2026-10-02T12:00:00Z",
        observedAt: "2026-10-15T00:00:00Z" },
      { windowStart: "2026-10-02T12:00:00Z", windowEnd: "2026-10-08T12:00:00Z",
        observedAt: "2026-10-15T00:00:00Z" },
      { windowStart: "2026-09-30T11:26:00Z", windowEnd: "2026-10-01T12:00:00Z",
        observedAt: "2026-10-15T00:00:00Z" },
    ];
    const results = await collectBatch(requests, { archive: file });
    assert.equal(results[0].evidence.captures.length, 1);
    assert.equal(results[1].evidence.captures.length, 0);
    assert.equal(results[2].evidence.captures.length, 0);
    assert.equal(results[0].evidence.eligibleCount, 1);
    assert.equal(results[1].evidence.eligibleCount, 1);
    first.captureReceipt.payloadSha256 = "0".repeat(64);
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, repository: scope.repository,
      revision: scope.revision, coverageStatus: "partial", captures: [first] }));
    await assert.rejects(collectBatch(requests, { archive: file }), /capture or payload/);
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, repository: scope.repository,
      revision: scope.revision, coverageStatus: "complete", captures: [], coverage: [{
        windowStart: "2026-09-30T11:26:00Z", windowEnd: "2026-10-15T00:00:00Z",
        status: "complete", authorityRef: `sha256:${"e".repeat(64)}`,
      }] }));
    const [knownEmpty] = await collectBatch(requests, { archive: file });
    assert.equal(knownEmpty.evidence.coverageStatus, "complete");
    assert.equal(knownEmpty.evidence.eligibleCount, 1);
    assert.equal(scoreMetric("page-checks", knownEmpty.evidence), 0);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("lossless full source closure verifies every retained immutable blob", () => {
  const source = readJsonArchive(fileURLToPath(new URL(
    "../../docs/operational-value/proof/blog-auditor/source.json.gz", import.meta.url,
  )));
  assert.equal(source.sources.length, 10);
  for (const row of source.sources) {
    const bytes = Buffer.from(row.content, "base64");
    assert.equal(bytes.length, row.bytes);
    assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), row.gitBlob);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), row.sha256);
  }
  assert.equal(source.adoption.parentTree, "");
});

test("approved original import and compiled source retain full provider payload and native identities", () => {
  for (const id of ["df3ea140fda9a2e77f44426d64b58e7fd22b383e", "61296b06dd6643ed2f0ecedcb50b0e2ae7bfee83"]) {
    const receipt = readJsonArchive(fileURLToPath(new URL(
      `../../docs/operational-value/proof/blog-auditor/adoption-${id}.json.gz`, import.meta.url,
    )));
    const responseBytes = Buffer.from(receipt.response, "base64");
    const content = Buffer.from(receipt.content, "base64");
    assert.equal(receipt.status, 200);
    assert.equal(createHash("sha256").update(responseBytes).digest("hex"), receipt.responseSha256);
    assert.equal(createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex"), id);
    assert.equal(createHash("sha256").update(content).digest("hex"), receipt.sha256);
    assert.equal(Buffer.from(JSON.parse(responseBytes).content, "base64").equals(content), true);
    assert.equal(receipt.headers["retry-after"], undefined);
    assert.ok(Number(receipt.headers["x-ratelimit-remaining"]) > 0);
  }
});

test("reports bind current function, source and native units without overlapping delivery cohorts", () => {
  const root = fileURLToPath(new URL("../../docs/operational-value/proof/blog-auditor/reports/github-gh-aw/", import.meta.url));
  const timeline = readJsonArchive(path.join(root, "blog-auditor-timeline.json"));
  const pulse = readJsonArchive(path.join(root, "blog-auditor-pulse.json"));
  const archive = readJsonArchive(path.join(root, "blog-auditor-evidence-archive.json"));
  const functionPath = fileURLToPath(new URL("../../docs/operational-value/proof/functions/blog-auditor.mjs", import.meta.url));
  const functionHash = createHash("sha256").update(readFileSync(functionPath)).digest("hex");
  assert.equal(timeline.valueFunction.sha256, functionHash);
  assert.equal(pulse.valueFunctionSha256, functionHash);
  assert.ok(readFileSync(path.join(root, "blog-auditor-pulse.html"), "utf8").includes(functionHash));
  const sourceFile = fileURLToPath(new URL("../../docs/operational-value/proof/blog-auditor/source.json.gz", import.meta.url));
  assert.equal(createHash("sha256").update(readFileSync(sourceFile)).digest("hex"), definition.source.closureSha256);
  assert.deepEqual(timeline.valueFunction.definition, definition);
  assert.ok(archive.functions[functionHash]);
  assert.equal(timeline.snapshots.length, 52);
  assert.equal(timeline.window.endAt, scope.cutoff);
  for (const [index, snapshot] of timeline.snapshots.entries()) {
    if (index) assert.equal(timeline.snapshots[index - 1].window.endAt, snapshot.window.startAt);
    assert.deepEqual(snapshot.evidence.captures, []);
    if (snapshot.evidence.eligibleCount > 0) {
      for (const value of Object.values(snapshot.metrics)) assert.equal(value, null);
    } else {
      assert.equal(snapshot.evidence.maturityStatus, "interim");
      assert.equal(snapshot.evidence.dubious, true);
    }
  }
  assert.equal(pulse.signal.status, "insufficient-evidence");
  assert.equal(pulse.signal.attention, "evidence-needed");
  for (const metric of pulse.metrics) {
    assert.equal(metric.unit, definition.metrics.find(row => row.id === metric.id).unit);
  }
});
