import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeExecutions, inspectExecution, nativeEvents, loadNative, proofRoot } from "../../scripts/native-smoke-capabilities.mjs";

const at = "2026-10-17T00:45:49.000Z";
const file = "/tmp/gh-aw/agent/smoke-test-cursor-42.txt";
const write = `mkdir -p /tmp/gh-aw/agent && echo "Smoke test passed for Cursor at $(date)" > ${file} && cat ${file}`;
const make = "GOCACHE=/tmp/gh-aw/agent/go-cache GOMODCACHE=/tmp/gh-aw/agent/go-mod make build";
const dated = "Smoke test passed for Cursor at Sat Oct 17 00:45:19 UTC 2026\n";
const nativeBuild = 'go build -ldflags "-s -w" -o gh-aw ./cmd/gh-aw\n';
const fixture = overrides => ({ id: "call", tool: "bash", command: write, output: dated, stderr: "",
  success: true, startedAt: at, at, ...overrides });

test("exact native readback is distinct from PASS, output existence, wrong paths and echoed claims", () => {
  assert.equal(inspectExecution("cursor", 42, fixture()).expandedReadback, true);
  assert.equal(inspectExecution("cursor", 42, fixture()).writeReadback, true);
  for (const overrides of [
    { command: `echo "${dated.trim()}"` }, { command: `test -f ${file}` },
    { command: write.replace("cursor-42", "cursor-43") }, { output: "PASS" },
    { output: dated.replace("Cursor", "Claude") }, { success: false },
    { output: dated.replace("2026", "2025") }, { command: `${write}; echo PASS` },
    { command: `${write} || true` },
  ]) assert.notEqual(inspectExecution("cursor", 42, fixture(overrides)).expandedReadback, true);
});

test("literal template bytes preserve the stricter expanded-date rejection", () => {
  const literal = inspectExecution("opencode", 42, fixture({ command: "cat /tmp/gh-aw/agent/smoke-test-opencode-42.txt",
    output: "Smoke test passed for OpenCode at $(date)" }));
  assert.equal(literal.literalReadback, true);
  assert.equal(literal.expandedReadback, false);
  assert.equal(literal.writeReadback, null);
});

test("native build must finish, not just return a timeout-shaped exit zero", () => {
  const pending = fixture({ command: `${write} && ${make}`, output: dated + nativeBuild,
    pending: { taskId: "123", backgroundReason: "SHELL_BACKGROUND_REASON_TIMEOUT" } });
  assert.equal(inspectExecution("cursor", 42, pending).expandedReadback, true);
  assert.equal(inspectExecution("cursor", 42, pending).build, null);
  assert.equal(inspectExecution("cursor", 42, { ...pending, asyncCompletion: { exitCode: 0 } }).build, true);
  assert.equal(inspectExecution("cursor", 42, { ...pending, asyncCompletion: { exitCode: 1 } }).build, false);
  assert.equal(inspectExecution("cursor", 42, fixture({ command: make, output: "Build succeeded" })).build, false);
  assert.equal(inspectExecution("cursor", 42, fixture({ command: make, output: nativeBuild, stderr: "make: *** error" })).build, false);
  assert.equal(inspectExecution("claude", 42, fixture({ command: "echo 'make build passed'", output: nativeBuild })).build, null);
});

test("Cursor async completion requires matching native start, task, session and command", () => {
  const start = { type: "tool_call", subtype: "started", call_id: "c", session_id: "s",
    tool_call: { shellToolCall: { args: { command: make } } } };
  const end = { ...start, subtype: "completed", tool_call: { shellToolCall: {
    args: { command: make }, result: { success: { command: make, stdout: nativeBuild, stderr: "", exitCode: 0,
      shellId: 123, backgroundReason: "SHELL_BACKGROUND_REASON_TIMEOUT" } } } } };
  const awaited = { type: "tool_call", subtype: "completed", call_id: "a", session_id: "s",
    tool_call: { awaitToolCall: { args: { taskId: "123" }, result: { success: { complete: { taskId: "123", exitCode: 0 } } } } } };
  const wrap = (value, index) => ({ value, at: `2026-10-17T00:45:${index}0.000Z`, line: index + 1 });
  const executions = decodeExecutions("cursor", [wrap(start, 0), wrap(end, 1), wrap(awaited, 2)]);
  assert.equal(executions[0].asyncCompletion.exitCode, 0);
  assert.throws(() => decodeExecutions("cursor", [wrap(end, 1)]), /matching start/);
  assert.throws(() => decodeExecutions("cursor", [wrap(start, 0), wrap(end, 1), wrap(end, 2)]), /Duplicate/);
  assert.throws(() => decodeExecutions("cursor", [wrap(start, 0), wrap(end, 1), wrap({ ...awaited, session_id: "other" }, 2)]), /unique task/);
});

