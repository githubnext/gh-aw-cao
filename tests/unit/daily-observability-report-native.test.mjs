import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { collectBatch, definition, inspectTelemetry, scoreMetric } from "../../docs/operational-value/proof/functions/daily-observability-report.mjs";

const hash = text => createHash("sha256").update(text).digest("hex");
const at = "2026-10-17T00:00:00Z";
const request = { windowStart: "2026-10-12T00:00:00Z", windowEnd: "2026-10-19T00:00:00Z", observedAt: "2026-10-19T00:00:00Z" };
const rpc = { timestamp: at, direction: "OUT", event: "rpc_request", _schema: "rpc-message/v2",
  server_id: "github", payload: { method: "tools/call", params: { name: "read" }, id: 1 } };
const raw = `${JSON.stringify(rpc)}\n`;
function input(files = [{ path: "nested/artifact/mcp-logs/rpc-messages.jsonl", content: raw, sha256: hash(raw) }]) {
  return { schemaVersion: 1, snapshots: [{
    ...request, repository: definition.repository, profileRevision: definition.profile.revision,
    profileSourceBlob: definition.profile.sourceBlob, inventorySha256: hash("synthetic-inventory"),
    inventoryRef: "synthetic-fixture", selectionComplete: true,
    runs: [{ id: 1, workflow: "example", createdAt: at, headSha: "a".repeat(40),
      configurationSha256: hash("synthetic-config"), configurationRef: "synthetic-fixture", mcpConfigured: true,
      selectionReason: "failed", artifactsComplete: true, artifactManifestSha256: hash("synthetic-manifest"),
      artifactManifestRef: "synthetic-fixture", files }],
  }] };
}

test("both RPC schemas and native legacy precedence, including filtered records", () => {
  assert.equal(inspectTelemetry("rpc-messages.jsonl", raw).usable, true);
  assert.equal(inspectTelemetry("rpc-messages.jsonl", JSON.stringify({ ...rpc, event: undefined, type: "REQUEST" })).usable, true);
  assert.equal(inspectTelemetry("rpc-messages.jsonl", JSON.stringify({ ...rpc, type: "RESPONSE" })).usable, false);
  assert.equal(inspectTelemetry("rpc-messages.jsonl", JSON.stringify({
    timestamp: at, event: "difc_filtered", server_id: "github", tool_name: "read", reason: "blocked",
  })).usable, true);
});

test("empty, malformed, missing fields and status-only evidence do not prove telemetry", () => {
  for (const value of ["", "broken", "null", "[]", '{"status":200}', `${raw}{broken`]) {
    assert.equal(inspectTelemetry("rpc-messages.jsonl", value).usable, false);
  }
  const gateway = { timestamp: at, level: "info", type: "mcp", event: "tool_call", server_name: "github",
    tool_name: "read", duration: 0, status: "success" };
  assert.equal(inspectTelemetry("gateway.jsonl", JSON.stringify(gateway)).usable, true);
  assert.equal(inspectTelemetry("gateway.jsonl", JSON.stringify({ ...gateway, duration: undefined })).usable, false);
});

test("recursive inventory is independent of artifact prefixes; verified absence is zero", async () => {
  const [present] = await collectBatch([request], { input: input() });
  assert.equal(scoreMetric("usable-mcp-coverage", present.evidence), 100);
  assert.equal(present.evidence.fullAcceptance, null);
  assert.equal(present.evidence.contribution, null);
  const [absent] = await collectBatch([request], { input: input([]) });
  assert.equal(scoreMetric("usable-mcp-coverage", absent.evidence), 0);
  const [missing] = await collectBatch([request]);
  assert.equal(scoreMetric("usable-mcp-coverage", missing.evidence), null);
});

test("native partial subtotal survives missing peer artifacts but does not become full coverage", async () => {
  const evidence = input();
  evidence.snapshots[0].runs.push({ ...evidence.snapshots[0].runs[0], id: 2, artifactsComplete: false });
  const [result] = await collectBatch([request], { input: evidence });
  assert.equal(scoreMetric("usable-mcp-coverage", result.evidence), null);
  assert.equal(scoreMetric("verified-usable-runs", result.evidence), 1);
  assert.equal(result.evidence.coverageStatus, "partial");
});

test("digest, scope, duplicate and unsafe-path defects fail closed", async () => {
  const bad = input(); bad.snapshots[0].runs[0].files[0].sha256 = "0".repeat(64);
  await assert.rejects(collectBatch([request], { input: bad }), /digest mismatch/);
  const duplicate = input(); duplicate.snapshots.push(duplicate.snapshots[0]);
  await assert.rejects(collectBatch([request], { input: duplicate }), /Conflicting/);
  const unsafe = input(); unsafe.snapshots[0].runs[0].files[0].path = "../rpc-messages.jsonl";
  await assert.rejects(collectBatch([request], { input: unsafe }), /Unsafe/);
  await assert.rejects(collectBatch([{ ...request, repository: "different/repo" }]), /Invalid/);
  const old = { windowStart: "2026-09-01T00:00:00Z", windowEnd: "2026-09-08T00:00:00Z", observedAt: "2026-09-08T00:00:00Z" };
  const historical = input(); Object.assign(historical.snapshots[0], old);
  await assert.rejects(collectBatch([old], { input: historical }), /cannot be backdated/);
});
