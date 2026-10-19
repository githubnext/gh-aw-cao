import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { collectBatch, definition, scoreMetric } from "../../docs/operational-value/proof/functions/smoke-pydantic.mjs";
import { discover, proofRoot, retainOriginal, sha256 } from "../../scripts/collect-smoke-pydantic.mjs";
import {
  assessCanonical, collectNative, decodeCanonicalFrames, epochNs, introduction,
  originalBytes, readZip, safeOwnedPath, validateNativeRun,
  validateRequest, verifiedFile, verifyGitClosure,
} from "../../scripts/native-smoke-pydantic.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const temporary = run => {
  const directory = mkdtempSync(path.join(root, ".smoke-pydantic-test-"));
  try { return run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
};

test("native commit and complete tree chains prove introduction against the actual parent", () => {
  assert.deepEqual(introduction(), {
    commit: "0e301e6777bef1d23305c8031dcd161a642836f5", adoptedAt: "2026-08-07T20:57:43Z",
    baselineCommit: "cc3330af665107c4e4e1b8dbff618ae23b792314", baselineAt: "2026-08-07T20:55:45Z",
  });
  const reference = verifyGitClosure(proofRoot, definition.referenceRevision);
  assert.equal(reference.files.find(file => file.path === definition.sourcePath).id, definition.sourceGitBlob);
  assert.equal(sha256(reference.files.find(file => file.path === definition.sourcePath).bytes),
    "e08f60c28c83b543b12694c91704236e3ceb81a296f8696d17d2d5ab83e116aa");
});

test("source acceptance is historical reconstruction, not ex-ante or causal acceptance", () => {
  assert.match(definition.interpretation, /not ex-ante/);
  assert.equal(definition.schemaVersion, 3);
  assert.equal(definition.evaluation.mode, "attainment-only");
  assert.equal(definition.metrics.filter(metric => metric.role === "primary").length, 1);
  assert.equal(definition.review, undefined);
  assert.equal(definition.contract.primary.actorIndependent, true);
  assert.match(definition.contract.evidencePolicy.decision, /Not rated/);
  assert.equal(definition.bootstrap.regularFiles, 35);
  for (const [relative, expected] of Object.entries(definition.dependencyPins)) {
    assert.equal(sha256(readFileSync(path.join(root, relative))), expected);
  }
});

test("each facet is independently nullable; unknown safeguards do not erase actual native read cases", () => {
  const native = structuredClone(definition.validationExamples.targetAttained);
  native.cases[0].facets.fullGoal = "unknown";
  assert.equal(scoreMetric("native-read-cases", native), 1);
  assert.equal(scoreMetric("full-goal-cases", native), null);
  native.cases[0].facets.read = "unknown";
  assert.equal(scoreMetric("native-read-cases", native), null);
  native.cases[0].facets.read = "failed";
  assert.equal(scoreMetric("native-read-cases", native), 0);
  native.cases.push(structuredClone(native.cases[0]));
  assert.equal(scoreMetric("native-read-cases", native), null);
});

test("native score examples reject missing, malformed, repeated and unknown metric inputs", () => {
  for (const metric of definition.metrics) {
    assert.equal(scoreMetric(metric.id, definition.validationExamples.targetAttained), 1);
    assert.equal(scoreMetric(metric.id, definition.validationExamples.targetMissed), 0);
    assert.equal(scoreMetric(metric.id, definition.validationExamples.missing), null);
    assert.equal(scoreMetric(metric.id, definition.validationExamples.malformed), null);
  }
  assert.equal(scoreMetric("invented", definition.validationExamples.targetAttained), null);
  assert.equal(scoreMetric("native-read-cases", { cases: [{ facets: { read: "passed" } }] }), null);
});

test("production request shape enforces source identity and clock ordering", () => {
  const request = { windowStart: "2026-10-11T15:00:12Z",
    windowEnd: "2026-10-18T15:00:12Z", observedAt: "2026-10-18T15:00:12Z" };
  assert.equal(validateRequest(request), request);
  for (const mutation of [
    { windowStart: request.windowEnd }, { observedAt: "2026-10-17T15:00:12Z" },
    { windowEnd: "not a clock" }, { repository: "other/repo" }, { windowStart: null },
  ]) assert.throws(() => validateRequest({ ...request, ...mutation }), /request or clock/);
});

