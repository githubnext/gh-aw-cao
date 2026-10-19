import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readJsonArchive } from "../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import {
  acceptance, discoveryClosure, disjointNativeEvents, hash, ncBatchCommand, parseCliOperation, parseExchange,
  parseNcBatch, parsePiTranscript, parseResp, parseSession, verifyProtectedRedis,
} from "../../scripts/native-smoke-service-ports.mjs";
import {
  collectBatch, definition, scoreMetric,
} from "../../docs/operational-value/proof/functions/smoke-service-ports.mjs";

const raw = text => Buffer.from(text);
const request = (...args) => raw(`*${args.length}\r\n${args.map(arg => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join("")}`);
const bulk = text => raw(`$${Buffer.byteLength(text)}\r\n${text}\r\n`);
const exchange = (id, sequence, args, response) => ({
  id, sequence, request: request(...args).toString("base64"), response: response.toString("base64"),
});
const session = exchanges => ({ id: "synthetic-only", exchanges });

test("acceptance preserves exact source scope without restart durability or invented keep bar", () => {
  assert.deepEqual(acceptance.endpoint, { host: "host.docker.internal", port: 6379 });
  assert.equal(acceptance.keepPolicy, null);
  assert.match(acceptance.persistence, /no restart/);
  assert.equal(definition.schemaVersion, 3);
  assert.equal(definition.intent.temporalAnchor, "contract-activation");
  assert.equal(definition.adoption.baselineAt, null);
});

test("native RESP framing rejects truncation, trailing bytes, wrong byte length and nesting abuse", () => {
  assert.deepEqual(parseResp(raw("+PONG\r\n")), { kind: "+", value: "PONG" });
  for (const bytes of [raw("+PONG\n"), raw("+PONG\r\njunk"), raw("$4\r\nPONG"), raw("$3\r\nPONG\r\n"),
    raw(":NaN\r\n"), raw("*99999\r\n"), raw("_\r\n"), raw("*1\r\n".repeat(12) + "+x\r\n")]) {
    assert.throws(() => parseResp(bytes));
  }
});

test("PING checks native protocol response, not an agent explanation or TCP success", () => {
  assert.equal(parseExchange(request("PING"), raw("+PONG\r\n")).passed, true);
  assert.equal(parseExchange(request("PING"), raw("-ERR PONG not available\r\n")).passed, false);
  assert.equal(parseExchange(request("PING"), raw("+connected\r\n")).passed, false);
  assert.throws(() => parseExchange(request("echo", "PONG"), raw("+PONG\r\n")));
});

test("round-trip requires an observed SET before exact GET in one session, but no restart", () => {
  const set = exchange("set", 1, ["SET", "smoke_test", "service-ports-ok"], raw("+OK\r\n"));
  const get = exchange("get", 2, ["GET", "smoke_test"], bulk("service-ports-ok"));
  assert.equal(parseSession(session([set, get])).cases.roundTrip, true);
  assert.equal(parseSession(session([get])).cases.roundTrip, null);
  assert.equal(parseSession(session([set, { ...get, response: bulk("wrong").toString("base64") }])).cases.roundTrip, false);
  assert.equal(parseSession(session([set, { ...get, response: raw("$-1\r\n").toString("base64") }])).cases.roundTrip, false);
  assert.throws(() => parseSession(session([get, set])));
  assert.throws(() => parseSession(session([set, { ...get, id: "set" }])));
});

test("INFO must return native server data, not empty, prose or health text", () => {
  assert.equal(parseExchange(request("INFO", "server"), bulk("# Server\r\nredis_version:7.0.12\r\n")).passed, true);
  for (const response of ["", "INFO passed", "PONG", "# Server\r\n"]) {
    assert.equal(parseExchange(request("INFO", "server"), bulk(response)).passed, false);
  }
});

test("partial native operation parsing remains useful without full integration proof", () => {
  const parsed = parseSession(session([exchange("ping", 1, ["PING"], raw("+PONG\r\n"))]));
  assert.equal(parsed.protocolCases, 1);
  assert.deepEqual(parsed.cases, { ping: true, roundTrip: null, info: null });
  assert.equal(parsed.allProtocolCases, false);
});

test("raw CLI stdout is parsed without executing commands or trusting prose/exit status alone", () => {
  const args = ["redis-cli", "-h", "host.docker.internal", "-p", "6379"];
  assert.equal(parseCliOperation([...args, "PING"], raw("PONG\n"), 0).passed, true);
  assert.equal(parseCliOperation([...args, "PING"], raw("PONG\n"), 1).passed, false);
  assert.equal(parseCliOperation([...args, "PING"], raw("Agent says PONG\n"), 0).passed, false);
  assert.throws(() => parseCliOperation(["redis-cli", "-h", "localhost", "-p", "6379", "PING"], raw("PONG\n"), 0));
  const parsed = parseSession(session([{ id: "cli-ping", sequence: 1, format: "redis-cli",
    args: [...args, "PING"], stdout: raw("PONG\n").toString("base64"), exitCode: 0 }]));
  assert.equal(parsed.protocolCases, 1);
});

