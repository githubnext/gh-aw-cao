import assert from "node:assert/strict";
import test from "node:test";
import { resolveAuthority, resolveEnvelope, validateEnvelope, validateNarrowing } from "../../.github/workflows/shared/authority.mjs";
import { controlSettings, parsePolicy } from "../../.github/workflows/shared/policy.mjs";
import { operationRequest, resolveOperation } from "../../.github/workflows/shared/operations.mjs";

const binding = {
  repository: "acme/control", policySha: "1".repeat(40),
  workflowRef: "acme/control/.github/workflows/audit.lock.yml@refs/heads/main", runId: "12", runAttempt: "1",
};
const policy = {
  operation: "audit", enabled: true, mode: "live", maxTargets: 2,
  scope: { owners: ["acme"], repositories: ["acme/one", "acme/two"] },
};
const request = { version: 1, operation: "audit", targets: ["acme/one", "acme/two"], mode: "review", destination: "acme/control" };
const envelope = () => resolveEnvelope(policy, request, binding).envelope;
const document = operations => ({
  version: 1, "gh-aw-version": "v0.93.1",
  "control-plane": { scope: { "allowed-owners": ["acme"] }, operations },
});

test("authority resolution is independent of workflow topology and narrows ceilings", () => {
  assert.deepEqual(resolveAuthority({ mode: "live", maxMode: "review", maxTargets: 3,
    targets: { "ACME/One": { mode: "live" } } }, { maxTargets: 2 }), {
    mode: "review", maxTargets: 2, targets: { "acme/one": { mode: "review" } },
  });
  const result = resolveEnvelope(policy, request, binding);
  assert.equal(result.decision, "allow");
  assert.equal(result.envelope.delegation, false);
  assert.deepEqual(result.envelope.grants, [
    { target: "acme/one", mode: "review", destination: "acme/control" },
    { target: "acme/two", mode: "review", destination: "acme/control" },
  ]);
  assert.equal("campaign" in result.envelope, false);
  assert.equal("inventory" in result.envelope, false);
  assert.equal("role" in result.envelope, false);
});

for (const [name, change, error] of [
  ["version", value => { value.version = 2; }, /version/],
  ["identity", value => { value.operation = ""; }, /identity/],
  ["policy revision", value => { value.binding.policySha = "2".repeat(40); }, /binding mismatch/],
  ["run", value => { value.binding.runId = "13"; }, /binding mismatch/],
  ["attempt", value => { value.binding.runAttempt = "2"; }, /binding mismatch/],
  ["workflow", value => { value.binding.workflowRef += "other"; }, /binding mismatch/],
  ["limit", value => { value.maxTargets = 1; }, /target limit/],
  ["duplicate", value => { value.grants[1].target = "ACME/ONE"; }, /duplicate/],
  ["mode", value => { value.grants[0].mode = "debug"; }, /review or live/],
  ["unknown control", value => { value.requirements.push("shell-write"); }, /enforcement control/],
  ["missing control", value => { value.requirements.pop(); }, /enforcement control/],
  ["delegation", value => { value.delegation = true; }, /delegation/],
  ["unknown authority", value => { value.permissions = "write"; }, /unknown key/],
]) {
  test(`envelope validation rejects ${name}`, () => {
    const value = envelope();
    change(value);
    assert.throws(() => validateEnvelope(value, binding), error);
  });
}

for (const [name, change] of [
  ["mode", value => { value.grants[0].mode = "live"; }],
  ["target", value => { value.grants[0].target = "acme/three"; }],
  ["destination", value => { value.grants[0].destination = "acme/other"; }],
  ["limit", value => { value.maxTargets = 3; }],
  ["operation", value => { value.operation = "other"; }],
  ["policy", value => { value.binding.policySha = "2".repeat(40); }],
]) {
  test(`verified handoff comparison rejects widening ${name}`, () => {
    const child = envelope();
    change(child);
    assert.throws(() => validateNarrowing(envelope(), child), /authority|grant/);
  });
}

test("verified handoff comparison permits a strict subset with unchanged scoped destination", () => {
  const child = envelope();
  child.maxTargets = 1;
  child.grants.pop();
  assert.equal(validateNarrowing(envelope(), child), child);
});

for (const [name, changes, error] of [
  ["target scope", { targets: ["outside/one"] }, /outside/],
  ["repository allowlist", { targets: ["acme/three"] }, /not allowed/],
  ["target count", { targets: ["acme/one", "acme/two"], maxTargets: 1 }, /exceed/],
  ["target list", { targets: "acme/one" }, /explicit targets/],
  ["empty targets", { targets: [] }, /explicit targets/],
  ["mode escalation", { mode: "debug" }, /review or live/],
  ["request version", { version: 2 }, /version/],
  ["request authority injection", { binding }, /unknown key/],
  ["output owner", { destination: "outside/review" }, /outside/],
]) {
  test(`operation resolution rejects ${name}`, () => {
    assert.throws(() => resolveEnvelope(policy, { ...request, ...changes }, binding), error);
  });
}

test("disabled operation returns an explicit denial", () => {
  assert.deepEqual(resolveEnvelope({ ...policy, enabled: false }, request, binding),
    { decision: "deny", reason: "operation-disabled" });
});

test("operations policy and schema have no fleet or execution configuration", () => {
  for (const key of ["workers", "rollout-percent", "inventory", "permissions", "tools", "engine", "monthly-ai-credit-budget"]) {
    assert.throws(() => parsePolicy(JSON.stringify(document({ audit: { [key]: {} } }))), /unknown key/);
  }
  const parsed = parsePolicy(JSON.stringify(document({ audit: { "max-repositories": 2 } })));
  assert.deepEqual(controlSettings(parsed, "acme/control").operations, { audit: { "max-repositories": 2, enabled: true, mode: "review" } });
  assert.equal(resolveOperation(parsed, request, binding).authority_envelope.operation, "audit");
});

test("policy rejects ambiguous workflow ownership", () => {
  const value = document({ audit: {} });
  value["control-plane"].workflows = { audit: {} };
  assert.throws(() => parsePolicy(JSON.stringify(value)), /conflicts/);
  delete value["control-plane"].workflows;
  value["control-plane"].campaigns = { maintenance: { workers: { check: { workflow: "audit" } } } };
  assert.throws(() => parsePolicy(JSON.stringify(value)), /conflicts/);
});

test("direct operation request rejects mixed, malformed, oversized and dispatch inputs", () => {
  for (const env of [
    { CAO_TARGET_REPOSITORY: "acme/one", CAO_TARGET_REPOSITORIES: '["acme/two"]' },
    { CAO_TARGET_REPOSITORIES: "[" },
    { CAO_TARGET_REPOSITORIES: " ".repeat(65537) },
    { CAO_CORRELATION_ID: "12-1" },
    { CAO_REQUESTED_ROLLOUT_PERCENT: "50" },
  ]) assert.throws(() => operationRequest(env));
});
