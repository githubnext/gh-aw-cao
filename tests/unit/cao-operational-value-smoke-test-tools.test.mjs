import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { literalShellWords, nativeToolCommand, parseNativeCodexToolLog, parseNativePiToolLog, protectedExecutionLineMatches,
  reviewedLiteralToolLoop, reviewedMarkedToolBatch, reviewedNativeBatch,
  reviewedHistoricalCodexBatch,
  scoreSmokeTools, toolOutputMatches, verifyNativeToolReceipt } from "../../scripts/native-smoke-test-tools.mjs";
import { censusDigest, readCensusJson } from "../../scripts/operational-value-census-io.mjs";
import { smokeToolsContract } from "../../scripts/smoke-test-tools-contract.mjs";
import { retryableSmokeToolsLogStatus, smokeToolsQuotaFailure } from "../../scripts/collect-smoke-test-tools-evidence.mjs";

const step = { started_at: "2026-10-10T00:00:00Z", completed_at: "2026-10-10T00:01:00Z" };
const stamp = event => `2026-10-10T00:00:20.000Z ${JSON.stringify(event)}`;
const start = { type: "tool_execution_start", toolName: "bash", toolCallId: "native-1", args: { command: "git --version" } };
const end = { type: "tool_execution_end", toolName: "bash", toolCallId: "native-1", isError: false,
  result: { content: [{ type: "text", text: "git version 2.49.0\n" }], details: { exitCode: 0 } } };

test("quota gaps remain retryable, unlike expired transport", () => {
  assert.equal(smokeToolsQuotaFailure("API rate limit exceeded (HTTP 403)"), true);
  assert.equal(smokeToolsQuotaFailure("secondary rate limit (HTTP 429)"), true);
  assert.equal(smokeToolsQuotaFailure("Resource not accessible (HTTP 403)"), false);
  for (const status of ["not-acquired-rate-limited", "HTTP 403", "unresolved-403-access-or-quota"]) {
    assert.equal(retryableSmokeToolsLogStatus(status), true);
  }
  for (const status of ["HTTP 404", "HTTP 410", "available"]) assert.equal(retryableSmokeToolsLogStatus(status), false);
});

test("all twelve source tools have exact native version or shell-function predicates", () => {
  assert.equal(smokeToolsContract.tools.length, 12);
  for (const tool of smokeToolsContract.tools) assert.deepEqual(nativeToolCommand(tool.commands[0]), [tool.id]);
  assert.deepEqual(nativeToolCommand("bash --version | head -n 1; sh -c 'echo ok'; git --version 2>&1"), ["bash", "sh", "git"]);
  assert.deepEqual(nativeToolCommand("/usr/bin/bash -lc 'git --version'"), ["git"]);
  assert.deepEqual(nativeToolCommand("/usr/bin/git --version"), ["git"]);
  assert.deepEqual(nativeToolCommand("/opt/hostedtoolcache/node/24.19.0/x64/bin/node --version"), ["node"]);
  assert.deepEqual(nativeToolCommand("java --version 2>&1 | head -n 2 | tail -n 1"), ["java"]);
  assert.deepEqual(literalShellWords(`'one'"'"'two'`), ["one'two"]);
  assert.equal(literalShellWords('"$untrusted"'), null);
  for (const command of ["echo 'git version 2.49.0'", "git --version; echo v24.0.0", "sh -c 'git --version'",
    "git --version || true", "git --version >output", "git --version; git --version"]) assert.equal(nativeToolCommand(command), null);
  assert.equal(toolOutputMatches("git", "The agent says git version 2.49.0"), false);
  assert.equal(toolOutputMatches("git", "git version 2.49.0"), true);
  assert.equal(toolOutputMatches("sh", "ok\n"), true);
  assert.equal(toolOutputMatches("sh", "GNU bash, version 5.2.21(1)-release (x86_64-pc-linux-gnu)"), true);
});

test("source binding allows only the reviewed numeric Actions expression expansion", () => {
  const source = 'GH_AW_MAX_AI_CREDITS="${{ vars.GH_AW_DEFAULT_MAX_AI_CREDITS || \'1000\' }}"';
  assert.equal(protectedExecutionLineMatches(source, 'GH_AW_MAX_AI_CREDITS="1000"'), true);
  assert.equal(protectedExecutionLineMatches(source, 'GH_AW_MAX_AI_CREDITS="2000"'), true);
  for (const actual of ['GH_AW_MAX_AI_CREDITS="$(echo 1000)"', 'GH_AW_MAX_AI_CREDITS="1000"; echo forged',
    'GH_AW_MAX_AI_CREDITS="-1"', 'GH_AW_MAX_AI_CREDITS="1000"\nexit 0']) assert.equal(protectedExecutionLineMatches(source, actual), false);
  assert.equal(protectedExecutionLineMatches("actual code", "different code"), false);
});