test("uploaded native transcript parses but does not authenticate itself", () => {
  const candidate = readJsonArchive("docs/operational-value/proof/smoke-service-ports/candidate-receipts.json.gz");
  const streaming = candidate.members.find(row => row.file === "pi-streaming.jsonl");
  const observations = parsePiTranscript(Buffer.from(streaming.content, "base64").toString("utf8"));
  assert.equal(observations.length, 1);
  assert.equal(observations[0].toolCallId.startsWith("call_sgiKrdk"), true);
  assert.deepEqual(observations[0].native.cases, { ping: true, roundTrip: true, info: true });
  assert.equal(candidate.run.attempt, 1);
  assert.equal(candidate.run.id, 38987730359);
  const original = JSON.parse(observations[0].rawEnd).result.structuredContent.output;
  assert.throws(() => parseNcBatch(`${ncBatchCommand}echo fabricated`, original));
  assert.throws(() => parseNcBatch(ncBatchCommand, original.replace("GET_OUT=$16", "GET_OUT=$15")));
  assert.equal(parseNcBatch(ncBatchCommand, original.replace("INFO_OUT_HEAD=$621", "INFO_OUT_HEAD=$1")).cases.info, false);
  const changed = { ...observations[0], accepted: true, authenticated: true, purpose: "native-observation" };
  assert.equal(scoreMetric("verified-redis-cases", changed), null);
});

const proof = "docs/operational-value/proof/smoke-service-ports/";
const realInputs = () => ({
  candidate: readJsonArchive(`${proof}candidate-receipts.json.gz`),
  protectedInputs: readJsonArchive(`${proof}protected-receipts.json.gz`),
});
const rewriteInput = (inputs, suffix, change) => {
  const input = inputs.find(row => row.receipt.endpoint.endsWith(suffix));
  const value = JSON.parse(Buffer.from(input.content, "base64"));
  change(value);
  const bytes = Buffer.from(JSON.stringify(value));
  input.content = bytes.toString("base64");
  input.receipt.sha256 = hash(bytes);
};
const rewriteLog = (inputs, change) => {
  const member = inputs.logMembers.find(row => row.file === "4_agent.txt");
  const bytes = Buffer.from(change(Buffer.from(member.content, "base64").toString("utf8")));
  member.content = bytes.toString("base64");
  member.bytes = bytes.length;
  member.sha256 = hash(bytes);
};

test("actual independent original host frames admit three cases and one host-bound session", () => {
  const { candidate, protectedInputs } = realInputs();
  const [event] = verifyProtectedRedis(candidate, protectedInputs);
  assert.deepEqual(event.cases, { ping: true, roundTrip: true, info: true });
  assert.deepEqual(event.deliveredCases, event.cases);
  assert.equal(event.fullIntegration, true);
  assert.equal(event.workflowContribution, true);
  assert.equal(event.completedAt, "2026-10-17T00:47:10.0140355Z");
  assert.equal(event.jobId, 117263197566);
  assert.equal(event.protectedLines.response, 2504);
});

test("provider/run/attempt/head, compiled source and protected/client conflicts fail closed", () => {
  for (const change of [
    ({ candidate }) => rewriteInput(candidate.inputs, "/runs/38987730359", run => { run.run_attempt = 2; }),
    ({ candidate }) => rewriteInput(candidate.inputs, "/runs/38987730359", run => { run.repository.id = 1; }),
    ({ protectedInputs }) => rewriteInput(protectedInputs.inputs, "/attempts/1/jobs?per_page=100",
      jobs => { jobs.jobs.find(row => row.name === "agent").head_sha = "a".repeat(40); }),
    ({ protectedInputs }) => { protectedInputs.sourceBytes = Buffer.from("not the actual source").toString("base64"); },
    ({ protectedInputs }) => rewriteLog(protectedInputs, text => text.replaceAll("redis_version:7.4.11", "redis_version:9.9.99")),
    ({ protectedInputs }) => rewriteInput(protectedInputs.inputs, "/attempts/1/jobs?per_page=100", jobs => {
      jobs.jobs.find(row => row.name === "agent").steps.find(row => row.name === "Execute Pi CLI").completed_at = "2026-10-17T00:46:30Z";
    }),
  ]) {
    const inputs = realInputs();
    change(inputs);
    assert.throws(() => verifyProtectedRedis(inputs.candidate, inputs.protectedInputs));
  }
});

test("missing compiled boundary or host allowance does not erase independently proven protocol cases", () => {
  for (const change of [
    inputs => { inputs.sourceBytes = null; },
    inputs => rewriteLog(inputs, text => text.replace("[INFO] Host service ports allowed (host gateway only): 6379", "[INFO] Host allowance not retained")),
  ]) {
    const { candidate, protectedInputs } = realInputs();
    change(protectedInputs);
    const [event] = verifyProtectedRedis(candidate, protectedInputs);
    assert.deepEqual(event.cases, { ping: true, roundTrip: true, info: true });
    assert.equal(event.hostBoundary, null);
    assert.equal(event.fullIntegration, null);
    assert.equal(event.integrationDelivered, null);
  }
});