test("original custody rejects mutated, missing, unsafe and incorrectly reassembled bytes", () => temporary(directory => {
  const bytes = Buffer.from("an original, not a synthetic native result");
  writeFileSync(path.join(directory, "original"), bytes);
  const reference = { path: "original", bytes: bytes.length, sha256: sha256(bytes) };
  assert.deepEqual(verifiedFile(directory, reference), bytes);
  assert.deepEqual(originalBytes(directory, { ...reference, parts: [reference] }), bytes);
  assert.throws(() => verifiedFile(directory, { ...reference, sha256: "0".repeat(64) }), /custody mismatch/);
  assert.throws(() => verifiedFile(directory, { ...reference, path: "missing" }), /ENOENT/);
  assert.throws(() => originalBytes(directory, { ...reference, parts: [reference, reference] }), /custody mismatch/);
  for (const file of ["../original", "/original", "a/../original", "a\\original", "./original"]) {
    assert.throws(() => safeOwnedPath(directory, file), /Unsafe/);
  }
}));

test("larger originals split losslessly without excerpts or replacement", () => temporary(directory => {
  const bytes = Buffer.alloc(600 * 1024, 42);
  const reference = retainOriginal(bytes, "native-original.bin", directory);
  assert.equal(reference.parts.length, 3);
  assert.ok(reference.parts.every(part => part.bytes <= 240 * 1024));
  assert.deepEqual(originalBytes(directory, reference), bytes);
  assert.throws(() => retainOriginal(Buffer.alloc(bytes.length, 43), "native-original.bin", directory),
    /Refusing to replace/);
}));

function zipFixture(name, payload) {
  const encoded = Buffer.from(name);
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(payload), 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(encoded.length, 26);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc32(payload), 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(encoded.length, 28);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + encoded.length, 12);
  end.writeUInt32LE(local.length + encoded.length + payload.length, 16);
  return Buffer.concat([local, encoded, payload, central, encoded, end]);
}

test("native ZIP reader checks complete payload CRC and refuses path traversal", () => {
  const payload = Buffer.from("fixture bytes, never accepted native evidence");
  const zip = zipFixture("trace.json", payload);
  assert.deepEqual(readZip(zip).get("trace.json"), payload);
  const mutated = Buffer.from(zip);
  mutated[30 + Buffer.byteLength("trace.json")] ^= 1;
  assert.throws(() => readZip(mutated), /CRC/);
  assert.throws(() => readZip(zipFixture("../trace.json", payload)), /Unsafe/);
  assert.throws(() => readZip(zip.subarray(0, zip.length - 1)), /directory/);
});

test("run eligibility checks public repository, exact producer, source, inventories and native clocks", () => {
  const publicMetadata = { id: 1036865607, full_name: "github/gh-aw", private: false };
  const run = { id: 1, repository: publicMetadata, path: ".github/workflows/smoke-pydantic.lock.yml",
    head_sha: "a".repeat(40), run_attempt: 1, created_at: "2026-10-17T00:00:00Z",
    run_started_at: "2026-10-17T00:00:01Z", updated_at: "2026-10-17T00:00:02Z",
    status: "completed", event: "schedule" };
  const jobs = { total_count: 1, jobs: [{ id: 2, run_id: 1, steps: [] }] };
  const artifacts = { total_count: 0, artifacts: [] };
  assert.equal(validateNativeRun(run, jobs, artifacts, publicMetadata).id, "1/1");
  for (const mutation of [
    { path: ".github/workflows/engine-conformance.lock.yml" },
    { repository: { ...publicMetadata, private: true } },
    { updated_at: "2026-10-19T00:00:00Z" }, { head_sha: "not a revision" },
    { run_started_at: "2026-10-16T00:00:00Z" }, { run_attempt: 0 },
  ]) assert.throws(() => validateNativeRun({ ...run, ...mutation }, jobs, artifacts, publicMetadata),
    /identity, public authority, source or clock/);
  assert.throws(() => validateNativeRun(run, { ...jobs, total_count: 2 }, artifacts, publicMetadata), /jobs/);
  assert.throws(() => validateNativeRun(run, jobs, { total_count: 1, artifacts: [] }, publicMetadata), /artifact/);
});

