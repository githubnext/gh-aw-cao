import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  inspectClaudeBarrier, inspectConsolidation, inspectUnbloat,
} from "../../docs/operational-value/proof/doc-consolidation/native-oracle.mjs";
import { readCustody, custodyDirectory } from "../../docs/operational-value/proof/doc-consolidation/custody-reader.mjs";
import { inspectCases } from "../../scripts/native-doc-consolidation.mjs";
import * as claude from "../../docs/operational-value/proof/functions/claude-code-user-docs-review.mjs";
import * as developer from "../../docs/operational-value/proof/functions/developer-docs-consolidator.mjs";
import * as unbloat from "../../docs/operational-value/proof/functions/unbloat-docs.mjs";

const bytes = text => Buffer.from(text);
const filename = "docs/src/content/docs/reference/example.md";

test("exact repeated prose removal preserves all distinct content in order", () => {
  const original = bytes("---\ntitle: Example\n---\n\n# Setup\n\nUse the standard engine.\n\nUse the standard engine.\n\nKeep the required secret.\n");
  const reduced = bytes("---\ntitle: Example\n---\n\n# Setup\n\nUse the standard engine.\n\nKeep the required secret.\n");
  assert.deepEqual(inspectUnbloat(original, reduced, filename),
    { status: "verified", removed: 1, fullGoal: null, usability: null, semanticAccuracy: null });
  assert.equal(inspectUnbloat(reduced, reduced, filename).removed, 0);
});

test("line reduction, merge-like claims, and semantic paraphrase are not content preservation", () => {
  const before = bytes("# Setup\n\nUse the standard engine.\n\nKeep the required secret.\n");
  for (const after of [
    "# Setup\n\nUse the engine.\n", "# Setup\n\nUse the standard engine.\n",
    "# Setup\n\nKeep the required secret.\n\nUse the standard engine.\n",
  ]) {
    const result = inspectUnbloat(before, bytes(after), filename);
    assert.equal(result.removed, null);
    assert.equal(result.status, "unverified");
  }
});

test("context, metadata, warnings, links and fenced content are not redundant disposable prose", () => {
  const examples = [
    ["# A\n\nSame facts.\n\n# B\n\nSame facts.\n", "# A\n\nSame facts.\n\n# B\n"],
    ["# A\n\nWarning: save the token.\n\nWarning: save the token.\n", "# A\n\nWarning: save the token.\n"],
    ["# A\n\n[Setup](./setup.md)\n\n[Setup](./setup.md)\n", "# A\n\n[Setup](./setup.md)\n"],
    ["# A\n\n```mermaid\ngraph TD\n```\n\n```mermaid\ngraph TD\n```\n", "# A\n\n```mermaid\ngraph TD\n```\n"],
    ["---\ntitle: Before\n---\n\nFacts.\n\nFacts.\n", "---\ntitle: After\n---\n\nFacts.\n"],
    ["# A\n\n## Common\n\nFacts.\n\n# B\n\n## Common\n\nFacts.\n", "# A\n\n## Common\n\nFacts.\n\n# B\n\n## Common\n"],
  ];
  for (const [before, after] of examples) assert.equal(inspectUnbloat(bytes(before), bytes(after), filename).removed, null);
});

test("excluded and protected files stay ineligible", () => {
  const original = bytes("Facts.\n\nFacts.\n"), reduced = bytes("Facts.\n");
  for (const file of ["README.md", "docs/src/content/docs/blog/post.md", "docs/src/content/docs/reference/frontmatter-full.md"]) {
    assert.equal(inspectUnbloat(original, reduced, file).status, "ineligible");
  }
  assert.equal(inspectUnbloat(bytes("---\ndisable-agentic-editing: true\n---\n\nFacts.\n\nFacts.\n"),
    bytes("---\ndisable-agentic-editing: true\n---\n\nFacts.\n"), filename).status, "ineligible");
});

test("malformed native bytes and unterminated syntax fail explicitly", () => {
  assert.throws(() => inspectUnbloat(Buffer.from([255]), bytes(""), filename));
  assert.throws(() => inspectUnbloat(bytes("```go\nx"), bytes(""), filename), /Unterminated/);
  assert.throws(() => inspectUnbloat(bytes("---\ntitle: x"), bytes(""), filename), /Unterminated/);
  assert.throws(() => inspectUnbloat(bytes("x\r\n"), bytes(""), filename), /encoding/);
  assert.throws(() => inspectUnbloat("facts", bytes(""), filename), /bytes/);
});

