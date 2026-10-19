import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assessRun, inspectExecution, joinedWriteReadback, loadNative, readAgentLog, readOriginal, readPacketReceipts, readSession,
  sha256, sourceReader, typedExecutions,
} from "../../scripts/native-smoke-copilot-small.mjs";
import { retain } from "../../scripts/collect-smoke-copilot-small.mjs";
import { collectBatch, definition, scoreMetric } from "../../docs/operational-value/proof/functions/smoke-copilot-small.mjs";

const root = fileURLToPath(new URL("../../docs/operational-value/proof/smoke-copilot-small/", import.meta.url));
const bounds = { start: "2026-10-18T02:43:21Z", end: "2026-10-18T02:50:00Z" };
const fixture = (command = "echo $((6 * 7))", output = "42\n") => {
  const start = { type: "tool.execution_start", data: { toolCallId: "call-1", toolName: "bash",
    arguments: { command }, model: "fixture-only" }, id: "event-1", timestamp: "2026-10-18T02:45:00Z" };
  const end = { type: "tool.execution_complete", data: { toolCallId: "call-1", success: true,
    shellExecution: { exitCode: 0 }, result: { contents: [{ type: "shell_exit", exitCode: 0, outputPreview: output }] } },
  id: "event-2", timestamp: "2026-10-18T02:45:01Z" };
  return { start, end, log: [start, end].map(row => `${row.timestamp} ${JSON.stringify(row)}`).join("\n") };
};
const execution = (command, output) => typedExecutions(fixture(command, output).log, bounds)[0];

test("native parser accepts exact arithmetic and three-line cat, not agent claims", () => {
  assert.equal(inspectExecution(execution("echo $((6 * 7))", "42\n"), 39091097441).arithmetic, true);
  assert.equal(inspectExecution(execution("echo $((6 * 7))", "41\n"), 39091097441).arithmetic, false);
  assert.equal(inspectExecution(execution("echo 42", "42\n"), 39091097441).arithmetic, null);
  assert.equal(inspectExecution(execution("printf 'echo $((6 * 7))'", "42\n"), 39091097441).arithmetic, null);
  assert.equal(inspectExecution(execution("cat /tmp/smoke-copilot-small-39091097441.txt", "one\ntwo\nthree\n"), 39091097441).readback, true);
  assert.equal(inspectExecution(execution("cat /tmp/smoke-copilot-small-39091097441.txt", "one\ntwo\n"), 39091097441).readback, false);
  assert.equal(inspectExecution(execution("cat /tmp/smoke-copilot-small-1.txt", "one\ntwo\nthree\n"), 39091097441).readback, null);
  const combined = inspectExecution(execution("cat /tmp/smoke-copilot-small-39091097441.txt | wc -l; echo $((6 * 7))", "3\n42\n"), 39091097441);
  assert.equal(combined.arithmetic, true);
  assert.equal(combined.newlineCount, 3);
  assert.equal(combined.readback, null);
  assert.equal(inspectExecution(execution("cat /tmp/smoke-copilot-small-39091097441.txt | wc -l; echo 42", "3\n42\n"), 39091097441).arithmetic, null);
  assert.deepEqual(typedExecutions("Agent says PASS; echo $((6 * 7)) => 42", bounds), []);
});

test("missing, failed, untyped, duplicate, reversed and out-of-window events fail closed", () => {
  const { start, end } = fixture();
  const line = row => `${row.timestamp} ${JSON.stringify(row)}`;
  assert.equal(typedExecutions(line(start), bounds)[0].status, "missing-completion");
  const failed = structuredClone(end); failed.data.success = false;
  assert.equal(typedExecutions(`${line(start)}\n${line(failed)}`, bounds)[0].status, "unsuccessful-or-untyped");
  const untyped = structuredClone(end); delete untyped.data.result.contents;
  assert.equal(typedExecutions(`${line(start)}\n${line(untyped)}`, bounds)[0].status, "unsuccessful-or-untyped");
  assert.throws(() => typedExecutions(`${line(start)}\n${line(end)}\n${line(end)}`, bounds), /identity/);
  const early = structuredClone(end); early.timestamp = "2026-10-18T02:44:59Z";
  assert.throws(() => typedExecutions(`${line(start)}\n${line(early)}`, bounds), /precedes/);
  assert.throws(() => typedExecutions(fixture().log, { start: "2026-10-19T00:00:00Z", end: "2026-10-20T00:00:00Z" }), /time/);
});

test("write-plus-readback requires matching bytes, three lines and ordered native receipts", () => {
  const row = execution("cat /tmp/smoke-copilot-small-39091097441.txt", "one\ntwo\nthree\n");
  row.facets = inspectExecution(row, 39091097441);
  const created = { completedAt: "2026-10-18T02:44:59Z", readbackSha256: sha256(Buffer.from("one\ntwo\nthree")) };
  assert.equal(joinedWriteReadback([row], [created]).value, true);
  assert.equal(joinedWriteReadback([row], [{ ...created, readbackSha256: "0".repeat(64) }]).value, null);
  assert.equal(joinedWriteReadback([row], [{ ...created, completedAt: "2026-10-18T02:45:02Z" }]).value, null);
  assert.equal(joinedWriteReadback([{ ...row, facets: { readback: false } }], [created]).value, null);
});