const fixtureRun = { startedAt: "2026-10-17T00:00:00Z", completedAt: "2026-10-17T00:01:00Z" };
const frameKey = "1".repeat(32);
function canonicalFixture({ tool = "read_file", file = "README.md",
  output = "# GitHub Agentic Workflows\nmore fixture bytes", success = true,
  toolClock = "2026-10-17T00:00:03Z", input } = {}) {
  const event = (type, data, at) => ({ type, data, timestamp: `2026-10-17T00:00:0${at}Z` });
  const events = [
    event("session.init", { sourceEngine: "pydantic-ai", cwd: "/fixture/gh-aw" }, 0),
    event("assistant.message", { content: "4" }, 1),
    event("tool.execution_start", { toolCallId: "read-1", toolName: tool, input: input ?? { path: file } }, 2),
    { type: "tool.execution_complete", timestamp: toolClock,
      data: { toolCallId: "read-1", toolName: tool, success, status: success ? "success" : "error", output } },
    event("tool.execution_start", { toolCallId: "mcp-1", toolName: "create_issue", input: {} }, 4),
    event("tool.execution_complete", { toolCallId: "mcp-1", toolName: "create_issue",
      success: true, status: "success", output: { content: [] } }, 5),
  ];
  return `\x1eGH-AW-SESSION-KEY:${frameKey}\x1e\n${events.map(value =>
    `\x1eGH-AW-SESSION/${frameKey} ${JSON.stringify(value)}`).join("\n")}\n`;
}

test("source-native canonical checker keeps independent read, inference and MCP facets separate", () => {
  const result = assessCanonical(canonicalFixture(), Buffer.from("# GitHub Agentic Workflows\n"), fixtureRun);
  assert.equal(result.facets.read, "passed");
  assert.equal(result.facets.inference, "passed");
  assert.equal(result.facets.mcpAvailability, "passed");
  assert.equal(result.facets.contribution, "passed");
  assert.equal(result.facets.fullGoal, "unknown");
  assert.equal(result.facets.transport, "unknown");
  assert.equal(result.facets.safeOutputPersistence, "unknown");
});

test("guessed quote, arithmetic, shell read, wrong file, wrong bytes and future results cannot prove the native read", () => {
  const readme = Buffer.from("# GitHub Agentic Workflows\n");
  for (const change of [{ tool: "run_command" }, { file: "../README.md" },
    { file: "other/README.md" }, { toolClock: "2026-10-19T00:00:00Z" }]) {
    assert.equal(assessCanonical(canonicalFixture(change), readme, fixtureRun).facets.read, "unknown");
  }
  assert.equal(assessCanonical(canonicalFixture({ output: "guessed line" }), readme, fixtureRun).facets.read, "failed");
  assert.equal(assessCanonical(canonicalFixture({ success: false }), readme, fixtureRun).facets.read, "failed");
  const claimed = `An agent says read_file returned # GitHub Agentic Workflows and 4.\n`;
  assert.equal(assessCanonical(claimed, readme, fixtureRun).facets.read, "unknown");
  const forged = canonicalFixture().replaceAll(`SESSION/${frameKey}`, `SESSION/${"2".repeat(32)}`);
  assert.equal(decodeCanonicalFrames(forged).events.length, 0);
});

test("native microsecond clocks retain exact boundary ordering", () => {
  assert.equal(epochNs("2026-10-17T00:04:46.177598Z") - epochNs("2026-10-17T00:04:46.177597Z"), 1000n);
  assert.throws(() => validateRequest({ windowStart: "2026-10-17T00:04:46.177598Z",
    windowEnd: "2026-10-17T00:04:46.177597Z", observedAt: "2026-10-18T15:00:12Z" }), /clock/);
  assert.throws(() => epochNs("2026-02-30T00:00:00Z"), /clock/);
});

