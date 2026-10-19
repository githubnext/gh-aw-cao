import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import { ghAwVersion, workflow } from "./workflow-contract.helpers.mjs";

const controller = "operational-value-coverage";
const workers = [
  "value-coverage-measure-1",
  "value-coverage-measure-2",
  "value-coverage-measure-3",
  "value-coverage-measure-4",
  "value-coverage-integrate",
  "value-coverage-skill",
];
const featureSha = "7ef2cbc5311c3acdc2e1f8f6b1532cf14b922e36";

// Dispatch contracts read from the full implementation at featureSha.
const controllerInputs = {
  target_repo: { type: "string" },
  safe_output_repo: { type: "string" },
  max_repos: { default: 1, type: "number" },
  rollout_percent: { default: 100, type: "number" },
  safe_output_mode: { default: "review", type: "choice", options: ["review"] },
};
const workerInputs = {
  target_repo: { required: true, type: "string" },
  safe_output_repo: { required: true, type: "string" },
  safe_output_mode: { required: true, type: "string" },
  correlation_id: { type: "string" },
  central_repo: { type: "string" },
  control_plane_run_url: { type: "string" },
  batch_label: { type: "string" },
};

for (const id of [controller, ...workers]) {
  test(`${id} registers only the feature-compatible manual envelope`, () => {
    const source = workflow(`${id}.md`);
    const config = parse(/^---\n([\s\S]*?)\n---/.exec(source)[1]);
    const compiled = workflow(`${id}.lock.yml`);
    const lock = parse(compiled);
    const metadata = JSON.parse(compiled.split("\n")[0].slice("# gh-aw-metadata: ".length));
    const manifest = JSON.parse(compiled.split("\n")[1].slice("# gh-aw-manifest: ".length));
    const expectedInputs = id === controller ? controllerInputs : workerInputs;

    assert.deepEqual(config.on, { workflow_dispatch: { inputs: expectedInputs } });
    assert.deepEqual(lock.on, {
      workflow_dispatch: {
        inputs: {
          ...expectedInputs,
          aw_context: {
            default: "",
            description: "Agent caller context (Reserved for Agentic Workflows).",
            required: false,
            type: "string",
          },
        },
      },
    });
    assert.equal(metadata.compiler_version, ghAwVersion);
    assert.equal(metadata.strict, true);
    assert.ok(source.includes(featureSha));
    assert.match(source, /Registration only/);
    assert.deepEqual(Object.keys(config).sort(), [
      "checkout", "concurrency", "description", "if", "intent",
      "max-daily-ai-credits", "name", "network", "on", "permissions",
      "safe-outputs", "tools",
    ].sort());
    assert.equal(config.if, "false");
    assert.equal(config.checkout, false);
    assert.deepEqual(config.network, { allowed: [] });
    assert.deepEqual(config.permissions, { contents: "read" });
    assert.deepEqual(config.tools, {
      "cli-proxy": false, github: false, bash: false, edit: false,
    });
    assert.deepEqual(config["safe-outputs"], {
      "create-issue": false,
      noop: null,
      "missing-tool": false,
      "missing-data": false,
      "report-incomplete": false,
      "report-failure-as-issue": false,
      "report-failed-jobs": false,
    });
    assert.deepEqual(manifest.mcp_servers, [{ name: "safeoutputs", tools: ["noop"] }]);
  });

  test(`${id} cannot execute an agent, detector, conclusion or safe-output job`, () => {
    const lock = parse(workflow(`${id}.lock.yml`));
    assert.deepEqual(lock.permissions, {});
    assert.deepEqual(Object.keys(lock.jobs).sort(), [
      "activation", "agent", "conclusion", "detection",
    ]);
    const { activation, agent, detection, conclusion } = lock.jobs;
    assert.equal(activation.if, false);
    assert.equal(activation.needs, undefined);
    assert.equal(agent.needs, "activation");
    assert.equal(agent.if, undefined);
    assert.deepEqual(agent.permissions, { contents: "read" });

    // A skipped activation skips the success-dependent agent. The status-aware
    // jobs must also exclude that skipped result and absent activation outputs.
    assert.deepEqual(detection.needs, ["activation", "agent"]);
    assert.equal(detection.if, "always() && needs.agent.result != 'skipped'");
    assert.deepEqual(conclusion.needs, ["activation", "agent", "detection"]);
    assert.equal(conclusion.if.trim(),
      "always() && (needs.agent.result != 'skipped'"
      + " || needs.activation.outputs.lockdown_check_failed == 'true'"
      + " || needs.activation.outputs.oauth_token_check_failed == 'true'"
      + " || needs.activation.outputs.stale_lock_file_failed == 'true'"
      + " || needs.activation.outputs.secret_verification_result == 'failed')");
    assert.equal(lock.jobs.safe_outputs, undefined);
  });
}