test("Claude must bind exact invocation ID, native returned bytes and session", () => {
  const command = 'cat /tmp/gh-aw/agent/smoke-test-claude-42.txt';
  const start = { type: "assistant", session_id: "s", message: { content: [
    { type: "tool_use", id: "c", name: "Bash", input: { command } },
  ] } };
  const end = { type: "user", session_id: "s", message: { content: [
    { type: "tool_result", tool_use_id: "c", is_error: false, content: "actual bytes" },
  ] }, tool_use_result: { stdout: "actual bytes", stderr: "", interrupted: false } };
  const events = [start, end].map(value => ({ value, at, line: 1 }));
  assert.equal(decodeExecutions("claude", events)[0].output, "actual bytes");
  assert.equal(decodeExecutions("claude", [{ value: end, at, line: 1 }]).length, 0);
  assert.throws(() => decodeExecutions("claude", [events[0], { value: { ...end, session_id: "other" }, at, line: 2 }]), /cross-session/);
  assert.equal(decodeExecutions("claude", [events[0], { value: { ...end, tool_use_result: null }, at, line: 2 }]).length, 0);
});

test("Kiro command/completion and assistant prose are not native output effects", () => {
  const events = [
    { type: "tool.execution_start", data: { input: { command: write } } },
    { type: "tool.execution_complete", data: { status: "Completed" } },
    { type: "assistant", message: { content: [{ type: "text", text: "All tests PASS" }] } },
  ].map(value => ({ value, at, line: 1 }));
  assert.deepEqual(decodeExecutions("kiro", events), []);
});

test("protected logger bounds reject replayed events outside the original attempt", () => {
  const log = `${at} {"type":"tool_call","subtype":"started"}\n`;
  assert.equal(nativeEvents(log, { start: "2026-10-17T00:00:00Z", end: "2026-10-17T01:00:00Z" }).length, 1);
  assert.throws(() => nativeEvents(log, { start: "2026-10-18T00:00:00Z", end: "2026-10-18T01:00:00Z" }), /outside/);
  assert.deepEqual(nativeEvents(`${at} Assistant says PASS\n`, { start: at, end: at }), []);
});

test("real retained originals establish qualified facets and preserve three explicit evidence gaps", () => {
  const facts = loadNative();
  assert.equal(facts.length, 27);
  assert.equal(facts.filter(row => row.workflow === "smoke-claude" && row.expandedReadback === true).length, 2);
  assert.equal(facts.filter(row => row.workflow === "smoke-cursor" && row.expandedReadback === true).length, 1);
  assert.equal(facts.filter(row => row.workflow === "smoke-cursor" && row.build === true).length, 1);
  const code = facts.find(row => row.workflow === "smoke-opencode" && row.literalReadback === true);
  assert.equal(code.expandedReadback, false);
  assert.equal(code.build, false);
  assert.equal(code.fullAcceptance, false);
  assert.equal(code.writeReadback, null, "overlapping native write/read intervals do not prove strict ordering");
  for (const workflow of ["smoke-gemini", "smoke-kiro", "smoke-crush"]) {
    const rows = facts.filter(row => row.workflow === workflow);
    assert.equal(rows.length, 7);
    assert.ok(rows.every(row => row.native.length === 0 && row.gap));
  }
});

test("mutated original custody is an explicit error, not missing or zero", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "native-capability-custody-"));
  try {
    cpSync(proofRoot, temporary, { recursive: true });
    const packetPath = path.join(temporary, "acquisition.json");
    const packet = JSON.parse(readFileSync(packetPath));
    packet.requests[0].bodySha256 = "0".repeat(64);
    writeFileSync(packetPath, JSON.stringify(packet));
    assert.throws(() => loadNative(temporary), /custody mismatch/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test("six real modules retain native subtotals, disjoint windows and unknown gaps", async () => {
  for (const [engine, expected] of [["claude", 2], ["cursor", 2], ["opencode", 1],
    ["gemini", null], ["kiro", null], ["crush", null]]) {
    const module = await import(`../../docs/operational-value/proof/functions/smoke-${engine}.mjs`);
    const requests = [
      { windowStart: "2026-10-11T15:00:12Z", windowEnd: "2026-10-18T15:00:12Z", observedAt: "2026-10-18T15:00:12Z" },
      { windowStart: "2026-10-04T15:00:12Z", windowEnd: "2026-10-11T15:00:12Z", observedAt: "2026-10-11T15:00:12Z" },
    ];
    const collections = await module.collectBatch(requests);
    assert.equal(module.scoreMetric("capabilities", collections[0].evidence), expected);
    assert.equal(module.scoreMetric("capabilities", collections[1].evidence), null);
    assert.throws(() => module.collectBatch([{ ...requests[0], repository: "different/repository" }]), /Invalid capability/);
    for (const value of ["PASS", -1, NaN, Infinity, 0.5]) assert.equal(module.scoreMetric("capabilities", { valid: true, capabilities: value }), null);
    assert.equal(module.definition.implementation.authoring, "outcome-informed retrospective");
    assert.equal(module.definition.evaluation.mode, "attainment-only");
  }
});
