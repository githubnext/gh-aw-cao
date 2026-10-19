import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { effectivePolicy, parsePolicy } from "../../.github/workflows/shared/policy.mjs";

function document(workflow = {}, control = {}) {
  return {
    version: 1,
    "gh-aw-version": "v0.92.5",
    "control-plane": {
      scope: { "allowed-owners": ["acme"], "allowed-repositories": ["acme/one", "acme/two"] },
      workflows: { audit: workflow },
      ...control,
    },
  };
}

function resolve(policy = document(), options = {}) {
  return effectivePolicy(parsePolicy(JSON.stringify(policy)), {
    role: "standalone",
    workflowName: "audit",
    controlRepository: "acme/control",
    ...options,
  });
}

test("standalone policy resolves without a campaign, worker, or campaign record", () => {
  const result = resolve();
  assert.equal(result.authorized, true);
  assert.equal(result.control_role, "standalone");
  assert.equal(result.workflow, "audit");
  assert.equal(result.campaign, "");
  assert.equal(result.worker, "");
  assert.equal(result.safe_output_mode, "review");
  assert.equal(result.max_repositories, 1);
  assert.equal(result.rollout_percent, 100);
  assert.deepEqual(result.worker_policies, {});
  assert.deepEqual(result.allowed_repositories, ["acme/one", "acme/two"]);
});

test("workflow declarations and kill switches never fall back to campaigns or prototype keys", () => {
  assert.equal(resolve(document({}, { workflows: {}, campaigns: { audit: {} } })).reason, "workflow-undeclared");
  assert.equal(resolve(document({ enabled: false })).reason, "workflow-disabled");
  assert.equal(resolve(document(), { workflowName: "constructor" }).reason, "workflow-undeclared");
  assert.equal(resolve({ version: 1, "target-authority": { campaigns: {} } }).reason, "control-plane-absent");
});

test("standalone defaults, target modes, ceiling, and request narrowing are cumulative", () => {
  const policy = document({
    "max-repositories": 8,
    "rollout-percent": 50,
    targets: { "acme/one": { mode: "live" } },
  }, {
    defaults: { mode: "review", "max-repositories": 10, "rollout-percent": 80 },
  });
  const inherited = resolve(policy);
  assert.equal(inherited.safe_output_mode, "review");
  assert.equal(inherited.target_policies["acme/one"].mode, "live");
  assert.equal(inherited.max_repositories, 8);
  assert.equal(inherited.rollout_percent, 50);
  assert.equal(resolve(policy, { targetRepository: "ACME/ONE" }).safe_output_mode, "live");
  const narrowed = resolve(policy, {
    requestedMode: "review", requestedMaxRepositories: "3", requestedRolloutPercent: "25",
  });
  assert.equal(narrowed.target_policies["acme/one"].mode, "review");
  assert.equal(narrowed.max_repositories, 3);
  assert.equal(narrowed.rollout_percent, 25);
  policy["control-plane"].workflows.audit["max-mode"] = "review";
  const ceiling = resolve(policy, { targetRepository: "acme/one" });
  assert.equal(ceiling.safe_output_mode, "review");
  assert.equal(ceiling.target_policies["acme/one"].mode, "review");
  assert.throws(() => resolve(policy, { targetRepository: "acme/one", requestedMode: "live" }), /exceeds checked-in policy/);
});

test("standalone runs reject widened limits, debug, and ambiguous static identities", () => {
  for (const [options, expected] of [
    [{ requestedMaxRepositories: "2" }, /max_repositories exceeds/],
    [{ requestedRolloutPercent: "101" }, /rollout_percent must be an integer/],
    [{ requestedMode: "live" }, /safe_output_mode exceeds/],
    [{ requestedMode: "debug", eventName: "workflow_dispatch" }, /debug requires a manual workflow_dispatch worker run/],
    [{ campaignName: "audit" }, /must not specify a campaign or worker/],
    [{ workerName: "worker" }, /must not specify a campaign or worker/],
    [{ workflowName: "../audit" }, /workflow identity has an invalid value/],
    [{ role: "orchestrator", campaignName: "audit" }, /workflow identity is forbidden for campaign roles/],
  ]) assert.throws(() => resolve(document(), options), expected);
});

test("standalone policy rejects capabilities, topology declarations, invalid scopes, and persistent debug", () => {
  for (const workflow of [
    { workers: {} }, { engine: "copilot" }, { tools: {} }, { permissions: {} },
    { "max-ai-credits": 100 }, { workflow: "other" }, { deploy: true }, { enabled: "true" },
    { mode: "debug" }, { "max-mode": "debug" }, { "max-repositories": 1001 },
    { "rollout-percent": 0 }, { targets: { "outside/target": { mode: "review" } } },
    { targets: { "acme/three": { mode: "live" } } },
    { targets: { "acme/one": { mode: "debug" } } },
    { targets: { "acme/one": { mode: "review" }, "ACME/ONE": { mode: "live" } } },
  ]) assert.throws(() => resolve(document(workflow)), undefined, JSON.stringify(workflow));
});

test("standalone JSON Schema declares only rollout and enablement properties", () => {
  const schema = JSON.parse(readFileSync(new URL("../../.github/workflows/shared/cao.schema.json", import.meta.url)));
  assert.equal(schema.$defs.controlPlane.properties.workflows.$ref, "#/$defs/controlWorkflows");
  assert.equal(schema.$defs.controlWorkflows.additionalProperties.$ref, "#/$defs/workflowPolicy");
  assert.equal(schema.$defs.workflowPolicy.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.$defs.workflowPolicy.properties).sort(), [
    "enabled", "max-mode", "max-repositories", "mode", "monthly-ai-credit-budget", "rollout-percent", "targets",
  ]);
});
