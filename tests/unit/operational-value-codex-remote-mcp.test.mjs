import assert from "node:assert/strict";
import test from "node:test";
import { readJsonArchive } from "../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { readZip } from "../../scripts/native-smoke-pydantic.mjs";
import { inspectNativeAccess, nativeCases } from "../../docs/operational-value/proof/codex-remote-mcp/native.mjs";
import { collectBatch, definition, scoreMetric } from "../../docs/operational-value/proof/functions/codex-github-remote-mcp-test.mjs";

const packet = readJsonArchive("docs/operational-value/proof/codex-remote-mcp/originals.json.gz",
  { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 });
const original = endpoint => Buffer.from(packet.receipts.find(row => row.endpoint === endpoint).bodyBase64, "base64");
const files = readZip(original("repos/github/gh-aw/actions/artifacts/11265151492/zip"));
const job = JSON.parse(original("repos/github/gh-aw/actions/runs/37098241608/attempts/1/jobs?per_page=100"))
  .jobs.find(row => row.name === "agent");
const fixture = {
  protectedLog: original("repos/github/gh-aw/actions/jobs/111132559744/logs").toString("utf8"),
  stdio: files.get("agent-stdio.log").toString("utf8"),
  session: files.get("agent-session.jsonl").toString("utf8"),
  rpc: files.get("mcp-logs/rpc-messages.jsonl").toString("utf8"),
  githubLog: files.get("mcp-logs/github.log").toString("utf8"),
  step: job.steps.find(row => row.name === "Execute Codex CLI"),
};
const modifyRows = (text, transform) => text.trim().split("\n").map(JSON.parse).map(transform).map(JSON.stringify).join("\n");

test("real native access and integrity filtering do not become issue readback or historical full success", () => {
  const result = inspectNativeAccess(fixture);
  assert.equal(result.status, "accepted");
  assert.equal(result.nativeAccess, 1);
  assert.equal(result.filteredResources, 3);
  assert.equal(result.upstreamIssues, 3);
  assert.equal(result.agentIssueReadback, null);
  assert.equal(result.fullGoal, null);
  assert.deepEqual(result.issueIds, [65234, 65235, 65236]);
  const cases = nativeCases();
  assert.equal(cases.adoption.adoptedAt, "2026-01-18T13:28:58Z");
  assert.equal(cases.cases.length, 9);
  assert.equal(cases.cases.filter(row => row.status === "accepted").length, 1);
  assert.equal(cases.cases[0].historicalFilterAcceptanceDeclared, false);
  assert.equal(cases.cases.filter(row => row.status === "unknown").length, 8);
});

test("assistant reports, source declarations and normalized-only claims cannot replace protected native output", () => {
  assert.equal(inspectNativeAccess({ ...fixture, protectedLog: "The test passed and retrieved three issues" }).status, "unknown");
  assert.equal(inspectNativeAccess({ ...fixture, stdio: "" }).status, "unknown");
  assert.equal(inspectNativeAccess({ ...fixture, session: "" }).status, "unknown");
  assert.equal(inspectNativeAccess({ ...fixture, protectedLog: fixture.protectedLog.split("\n")
    .map(line => `\x1b[36;1m${line}\x1b[0m`).join("\n") }).status, "unknown");
});

test("protected native invocation identity, repository, state and source-defined limit must match", () => {
  for (const changed of [
    fixture.protectedLog.replaceAll('"repo":"gh-aw"', '"repo":"other"'),
    fixture.protectedLog.replaceAll('"state":"OPEN"', '"state":"CLOSED"'),
    fixture.protectedLog.replaceAll('"perPage":3', '"perPage":30'),
    fixture.protectedLog.replace('"type":"item.completed","item":{"id":"item_3"', '"type":"item.completed","item":{"id":"item_9"'),
  ]) assert.equal(inspectNativeAccess({ ...fixture, protectedLog: changed }).status, "unknown");
  assert.equal(inspectNativeAccess({ ...fixture, step: {
    started_at: "2026-10-03T04:00:00Z", completed_at: "2026-10-03T04:00:01Z",
  } }).status, "unknown");
});

