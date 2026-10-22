import assert from "node:assert/strict";
import test from "node:test";
import { condition, evaluate, interpolate } from "../helpers/actions-runtime/expressions.mjs";

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