test("consolidation requires exact retained target and distinct source facts", () => {
  const files = [
    { path: "scratchpad/a.md", before: bytes("Common guidance.\n\nSpecific guidance.\n"), after: bytes("Specific guidance.\n") },
    { path: "specs/b.md", before: bytes("Common guidance.\n"), after: bytes("Common guidance.\n") },
    { path: "scratchpad/dev.md", before: null, after: bytes("# Developer Instructions\n\nCommon guidance.\n") },
  ];
  assert.equal(inspectConsolidation(files).removed, 1);
  assert.equal(inspectConsolidation(files).fullGoal, null);
  assert.equal(inspectConsolidation(files.slice(0, 2)).removed, null);
  assert.equal(inspectConsolidation(files.map(file => file.path === "scratchpad/a.md" ? { ...file, after: bytes("") } : file)).removed, null);
  assert.equal(inspectConsolidation(files.map(file => file.path === "scratchpad/dev.md" ? { ...file, after: bytes("Paraphrased guidance.\n") } : file)).removed, null);
});

test("Claude mentions, neutral labels and report discovery cannot substitute for proven barrier repair", () => {
  assert.equal(inspectClaudeBarrier({ before: "Copilot CLI", after: "Agent CLI", merged: true }).repaired, null);
  assert.equal(inspectClaudeBarrier({ before: "", after: "engine: claude\nANTHROPIC_API_KEY" }).status, "missing");
});

test("real originals establish one narrower Claude setup repair, not full usability or attribution", () => {
  const custody = readCustody();
  assert.equal(custody.discovery.entities.length, 58048);
  assert.equal(custody.discovery.index.partitions.length, 346);
  const cases = inspectCases(custody), auth = cases.find(item => item.id === "claude-wizard-auth-67624");
  assert.equal(auth.native.repaired, 1);
  assert.equal(auth.fullGoal, null);
  assert.equal(auth.attribution.status, "unknown");
  assert.equal(cases.find(item => item.id === "pr-69710").native.removed, 0);
  assert.equal(cases.find(item => item.id === "pr-11890").native.status, "ineligible");
  assert.equal(cases.find(item => item.id === "pr-12233").native.status, "ineligible");
  assert.equal(cases.find(item => item.id === "claude-quickstart-32016").native.repaired, null);
  const item = custody.archive.cases.find(item => item.id === auth.id);
  const files = item.files.map(file => ({ path: file.path,
    before: custody.resolve(item.parent, file.path), after: custody.resolve(item.commit, file.path) }));
  const support = item.support.map(record => ({ path: record.path, ...custody.resolve(item.commit, record.path) }));
  assert.equal(inspectClaudeBarrier(files, support).repaired, 1);
  assert.equal(inspectClaudeBarrier(files, []).repaired, null);
  const changed = files.map(file => file.path.endsWith("/cli.md") ? { ...file,
    after: { ...file.after, bytes: bytes(file.after.bytes.toString().replaceAll("ANTHROPIC_API_KEY", "WRONG_KEY")) } } : file);
  assert.equal(inspectClaudeBarrier(changed, support).repaired, 0);
  const alteredSupport = support.map(file => file.path === "pkg/constants/engine_constants.go"
    ? { ...file, bytes: bytes(file.bytes.toString().replace('AnthropicAPIKey = "ANTHROPIC_API_KEY"', 'AnthropicAPIKey = "WRONG_KEY"')) } : file);
  assert.equal(inspectClaudeBarrier(files, alteredSupport).repaired, null);
  const repeated = files.map(file => ({ ...file, before: file.after }));
  assert.equal(inspectClaudeBarrier(repeated, support).repaired, 0);
});

test("production request shape preserves disjoint cutoff-aligned counts, gaps and native zero", async () => {
  const requests = [
    { observedAt: "2026-10-11T15:00:12Z", windowStart: "2026-10-04T15:00:12Z", windowEnd: "2026-10-11T15:00:12Z" },
    { observedAt: "2026-10-18T15:00:12Z", windowStart: "2026-10-11T15:00:12Z", windowEnd: "2026-10-18T15:00:12Z" },
  ];
  const collected = await claude.collectBatch(requests);
  assert.equal(collected.length, 2);
  assert.equal(claude.scoreMetric("native-improvements", collected[0].evidence), 1);
  assert.equal(claude.scoreMetric("native-improvements", collected[1].evidence), null);
  assert.equal(claude.scoreMetric("full-goal", collected[0].evidence), null);
  assert.equal(claude.scoreMetric("workflow-contribution", collected[0].evidence), null);
  assert.equal(collected[0].evidence.coverageStatus, "partial");
  assert.equal(collected[1].evidence.coverageStatus, "missing");
  assert.equal(collected[0].evidence.workflowIntroductionVerified, true);
  assert.equal(collected[0].evidence.discovery.discussionsComplete, false);
  assert.equal(claude.scoreMetric("native-improvements", { ...collected[0].evidence, nativeUnits: 99 }), null);
  const [latestDeveloper] = await developer.collectBatch([requests[1]]);
  assert.equal(developer.scoreMetric("native-improvements", latestDeveloper.evidence), 0);
  assert.equal(developer.scoreMetric("full-goal", latestDeveloper.evidence), null);
  const [latestUnbloat] = await unbloat.collectBatch([requests[1]]);
  assert.equal(unbloat.scoreMetric("native-improvements", latestUnbloat.evidence), null);
  assert.notEqual(collected[0].evidence.populationDigest, collected[1].evidence.populationDigest);
  for (const result of collected) assert.ok(result.provenance.length >= 3);
});