test("gateway request argument key ordering is irrelevant but values and the official backend are binding", () => {
  assert.equal(inspectNativeAccess({ ...fixture, rpc: modifyRows(fixture.rpc, row => {
    if (row.payload?.params?.name === "list_issues") {
      row.payload.params.arguments = { fields: ["number", "title", "state"], state: "OPEN", perPage: 3, repo: "gh-aw", owner: "github" };
    }
    return row;
  }) }).status, "accepted");
  assert.equal(inspectNativeAccess({ ...fixture, githubLog: fixture.githubLog.replace("https://api.githubcopilot.com/mcp/", "https://example.invalid/mcp/") }).status, "unknown");
  assert.equal(inspectNativeAccess({ ...fixture, rpc: modifyRows(fixture.rpc, row => {
    if (row.payload?.params?.name === "list_issues") row.payload.params.arguments.perPage = 30;
    return row;
  }) }).status, "unknown");
});

test("missing or overlapping gateway exchanges cannot be joined through reused response IDs", () => {
  const rows = fixture.rpc.trim().split("\n").map(JSON.parse);
  const index = rows.findIndex(row => row.payload?.params?.name === "list_issues");
  const extra = structuredClone(rows[index]);
  rows.splice(index, 0, extra);
  assert.equal(inspectNativeAccess({ ...fixture, rpc: rows.map(JSON.stringify).join("\n") }).status, "unknown");
  assert.equal(inspectNativeAccess({ ...fixture, rpc: modifyRows(fixture.rpc, row => {
    if (row.payload?.params?.name === "list_issues") row.event = "unavailable";
    return row;
  }) }).status, "unknown");
});

test("upstream issue bytes and filtered resource identities must independently agree", () => {
  for (const changed of [
    fixture.rpc.replace('"number":"65234"', '"number":"99999"'),
    fixture.rpc.replace('"event":"difc_filtered"', '"event":"missing_filter"'),
    fixture.rpc.replaceAll('unapproved:public', 'approved:public'),
  ]) assert.equal(inspectNativeAccess({ ...fixture, rpc: changed }).status, "unknown");
  const session = modifyRows(fixture.session, row => {
    if (row.type === "tool.execution_complete" && row.data?.toolName === "list_issues") row.data.success = false;
    return row;
  });
  assert.equal(inspectNativeAccess({ ...fixture, session }).status, "unknown");
});

test("native parsers surface malformed originals instead of successful empty populations", () => {
  assert.throws(() => inspectNativeAccess({ ...fixture, rpc: "not JSON" }), SyntaxError);
  assert.throws(() => inspectNativeAccess({ ...fixture, step: {} }), /Malformed original/);
});

test("the actual collector allocates native access once without carrying it into newer periods", async () => {
  const observedAt = "2026-10-18T15:00:12Z";
  const packets = await collectBatch([
    { windowStart: "2026-09-27T15:00:12Z", windowEnd: "2026-10-04T15:00:12Z", observedAt },
    { windowStart: "2026-10-04T15:00:12Z", windowEnd: "2026-10-11T15:00:12Z", observedAt },
    { windowStart: "2026-10-11T15:00:12Z", windowEnd: observedAt, observedAt },
    { windowStart: "2026-03-08T15:00:12Z", windowEnd: "2026-03-15T15:00:12Z", observedAt },
  ]);
  assert.deepEqual(packets.map(row => scoreMetric("native-access", row.evidence)), [1, null, null, null]);
  assert.equal(scoreMetric("filtered-resources", packets[0].evidence), 3);
  assert.equal(scoreMetric("upstream-issues", packets[0].evidence), 3);
  assert.equal(packets[0].evidence.cases[0].agentIssueReadback, null);
  for (const row of packets) {
    assert.equal(row.evidence.fullGoal, null);
    assert.equal(row.evidence.workflowContribution, null);
    assert.equal(row.evidence.costs, null);
  }
  await assert.rejects(collectBatch([{ windowStart: observedAt, windowEnd: observedAt, observedAt }]), /Invalid Codex/);
});

test("native access scoring preserves scoped rejection, unknowns and distinct attempt identities", () => {
  const examples = definition.validationExamples;
  assert.equal(scoreMetric("native-access", examples.targetAttained), 1);
  assert.equal(scoreMetric("native-access", examples.targetMissed), 0);
  assert.equal(scoreMetric("native-access", examples.missing), null);
  assert.equal(scoreMetric("native-access", examples.malformed), null);
  assert.equal(scoreMetric("native-access", { ...examples.targetAttained,
    cases: [...examples.targetAttained.cases, ...examples.targetAttained.cases] }), null);
});