test("original compressed parts detect byte or digest tampering", () => {
  const directory = mkdtempSync(path.resolve(".smoke-small-test-"));
  try {
    const original = retain(directory, Buffer.from("native original\n"));
    assert.equal(readOriginal(directory, original).toString(), "native original\n");
    assert.throws(() => readOriginal(directory, { ...original, sha256: "0".repeat(64) }), /custody/);
    writeFileSync(path.join(directory, original.parts[0].file), "tampered");
    assert.throws(() => readOriginal(directory, original), /custody/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("actual immutable sources prove introduction, real parent absence and frozen identity", () => {
  const sources = sourceReader(root);
  const current = sources.resolve("c86377ec47b38f0b5af463277ee55d1d03d08da8", definition.sourcePath);
  assert.equal(current.id, "fd2c6bfd12686d9d41a06728fa1e810b9662c6fb");
  assert.match(current.content, /original 3-line haiku/);
  assert.equal(sources.resolve(definition.adoption.baselineCommit, definition.sourcePath).status, "absent");
  assert.equal(sources.resolve(definition.adoption.commit, definition.sourcePath).status, "retained");
  const parent = sources.object(definition.adoption.baselineCommit, "commit").toString();
  const stamp = Number(parent.match(/^committer .* ([0-9]+) [+-][0-9]{4}$/m)[1]);
  assert.equal(new Date(stamp * 1000).toISOString(), `${definition.adoption.baselineAt.slice(0, -1)}.000Z`);
});

test("wrong source, repository, job binding or workflow cannot borrow a native success", () => {
  const run = { id: 39091097441, repository: { id: 1036865607, full_name: "github/gh-aw", private: false },
    path: ".github/workflows/smoke-copilot-small.lock.yml", run_attempt: 1, head_sha: "a".repeat(40) };
  const jobs = { total_count: 1, jobs: [{ name: "agent", run_id: run.id, head_sha: run.head_sha,
    started_at: bounds.start, completed_at: bounds.end }] };
  assert.throws(() => assessRun({ ...run, path: ".github/workflows/smoke-copilot-sdk.lock.yml" }, jobs, fixture().log, {}, {}), /identity/);
  assert.throws(() => assessRun({ ...run, repository: { id: 1 } }, jobs, fixture().log, {}, {}), /identity/);
  assert.throws(() => assessRun(run, { ...jobs, total_count: 2 }, fixture().log, {}, {}), /identity/);
  assert.equal(assessRun(run, jobs, fixture().log, { status: "missing-blob" }, {}).arithmetic, null);
});

test("actual retained session needs agreeing protected completion and original source", () => {
  const receipts = readPacketReceipts(root);
  const body = endpoint => receipts.find(row => row.receipt.endpoint === endpoint).bodies.file;
  const prefix = "repos/github/gh-aw/actions/runs/39091097441";
  const run = JSON.parse(body(prefix));
  const jobs = JSON.parse(body(`${prefix}/attempts/1/jobs?per_page=100`));
  const log = readAgentLog(body(`${prefix}/attempts/1/logs`));
  const session = JSON.parse(readSession(body("repos/github/gh-aw/actions/artifacts/12122926422/zip")));
  const sources = sourceReader(root);
  const source = sources.resolve(run.head_sha, definition.sourcePath);
  const compiled = sources.resolve(run.head_sha, definition.sourcePath.replace(".md", ".lock.yml"));
  const actual = assessRun(run, jobs, log, source, compiled, session);
  assert.equal(actual.arithmetic, true);
  assert.throws(() => assessRun(run, jobs, log.replaceAll("toolCallId=toolu_01LRGWcwiZBW7dM1PB1ixYi1",
    "toolCallId=tampered"), source, compiled, session), /corroboration/);
  const early = { ...session, events: session.events.replaceAll("2026-10-18T02:46:16.407Z", "2026-10-17T02:46:16.407Z") };
  assert.throws(() => assessRun(run, jobs, log, source, compiled, early), /time/);
});

test("offline collector uses retained native originals and keeps gaps null", async () => {
  const facts = loadNative(root);
  const real = facts.find(row => row.runId === 39091097441);
  assert.equal(facts.length, 3);
  assert.equal(real.arithmetic, true);
  assert.equal(real.arithmeticAt, "2026-10-18T02:46:16.407Z");
  assert.equal(real.readback, null);
  assert.equal(real.readbackAt, null);
  assert.equal(real.nativeNewlineReads[0].newlineCount, 3);
  assert.equal(real.nativeFileCreations[0].newlineCount, 3);
  assert.equal(real.knownImportedFailures[0].requirement, "Playwright JavaScript title equality");
  const result = await collectBatch([
    { windowStart: "2026-10-11T15:00:12Z", windowEnd: "2026-10-18T15:00:12Z", observedAt: "2026-10-18T15:00:12Z" },
    { windowStart: "2026-07-08T13:46:46Z", windowEnd: "2026-07-15T13:46:46Z", observedAt: "2026-07-15T13:46:46Z" },
  ]);
  assert.equal(scoreMetric("arithmetic", result[1].evidence), null);
  assert.equal(scoreMetric("arithmetic", result[0].evidence), 1);
  assert.notEqual(result[0].evidence.coverageStatus, "complete");
  assert.equal(scoreMetric("fullAcceptance", result[0].evidence), null);
  assert.equal(scoreMetric("arithmetic", definition.validationExamples.malformed), null);
  assert.ok(result[0].provenance.every(row => row.ref));
  await assert.rejects(collectBatch([{ windowStart: "bad" }]), /Invalid/);
  assert.equal(sha256(readFileSync(path.join(root, "acceptance.json"))).length, 64);
});