test("closed native batches preserve successful conjunction prefixes without accepting forged tails", () => {
  const command = smokeToolsContract.tools.map(tool => `echo '== ${tool.id} ==' && ${tool.id === "sh" ? "sh -c 'echo ok'" : tool.commands[0]}`).join(" && ");
  const output = "== bash ==\nGNU bash, version 5.2.21\n== sh ==\nok\n== git ==\ngit: command not found\n";
  assert.deepEqual(reviewedMarkedToolBatch(command, output, false).map(row => row.toolId), ["bash", "sh"]);
  assert.deepEqual(reviewedMarkedToolBatch(command.replace("bash --version", "echo forged"), output), []);
  assert.deepEqual(reviewedMarkedToolBatch(command, "== bash ==\nnot a version\n== sh ==\nnot ok\n", false), []);
});

test("native Codex command identity, completion and output are independently correlated", () => {
  const item = { id: "native-codex-1", type: "command_execution", command: "/usr/bin/bash -lc 'git --version'" };
  const events = [stamp({ type: "item.started", item }),
    stamp({ type: "item.completed", item: { ...item, aggregated_output: "git version 2.49.0", exit_code: 0, status: "completed" } })];
  assert.equal(parseNativeCodexToolLog(events.join("\n"), step).results[0].passed, true);
  assert.throws(() => parseNativeCodexToolLog([events[0],
    stamp({ type: "item.completed", item: { ...item, command: "echo forged", aggregated_output: "git version 2.49.0", exit_code: 0, status: "completed" } })].join("\n"), step), /command changed/);
});

test("native Pi start/completion pairing accepts actual version output, not agent prose", () => {
  const parsed = parseNativePiToolLog([stamp(start), stamp(end)].join("\n"), step);
  assert.equal(parsed.results.length, 1);
  assert.equal(parsed.results[0].passed, true);
  assert.deepEqual(parsed.results[0].nativeOutput, ["git version 2.49.0"]);
  assert.equal(parseNativePiToolLog(stamp({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "git version 2.49.0" }] } }), step).results.length, 0);
  assert.equal(parseNativePiToolLog(stamp(end), step).results.length, 0);
  assert.equal(parseNativePiToolLog([stamp(start), stamp({ ...end, toolCallId: "unrelated" })].join("\n"), step).results.length, 0);
  assert.equal(parseNativePiToolLog([stamp(start), stamp({ ...end, result: { content: [{ type: "text", text: "git version 2.49.0" }], exitCode: 1 } })].join("\n"), step).results[0].passed, null);
  const sh = { ...start, args: { command: "sh --version" } };
  assert.equal(parseNativePiToolLog([stamp(sh), stamp({ ...end, isError: true, result: { details: { exitCode: 2 } } })].join("\n"), step).results[0].passed, null);
  assert.equal(parseNativePiToolLog([stamp(start), stamp(end)].join("\n"), { ...step, started_at: "2026-10-10T00:00:30Z" }).results.length, 0);
  assert.throws(() => parseNativePiToolLog([stamp(start), stamp(start)].join("\n"), step), /Ambiguous/);
});

test("missing or partial native evidence never becomes a complete zero", () => {
  const partial = { valid: true, unknownEligibility: 0, assessments: [{ id: "1:git", passed: true }, { id: "1:node", passed: null }] };
  assert.equal(scoreSmokeTools("observed-tool-proofs", partial), 1);
  assert.equal(scoreSmokeTools("complete-tool-proofs", partial), null);
  assert.equal(scoreSmokeTools("observed-tool-proofs", { valid: true, assessments: [{ id: "1:git", passed: null }] }), null);
  assert.equal(scoreSmokeTools("observed-tool-proofs", { valid: true, assessments: [] }), null);
  assert.equal(scoreSmokeTools("observed-tool-proofs", { valid: true, assessments: [{ id: "1:git", passed: false }] }), 0);
  assert.equal(scoreSmokeTools("observed-tool-proofs", { valid: true, assessments: [{ id: "1:git", passed: "PASS" }] }), null);
  assert.throws(() => verifyNativeToolReceipt({ results: [{ passed: true }] }), /Unbound/);
});