test("source, clock, unsupported scope and malformed requests fail closed", async () => {
  const valid = { observedAt: "2026-10-18T15:00:12Z", windowStart: "2026-10-11T15:00:12Z", windowEnd: "2026-10-18T15:00:12Z" };
  for (const request of [
    { ...valid, observedAt: "2026-10-19T15:00:12Z" },
    { ...valid, observedAt: valid.windowStart },
    { ...valid, windowStart: valid.windowEnd },
    { ...valid, windowStart: "2026-02-30T00:00:00Z" },
    { ...valid, repository: "example/other" },
    { ...valid, observedAt: null },
  ]) await assert.rejects(claude.collectBatch([request]), /source, clock or observation window/);
  await assert.rejects(claude.collectBatch({}), /batch array/);
  assert.equal(claude.scoreMetric("native-improvements", null), null);
  assert.equal(claude.scoreMetric("native-improvements", developer.definition.validationExamples.targetAttained), null);
});

test("native commit boundaries are inclusive/exclusive and ineligible candidates are not opportunities", async () => {
  const boundary = "2026-10-11T05:30:18Z";
  const results = await claude.collectBatch([
    { observedAt: boundary, windowStart: "2026-10-10T05:30:18Z", windowEnd: boundary },
    { observedAt: "2026-10-12T05:30:18Z", windowStart: boundary, windowEnd: "2026-10-12T05:30:18Z" },
  ]);
  assert.equal(claude.scoreMetric("native-improvements", results[0].evidence), null);
  assert.equal(claude.scoreMetric("native-improvements", results[1].evidence), 1);
  const [excluded] = await unbloat.collectBatch([{ observedAt: "2026-01-27T00:00:00Z",
    windowStart: "2026-01-26T00:00:00Z", windowEnd: "2026-01-27T00:00:00Z" }]);
  assert.equal(excluded.evidence.candidateCount, 1);
  assert.equal(excluded.evidence.eligibleCount, 0);
  assert.equal(unbloat.scoreMetric("native-improvements", excluded.evidence), null);
  const replayed = await claude.collectBatch([{ observedAt: "2026-10-12T05:30:18Z", windowStart: boundary,
    windowEnd: "2026-10-12T05:30:18Z" }]);
  assert.deepEqual(replayed[0], results[1]);
});

test("original mutation or custody scope mutation is an explicit error, never fabricated missing", async () => {
  const temporary = mkdtempSync(path.join(process.cwd(), ".doc-consolidation-test-"));
  try {
    const archive = JSON.parse(readFileSync(path.join(custodyDirectory, "custody.json")));
    const first = Object.values(archive.objects)[0].parts[0];
    mkdirSync(path.join(temporary, "originals"));
    copyFileSync(path.join(custodyDirectory, "custody.json"), path.join(temporary, "custody.json"));
    const altered = readFileSync(path.join(custodyDirectory, first.path));
    altered[0] ^= 1;
    writeFileSync(path.join(temporary, first.path), altered);
    assert.throws(() => readCustody(temporary), /integrity mismatch/);
    await assert.rejects(claude.collectBatch([{ observedAt: "2026-10-18T15:00:12Z",
      windowStart: "2026-10-11T15:00:12Z", windowEnd: "2026-10-18T15:00:12Z" }], { custodyDirectory: temporary }), /integrity mismatch/);
    writeFileSync(path.join(temporary, "custody.json"), JSON.stringify({ ...archive, repositoryId: 1 }));
    assert.throws(() => readCustody(temporary), /scope mismatch/);
  } finally {
    rmSync(temporary, { recursive: true });
  }
});