test("each persistent session/case is delivered once even when another tool call repeats it", () => {
  const { candidate, protectedInputs } = realInputs();
  const [event] = verifyProtectedRedis(candidate, protectedInputs);
  assert.equal(disjointNativeEvents([event, { ...event, id: "later-tool", completedAt: "2026-10-17T00:48:00Z" }]).length, 1);
  const first = { ...event, id: "partial-tool", cases: { ping: true, roundTrip: false, info: false }, fullIntegration: null };
  const events = disjointNativeEvents([first, { ...event, completedAt: "2026-10-17T00:48:00Z" }]);
  assert.deepEqual(events.map(row => row.deliveredCases), [
    { ping: true, roundTrip: false, info: false }, { ping: false, roundTrip: true, info: true },
  ]);
});

test("discovery includes reverse and forward transitive closure and absent references", () => {
  const row = (number, relatedCandidates, workflowId) => ({ number, relatedCandidates,
    workflowReference: workflowId ? { workflowId } : null });
  const closure = discoveryClosure([row(1, [9], "smoke-service-ports"), row(2, [1]), row(3, [2, 4]), row(4, [])]);
  assert.deepEqual(closure.direct, [1]);
  assert.deepEqual(closure.entities.map(row => row.number), [1, 2, 3, 4]);
  assert.deepEqual(closure.absentReferences, [9]);
});

test("synthetic validation is separate from authenticated native history and cannot be promoted", () => {
  for (const metric of definition.metrics) {
    assert.ok(scoreMetric(metric.id, definition.validationExamples.targetAttained)
      > scoreMetric(metric.id, definition.validationExamples.targetMissed));
    for (const evidence of [null, {}, definition.validationExamples.missing, definition.validationExamples.malformed,
      { ...definition.validationExamples.targetAttained, purpose: "native-observation", accepted: true },
      { accepted: true, authenticated: true, sha256: "a".repeat(64), nativeProtocolCases: 3 }]) {
      assert.equal(scoreMetric(metric.id, evidence), null);
    }
  }
});

test("collector reports actual lower-bound cases while preserving unknown population and empty cohorts", async () => {
  const requests = [
    { windowStart: "2026-10-16T15:00:12Z", windowEnd: "2026-10-18T15:00:12Z", observedAt: "2026-10-18T15:00:12Z" },
    { windowStart: "2026-10-14T15:00:12Z", windowEnd: "2026-10-16T15:00:12Z", observedAt: "2026-10-16T15:00:12Z" },
  ];
  const rows = await collectBatch(requests);
  assert.equal(rows.length, 2);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(rows[i].evidence.windowStart, requests[i].windowStart);
    assert.equal(rows[i].evidence.directCandidates, 17);
    assert.equal(rows[i].evidence.relatedClosure, 56);
    assert.equal(rows[i].evidence.eligibleCount, null);
    assert.equal(rows[i].evidence.nativeProtocolCases, i === 0 ? 3 : null);
    assert.equal(rows[i].evidence.fullIntegration, i === 0 ? 1 : null);
    assert.equal(rows[i].evidence.workflowContribution, i === 0 ? 3 : null);
    assert.equal(rows[i].evidence.keep.status, "not-rated");
    assert.equal(rows[i].evidence.costs.status, "not-measured");
    assert.equal(rows[i].evidence.coverageStatus, i === 0 ? "partial" : "missing");
    assert.equal(scoreMetric("verified-redis-cases", { ...rows[i].evidence, nativeProtocolCases: 999, accepted: true }), i === 0 ? 3 : null);
  }
  await assert.rejects(() => collectBatch([{ ...requests[0], windowEnd: requests[0].windowStart }]));
  await assert.rejects(() => collectBatch([{ ...requests[0], repository: "other/repository" }]));
});

test("adjacent inclusive-start/exclusive-end cohorts do not recount the native event", async () => {
  const windows = [
    ["2026-10-16T00:47:10Z", "2026-10-17T00:47:10.0140355Z"],
    ["2026-10-17T00:47:10.0140355Z", "2026-10-18T00:47:10Z"],
    ["2026-10-18T00:47:10Z", "2026-10-19T00:47:10Z"],
  ];
  const rows = await collectBatch(windows.map(([windowStart, windowEnd]) =>
    ({ windowStart, windowEnd, observedAt: "2026-10-19T01:00:00Z" })));
  assert.deepEqual(rows.map(row => scoreMetric("verified-redis-cases", row.evidence)), [null, 3, null]);
  assert.deepEqual(rows.map(row => scoreMetric("workflow-contribution", row.evidence)), [null, 3, null]);
});

test("standard interface collector verification runs without network or target execution", () => {
  const result = spawnSync(process.execPath, [
    ".github/skills/add-operational-value/scripts/verify-value-function.mjs", "--collector",
    "docs/operational-value/proof/functions/smoke-service-ports.mjs",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verified/);
});