test("real retained evidence inventory is mandatory for collector replay", async () => {
  const { collectBatch } = await import("../../docs/operational-value/proof/functions/smoke-test-tools.mjs");
  const index = JSON.parse(readFileSync("docs/operational-value/proof/smoke-test-tools/index.json", "utf8"));
  assert.equal(index.complete, true);
  assert.ok(index.runs > 0);
  const request = { windowStart: "2026-10-11T15:00:12Z", windowEnd: smokeToolsContract.until, observedAt: smokeToolsContract.until };
  const result = collectBatch([request])[0];
  assert.ok(result.evidence.inventoryRuns > 0);
  if (index.retainedProofs === 0) {
    assert.equal(scoreSmokeTools("observed-tool-proofs", result.evidence), null);
    assert.equal(result.evidence.coverageStatus, "missing");
  }
  assert.throws(() => collectBatch([{ ...request, repository: "unrelated/repo" }]), /repository mismatch/);
  const originals = readCensusJson("docs/operational-value/proof/smoke-test-tools/native-receipts.json.gz");
  assert.ok(originals.projections.length > 0);
  let accepted = 0;
  for (const projection of originals.projections) {
    const parse = projection.engine === "pi" ? parseNativePiToolLog : parseNativeCodexToolLog;
    const replay = parse(projection.nativeLines.join("\n"), projection.step);
    assert.equal(censusDigest(replay.results), projection.resultsSha256);
    accepted += replay.results.filter(row => row.passed === true).length;
    for (const line of projection.nativeLines) {
      const raw = JSON.parse(line.replace(/^\S+ /, ""));
      if (raw.type === "tool_execution_start" && raw.args?.command.includes("for spec in")) {
        const completion = projection.nativeLines.map(line => JSON.parse(line.replace(/^\S+ /, "")))
          .find(event => event.type === "tool_execution_end" && event.toolCallId === raw.toolCallId);
        const output = completion.result.content.map(row => row.text ?? "").join("\n");
        assert.ok(reviewedLiteralToolLoop(raw.args.command, output).length > 0);
        assert.deepEqual(reviewedLiteralToolLoop(raw.args.command.replace('out=$(eval "$cmd" 2>&1)', "out='git version 2.49.0'"), output), []);
        assert.deepEqual(reviewedLiteralToolLoop(`PATH=/untrusted\n${raw.args.command}`, output), []);
      }
      if (raw.type === "tool_execution_start") {
        const completion = projection.nativeLines.map(line => JSON.parse(line.replace(/^\S+ /, "")))
          .find(event => event.type === "tool_execution_end" && event.toolCallId === raw.toolCallId);
        const output = completion?.result?.content?.map(row => row.text ?? "").join("\n");
        if (reviewedNativeBatch(raw.args.command, output).length) {
          assert.deepEqual(reviewedNativeBatch(`${raw.args.command}\nprintf forged`, output), []);
          assert.deepEqual(reviewedNativeBatch(raw.args.command.replace("--version", "--help"), output), []);
        }
      }
    }
  }
  assert.equal(accepted, index.retainedProofs);
  assert.ok(accepted > 0, "real source-bound native execution receipts, not only fixtures, must demonstrate tool usability");
  for (const projection of originals.projections.filter(row => row.engine === "codex")) {
    for (const line of projection.nativeLines) {
      const event = JSON.parse(line.replace(/^\S+ /, ""));
      if (event.type !== "item.completed") continue;
      const item = event.item;
      const reviewed = reviewedHistoricalCodexBatch(item.command, item.aggregated_output);
      if (!reviewed.length) continue;
      assert.deepEqual(reviewedHistoricalCodexBatch(`${item.command}\necho forged`, item.aggregated_output), []);
      assert.deepEqual(reviewedHistoricalCodexBatch(item.command.replace("--version", "--help"), item.aggregated_output), []);
      if (projection.runId === 33345386945) assert.equal(reviewed.some(row => row.toolId === "sh"), false,
        "a printed success label and unterminated-shell error are not sh echo-ok proof");
    }
  }
  const cwd = process.cwd(), temporary = mkdtempSync(path.join(cwd, ".smoke-tools-missing-test-"));
  try {
    const directory = "docs/operational-value/proof/smoke-test-tools";
    mkdirSync(path.join(temporary, directory), { recursive: true });
    for (const file of ["index.json", "observations.json.gz", "sources.json.gz", "runs.json.gz", "source-review.json.gz"]) {
      copyFileSync(path.join(directory, file), path.join(temporary, directory, file));
    }
    process.chdir(temporary);
    assert.throws(() => collectBatch([request]), /ENOENT/);
  } finally {
    process.chdir(cwd);
    rmSync(temporary, { recursive: true });
  }
});