test("damaged canonical frames cannot establish complete-trace absence", () => {
  const end = `\x1eGH-AW-SESSION/${frameKey} ${JSON.stringify({
    type: "session.result", timestamp: "2026-10-17T00:00:06Z", data: { sourceType: "pydantic-ai" },
  })}\n`;
  const readme = Buffer.from("# GitHub Agentic Workflows\n");
  const log = canonicalFixture({ tool: "run_code", input: { code: "2 + 2" }, output: "4" }) + end;
  assert.equal(assessCanonical(log, readme, fixtureRun).facets.read, "failed");
  assert.equal(assessCanonical(`${log}\x1eGH-AW-SESSION/${frameKey} {broken}\n`, readme, fixtureRun).facets.read, "unknown");
  const lateInit = canonicalFixture().replace(
    '"cwd":"/fixture/gh-aw"},"timestamp":"2026-10-17T00:00:00Z"',
    '"cwd":"/fixture/gh-aw"},"timestamp":"2026-10-17T00:00:04Z"');
  assert.notEqual(lateInit, canonicalFixture());
  assert.equal(assessCanonical(lateInit, readme, fixtureRun).facets.read, "unknown");
});

test("genuine original attempts do not promote Python reads or legacy console claims to read_file conformance", () => {
  const cases = collectNative().cases;
  assert.equal(cases.length, 2);
  const modern = cases.find(row => row.runId === 38984441491);
  const older = cases.find(row => row.runId === 37862661287);
  assert.equal(modern.facets.read, "failed");
  assert.equal(older.facets.read, "unknown");
  assert.equal(modern.facets.inference, "unknown");
  assert.equal(modern.facets.mcpAvailability, "unknown");
  assert.equal(modern.facets.safeOutputPersistence, "unknown");
  assert.equal(modern.facets.fullGoal, "unknown");
  assert.equal(modern.nativeUsage.ai_credits, 0.804825);
  assert.equal(older.nativeUsage.ai_credits, 0.2229);
  assert.equal(modern.facets.pythonFilesystemRead, "passed");
  assert.equal(modern.receipts.filter(receipt => receipt.kind === "native-Python-filesystem-read-not-read_file").length, 3);
  assert.equal(older.facets.pythonFilesystemRead, "unknown");
  for (const row of cases) {
    assert.equal(row.hostGatewayEnumeration.agentUsableMcpProven, false);
    assert.equal(row.hostGatewayEnumeration.agentTransportProven, false);
    assert.equal(row.hostGatewayEnumeration.requestResponseCorrelation, "unknown-request-envelope-omits-id");
    assert.equal(row.safeOutputConsumerEvidence.appliedItems, 0);
    assert.equal(row.safeOutputConsumerEvidence.reportIncomplete, true);
    assert.equal(row.safeOutputConsumerEvidence.prescribedIssuePersistence, null);
  }
});

test("actual collector uses exact disjoint periods, preserves gaps and never borrows a newer/older result", async () => {
  const windows = [
    { windowStart: "2026-10-04T15:00:12Z", windowEnd: "2026-10-11T15:00:12Z", observedAt: "2026-10-18T15:00:12Z" },
    { windowStart: "2026-10-11T15:00:12Z", windowEnd: "2026-10-18T15:00:12Z", observedAt: "2026-10-18T15:00:12Z" },
    { windowStart: "2026-09-20T15:00:12Z", windowEnd: "2026-09-27T15:00:12Z", observedAt: "2026-10-18T15:00:12Z" },
  ];
  const result = await collectBatch(windows);
  assert.equal(result.length, 3);
  assert.equal(scoreMetric("native-read-cases", result[0].evidence), null);
  assert.equal(scoreMetric("native-read-cases", result[1].evidence), 0);
  assert.equal(scoreMetric("native-read-cases", result[2].evidence), null);
  assert.equal(result[0].evidence.coverageStatus, "partial");
  assert.equal(result[1].evidence.coverageStatus, "partial");
  assert.equal(result[2].evidence.coverageStatus, "missing");
  assert.equal(result[1].evidence.eligibleCount, null);
  assert.equal(result[1].evidence.cases[0].id, "38984441491/1");
  assert.equal(scoreMetric("python-filesystem-read-cases", result[0].evidence), null);
  assert.equal(scoreMetric("python-filesystem-read-cases", result[1].evidence), 1);
  assert.equal(scoreMetric("linked-python-read-cases", result[1].evidence), 1);
  assert.equal(scoreMetric("full-goal-cases", result[1].evidence), null);
});

