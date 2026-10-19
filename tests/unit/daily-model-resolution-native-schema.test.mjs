import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inspectNativeBindingSchema } from "../../docs/operational-value/proof/daily-model-resolution/native-schema-decoder.mjs";

const directory = new URL("../../docs/operational-value/proof/daily-model-resolution/native-schema-source/", import.meta.url);
const session = readFileSync(new URL("235e45b977f4e12a88b53efc70adc9f1a5f5fab1.blob", directory), "utf8");
const proxy = readFileSync(new URL("9ceaea6a74b40d3d9c051af1d56a7e884ddb0e95.blob", directory), "utf8");
const rows = input => input.trim().split("\n").map(line => JSON.parse(line));
const jsonl = values => values.map(row => JSON.stringify(row)).join("\n");

test("complete native fixtures expose lifecycle and proxy facts but no shared request identity", () => {
  const result = inspectNativeBindingSchema(session, proxy);
  assert.equal(result.sessionRecords, 35);
  assert.equal(result.nativeChildStarts, 5);
  assert.equal(result.proxyRequests, 29);
  assert.equal(result.routingClassifierRequests, 1);
  assert.equal(result.sessionPerRequestIds, 0);
  assert.equal(result.sharedRequestIds, 0);
  assert.equal(result.aggregateSnapshotEvents, 2);
  assert.equal(result.exactBindingsSupported, false);
  assert.equal(result.sourceDeclaredModelsAvailable, false);
  assert.equal(result.nativeResolutionValue, null);
});

test("matching models, timestamps and initiator cannot substitute for child dispatch identity", () => {
  const first = rows(proxy)[2];
  const native = rows(session);
  const start = native.find(row => row.type === "subagent.started");
  first.timestamp = start.timestamp;
  first.model = start.data.model;
  first.x_initiator = "agent";
  const result = inspectNativeBindingSchema(jsonl(native), jsonl([first]));
  assert.equal(result.exactBindingsSupported, false);
  assert.equal(result.nativeResolutionValue, null);
});

test("a caller-invented request match or child field does not enable outcome acceptance", () => {
  const native = rows(session);
  const proxyRows = rows(proxy);
  native.find(row => row.type === "subagent.started").data.requestId = proxyRows[2].request_id;
  const inspected = inspectNativeBindingSchema(jsonl(native), jsonl(proxyRows));
  assert.equal(inspected.sharedRequestIds, 1);
  assert.equal(inspected.exactBindingsSupported, false);
  assert.equal(inspected.nativeResolutionValue, null);
  proxyRows[2].agentId = native.find(row => row.type === "subagent.started").agentId;
  assert.throws(() => inspectNativeBindingSchema(jsonl(native), jsonl(proxyRows)), /Unreviewed proxy child/);
});

test("malformed, duplicate, unsupported and multi-session records fail explicitly", () => {
  assert.throws(() => inspectNativeBindingSchema("{broken", proxy), /invalid JSON on line 1/);
  assert.throws(() => inspectNativeBindingSchema("[]", proxy), /non-object/);
  const duplicated = rows(proxy);
  duplicated.push(duplicated[1]);
  assert.throws(() => inspectNativeBindingSchema(session, jsonl(duplicated)), /duplicate proxy/);
  const unsupported = rows(proxy);
  unsupported[0]._schema = "token-usage/unreviewed";
  assert.throws(() => inspectNativeBindingSchema(session, jsonl(unsupported)), /Unreviewed proxy schema/);
  const native = rows(session);
  native.push({ ...native[0], data: { ...native[0].data, sessionId: "another-session" } });
  assert.throws(() => inspectNativeBindingSchema(jsonl(native), proxy), /one explicit native session/);
});
