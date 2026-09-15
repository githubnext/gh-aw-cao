import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { root } from "./workflow-contract.helpers.mjs";

const graderName = "optimization-token-optimizer-operational-value.sh";
const grader = join(root, "optimization", ".github", "graders", graderName);

function evaluate(input) {
  return JSON.parse(execFileSync(grader, ["--metric"], {
    encoding: "utf8",
    input: JSON.stringify(input),
  }));
}

test("token optimizer exposes a replayable correctness-first contract", () => {
  const definition = JSON.parse(execFileSync(grader, ["--definition"], { encoding: "utf8" }));

  assert.equal(definition.schemaVersion, 4);
  assert.equal(definition.grader, "operational-value");
  assert.equal(definition.sourcePath, ".github/workflows/optimization-token-optimizer.md");
  assert.equal(definition.baseline.mode, "attainment-only");
  assert.match(definition.evidence.assignment, /targetRepo/);
  assert.match(definition.evidence.assignment, /workflowPath/);
  assert.match(definition.evidence.assignment, /evidenceWindowStart/);
  assert.match(definition.evidence.assignment, /evidenceWindowEnd/);
  assert.match(definition.evidence.assignment, /assignmentRunId/);
  assert.match(definition.evidence.assignment, /experimentId/);
  assert.match(definition.evidence.collection, /assigned target repository/);
  assert.match(definition.evidence.collection, /input, output, cache-read, cache-write, and reasoning tokens/);
  assert.match(definition.evidence.collection, /never combine/);
  assert.match(definition.evidence.zeroRule, /scores 0/);
  assert.match(definition.evidence.missingRule, /scores null/);
});

test("token optimizer metric measures only verified comparable savings", () => {
  const definition = JSON.parse(execFileSync(grader, ["--definition"], { encoding: "utf8" }));
  const examples = definition.validationExamples;

  assert.equal(evaluate(examples.targetAttained), 0.3);
  assert.equal(evaluate(examples.targetMissed), 0);
  assert.equal(evaluate(examples.missing), null);
  assert.equal(evaluate(examples.malformed), null);
  assert.equal(evaluate({
    ...examples.targetAttained,
    reliabilityPreserved: false,
  }), 0);
  assert.equal(evaluate({
    ...examples.targetAttained,
    outcomeQualityPreserved: false,
  }), 0);
  assert.equal(evaluate({
    ...examples.targetAttained,
    baselineAicPerAcceptedOutcome: 0,
  }), null);
  assert.equal(evaluate({
    ...examples.targetAttained,
    optimizedAicPerAcceptedOutcome: 0,
  }), 1);
});

test("optimization package installs the token optimizer contract", () => {
  const manifest = readFileSync(join(root, "optimization", "aw.yml"), "utf8");

  assert.match(
    manifest,
    new RegExp(`source: \\.github/graders/${graderName.replaceAll(".", "\\.")}`),
  );
  assert.match(
    manifest,
    new RegExp(`destination: \\.github/aw/optimization/graders/${graderName.replaceAll(".", "\\.")}`),
  );
});