test("separate Python partial requires actual closed native read request/result, not a guessed quote or calculator", () => {
  const code = "from pathlib import Path\nreadme_content = Path('README.md').read_text()\nreadme_content.splitlines()[0]";
  const readme = Buffer.from("# GitHub Agentic Workflows\n");
  const check = (input, output = "# GitHub Agentic Workflows") => assessCanonical(
    canonicalFixture({ tool: "run_code", input, output }), readme, fixtureRun);
  const positive = check({ code });
  assert.equal(positive.facets.pythonFilesystemRead, "passed");
  assert.equal(positive.facets.read, "unknown");
  assert.equal(check({ code: code.replace("README.md", "other/README.md") }).facets.pythonFilesystemRead, "unknown");
  assert.equal(check({ code }, "wrong line").facets.pythonFilesystemRead, "unknown");
  assert.equal(check({ code: "2 + 2" }, 4).facets.pythonFilesystemRead, "unknown");
  assert.equal(check({ code: "'# GitHub Agentic Workflows'" }).facets.pythonFilesystemRead, "unknown");
  assert.equal(check({ code: code.replace("read_text()", "read_text(); injected()") }).facets.pythonFilesystemRead, "unknown");
  assert.equal(positive.receipts[0].nativeToolName, "run_code");
  assert.deepEqual(positive.receipts[0].request, { code });
  assert.equal(positive.receipts[0].result.output, "# GitHub Agentic Workflows");
});

test("actual Python-read attribution respects exact exclusive native microsecond boundaries", async () => {
  const base = { observedAt: "2026-10-18T15:00:12Z" };
  const boundary = "2026-10-17T00:04:41.783104Z";
  const rows = await collectBatch([
    { ...base, windowStart: "2026-10-11T15:00:12Z", windowEnd: boundary },
    { ...base, windowStart: boundary, windowEnd: "2026-10-17T00:04:42Z" },
    { ...base, windowStart: "2026-10-17T00:04:41.783104001Z", windowEnd: "2026-10-17T00:04:42Z" },
  ]);
  assert.equal(scoreMetric("python-filesystem-read-cases", rows[0].evidence), null);
  assert.equal(scoreMetric("python-filesystem-read-cases", rows[1].evidence), 1);
  assert.equal(scoreMetric("native-read-cases", rows[1].evidence), null);
  assert.equal(scoreMetric("python-filesystem-read-cases", rows[2].evidence), null);
});

test("native original corruption and missing source bytes fail explicitly, never as empty successful collection", () => temporary(directory => {
  cpSync(proofRoot, directory, { recursive: true });
  const source = path.join(directory, "originals/3256c0de0441f39b1fc5cca047528c8562ec7bf5.blob");
  const original = readFileSync(source);
  writeFileSync(source, Buffer.from("not the immutable README"));
  assert.throws(() => collectNative(directory), /custody mismatch/);
  writeFileSync(source, original);
  rmSync(source);
  assert.throws(() => collectNative(directory), /ENOENT/);
}));

test("full production history reader retains forward/reverse discovery and absent references", () => {
  const history = discover(path.join(proofRoot, "discovery"));
  assert.equal(history.inventory.entities, 58048);
  assert.equal(history.inventory.partitions, 346);
  assert.equal(history.seedNumbers.length, 28);
  assert.equal(history.closure.length, 2756);
  assert.equal(history.closure.filter(row => row.status === "absent-reference").length, 16);
  const numbers = new Set(history.closure.map(row => row.number));
  for (const row of history.closure) {
    for (const related of row.relatedCandidates ?? []) assert.ok(numbers.has(related));
  }
  assert.equal(sha256(readFileSync(path.join(proofRoot, "acceptance.json"))), definition.acceptanceSha256);
});
