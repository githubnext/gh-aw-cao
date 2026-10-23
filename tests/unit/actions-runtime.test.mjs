import assert from "node:assert/strict";
import test from "node:test";
import { condition, evaluate, interpolate } from "../helpers/actions-runtime/expressions.mjs";
import { sampleWorkflow } from "../helpers/actions-runtime/workflow.mjs";

const context = {
  status: "success", github: { event: {} }, env: {}, inputs: {},
  steps: { admission: { outputs: { authorized: "true" } } },
  vars: {}, secrets: {}, needs: {},
};

test("sample runner expressions preserve values, short circuit and missing properties", () => {
  assert.equal(evaluate("steps.admission.outputs.authorized == 'true'", context), true);
  assert.equal(evaluate("github.event.issue.number || 'fallback'", context), "fallback");
  assert.equal(evaluate("false && fromJSON('invalid')", context), false);
  assert.equal(evaluate("true || fromJSON('invalid')", context), true);
  assert.equal(evaluate("fromJSON('{}').missing || ''", context), "");
  assert.equal(evaluate("secrets[fromJSON('{}')[inputs.target_repo || 'repo']] || 'token'", context), "token");
  assert.equal(evaluate("'A' == 'a'", context), true);
  assert.equal(evaluate("'don''t'", context), "don't");
  assert.equal(interpolate("${{ true }}", context), true);
  assert.equal(interpolate("report-${{ steps.admission.outputs.authorized }}", context), "report-true");
  assert.equal(interpolate("${{ true }}/${{ false }}", context), "true/false");
});

test("sample runner honors implicit success and explicit failure/always conditions", () => {
  assert.equal(condition(undefined, context), true);
  assert.equal(condition("true", { ...context, status: "failure" }), false);
  assert.equal(condition("${{ always() }}", { ...context, status: "failure" }), true);
  assert.equal(condition("success() || failure()", { ...context, status: "failure" }), true);
  assert.equal(condition(false, context), false);
});

test("sample runner rejects expression features outside its explicit subset", () => {
  for (const source of ["process.env.TOKEN", "hashFiles('**')", "github.*.name", "github.constructor", "true; false"]) {
    assert.throws(() => evaluate(source, context));
  }
});

test("sample runner requires staged output handlers even for dry-run and opted-in CAO locks", () => {
  const fixture = ({ dryRun = true, staged = "true", samples = "true", replay = true, detection = "disabled" } = {}) =>
    `# gh-aw-metadata: ${JSON.stringify({ dry_run: dryRun })}
# gh-aw-manifest: ${JSON.stringify({ threat_detection: { mode: detection } })}
${JSON.stringify({ jobs: {
  agent: { steps: [{ id: "agentic_execution", env: { GH_AW_SAMPLES: samples },
    run: replay ? 'node "$RUNNER_TEMP/gh-aw/actions/apply_samples.cjs"' : "copilot" }] },
  safe_outputs: { steps: [{ id: "process_safe_outputs", env: { GH_AW_SAFE_OUTPUTS_STAGED: staged } }] },
} })}`;
  assert.ok(sampleWorkflow(fixture()));
  assert.throws(() => sampleWorkflow(fixture({ dryRun: false })), /Only dry-run locks/);
  assert.ok(sampleWorkflow(fixture({ dryRun: false }), { allowStaged: true }));
  for (const dryRun of [true, false]) {
    for (const staged of ["false", "${{ inputs.staged }}", undefined]) {
      assert.throws(() => sampleWorkflow(fixture({ dryRun, staged: staged ?? null }), { allowStaged: true }), /unconditionally staged/);
    }
    assert.throws(() => sampleWorkflow(fixture({ dryRun, samples: "" }), { allowStaged: true }), /sample replay/);
    assert.throws(() => sampleWorkflow(fixture({ dryRun, replay: false }), { allowStaged: true }), /sample replay/);
    assert.throws(() => sampleWorkflow(fixture({ dryRun, detection: "enabled" }), { allowStaged: true }), /detection disabled/);
  }
});
