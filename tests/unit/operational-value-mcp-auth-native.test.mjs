import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readJsonArchive } from "../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { definition, collectBatch, scoreMetric } from "../../docs/operational-value/proof/functions/github-remote-mcp-auth-test.mjs";
import { nativeCases, rawCanaryScript, parseRawCanaryLog } from "../../docs/operational-value/proof/mcp-auth-native/native.mjs";

const archive = readJsonArchive("docs/operational-value/proof/mcp-auth-native/originals.json.gz",
  { maxDecodedBytes: 32 * 1024 * 1024 });
const original = endpoint => Buffer.from(archive.receipts.find(row => row.endpoint === endpoint).bodyBase64, "base64").toString("utf8");
const jobPage = JSON.parse(original("repos/github/gh-aw/actions/runs/39100761580/attempts/1/jobs?per_page=100"));
const step = jobPage.jobs.find(job => job.name === "raw_mcp_canary").steps.find(row => row.name === "Verify raw GitHub remote MCP handshake");
const log = original("repos/github/gh-aw/actions/jobs/117596807892/logs");
const observedAt = "2026-10-18T15:00:12Z";
const request = (windowStart, windowEnd) => ({ windowStart, windowEnd, observedAt });

test("three actual source-bound protected executions establish raw transport only", () => {
  const native = nativeCases();
  assert.equal(native.adoption.adoptedAt, "2026-01-07T15:47:11Z");
  assert.equal(native.cases.length, 3);
  for (const row of native.cases) {
    assert.equal(row.status, "accepted");
    assert.equal(row.tools, 23);
    assert.equal(row.issueContentVerified, null);
    assert.equal(row.credentialClassVerified, null);
  }
  assert.equal(definition.limitations.fullGoal, null);
  assert.equal(definition.limitations.costs, null);
});

test("protected runtime phases must be unique, complete and in order", () => {
  assert.equal(parseRawCanaryLog(log, step).status, "accepted");
  for (const fragment of [
    "MCP initialize responded with HTTP 200.",
    "##[notice]notifications/initialized: HTTP 202",
    "##[notice]ping: succeeded",
    "##[notice]tools/list: `list_issues` is available",
    "##[notice]list_issues: retrieved open issues from github/gh-aw",
    "Raw GitHub remote MCP handshake succeeded with 23 tools available.",
  ]) {
    assert.equal(parseRawCanaryLog(log.replace(fragment, "removed-witness"), step).status, "unknown", fragment);
  }
  const terminal = log.split("\n").find(line => line.endsWith("Raw GitHub remote MCP handshake succeeded with 23 tools available."));
  assert.equal(parseRawCanaryLog(`${log}\n${terminal}`, step).status, "unknown");
  assert.equal(parseRawCanaryLog(`${terminal}\n${log.replace(terminal, "")}`, step).status, "unknown");
});

test("source echoes, unrelated step output and claimed job success cannot replace native evidence", () => {
  assert.equal(parseRawCanaryLog(log.split("\n").map(line => `\x1b[36;1m${line}\x1b[0m`).join("\n"), step).status, "unknown");
  assert.equal(parseRawCanaryLog(log, { started_at: "2026-10-18T05:00:00Z", completed_at: "2026-10-18T05:00:01Z" }).status, "unknown");
  assert.equal(parseRawCanaryLog("success", step).status, "unknown");
  assert.throws(() => parseRawCanaryLog(log, {}), /Malformed protected/);
});

test("tool catalog, server identity, repository and protocol witnesses must agree", () => {
  for (const modified of [
    log.replace("tools/list returned 23 tools", "tools/list returned 24 tools"),
    log.replace("succeeded with 23 tools available", "succeeded with 22 tools available"),
    log.replace('"name":"github-mcp-server"', '"name":"unrelated-server"'),
    log.replace("retrieved open issues from github/gh-aw", "retrieved open issues from github/other"),
    log.replace("protocol 2024-11-05", "protocol unknown"),
  ]) assert.equal(parseRawCanaryLog(modified, step).status, "unknown");
});

test("actual protected HTTP rejection differs from missing originals", () => {
  const rejected = log.replace("MCP initialize responded with HTTP 200.", "MCP initialize failed with HTTP 401.");
  assert.equal(parseRawCanaryLog(rejected, step).status, "rejected");
  assert.equal(parseRawCanaryLog("", step).status, "unknown");
});

test("exact script extraction isolates the protected job and rejects ambiguous layouts", () => {
  const endpoint = "repos/github/gh-aw/contents/.github/workflows/github-remote-mcp-auth-test.md?ref=c86377ec47b38f0b5af463277ee55d1d03d08da8";
  const source = Buffer.from(JSON.parse(original(endpoint)).content, "base64").toString("utf8");
  const script = rawCanaryScript(source);
  assert.ok(script.includes("https://api.githubcopilot.com/mcp/"));
  assert.ok(script.includes("X-MCP-Readonly: true"));
  assert.throws(() => rawCanaryScript(`${source}\n  raw_mcp_canary:\n`), /ambiguous/);
  assert.throws(() => rawCanaryScript(source.replace("  raw_mcp_canary:", "  unprotected_canary:")), /Missing/);
});

test("disjoint interval collection deduplicates attempts and preserves every unassessed period", async () => {
  const packets = await collectBatch([
    request("2026-10-11T15:00:12Z", observedAt),
    request("2026-10-04T15:00:12Z", "2026-10-11T15:00:12Z"),
    request("2026-10-16T05:34:37Z", "2026-10-17T05:32:50Z"),
    request("2026-10-17T05:32:50Z", "2026-10-18T05:32:41Z"),
  ]);
  assert.deepEqual(packets.map(row => scoreMetric("native-transport", row.evidence)), [3, null, 1, 1]);
  assert.deepEqual(packets[2].evidence.cases.map(row => row.id), ["38856240142"]);
  assert.deepEqual(packets[3].evidence.cases.map(row => row.id), ["39006501944"]);
  for (const packet of packets) {
    assert.equal(packet.evidence.completeComparablePeriod, false);
    assert.equal(packet.evidence.workflowContribution, null);
    assert.equal(packet.evidence.fullGoal, null);
    assert.equal(packet.evidence.credentialClass, null);
  }
  await assert.rejects(collectBatch([{ ...request("2026-10-11T15:00:12Z", observedAt), repository: "github/other" }]), /Invalid/);
});

test("native scoring rejects unknown or duplicated facts instead of inventing zeros", () => {
  const examples = definition.validationExamples;
  assert.equal(scoreMetric("native-transport", examples.targetAttained), 1);
  assert.equal(scoreMetric("native-transport", examples.targetMissed), 0);
  assert.equal(scoreMetric("native-transport", examples.missing), null);
  assert.equal(scoreMetric("native-transport", examples.malformed), null);
  assert.equal(scoreMetric("native-transport", { ...examples.targetAttained, cases: [] }), null);
  assert.equal(scoreMetric("native-transport", { ...examples.targetAttained,
    cases: [...examples.targetAttained.cases, ...examples.targetAttained.cases] }), null);
  assert.ok(readFileSync("docs/operational-value/proof/mcp-auth-native/contract.json", "utf8").includes("not agent-usable MCP"));
});
