import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { parseAllDocuments } from "yaml";
import { root, workflow } from "./workflow-contract.helpers.mjs";

const require = createRequire(import.meta.url);

function fixture(name) {
  return JSON.parse(readFileSync(
    join(root, "tests", "fixtures", "cao-evolution-failure-evidence", name),
    "utf8",
  ));
}

function prefetchHelpers() {
  const source = parseAllDocuments(workflow("cao-evolution-failures-investigator.md"))[0].toJSON();
  const script = source.steps.find(
    (step) => step.name === "Deterministic pre-fetch of agentic workflow failures",
  ).with.script;
  const cutoff = script.indexOf("const windowStart =");
  assert.notEqual(cutoff, -1, "prefetch script helper boundary");

  const context = {
    core: { warning() {} },
    module: { exports: {} },
    process: { env: { TARGET_REPOSITORY: "acme/widgets", SAFE_OUTPUT_REPO: "acme/control" } },
    require(specifier) {
      if (specifier === "fs") {
        return { existsSync: () => false };
      }
      return require(specifier);
    },
  };
  vm.runInNewContext(
    `${script.slice(0, cutoff)}
module.exports = { laterRunsFor, summarizeFailureEvidence };`,
    context,
  );
  return context.module.exports;
}

test("zero-job failures without retrievable logs are incomplete evidence", () => {
  const { summarizeFailureEvidence } = prefetchHelpers();
  const evidence = summarizeFailureEvidence(fixture("zero-jobs-no-logs.json"));

  assert.equal(evidence.diagnostic_evidence, "incomplete");
  assert.equal(evidence.incomplete_reason, "zero-jobs-and-no-retrievable-logs");
  assert.equal(evidence.classification_constraints.may_infer_root_cause, false);
  assert.equal(evidence.classification_constraints.may_classify_p0_or_p1, false);
  assert.equal(evidence.classification_constraints.may_create_focused_fix_issue, false);
});

test("a later success makes an evidence-free failure non-current high priority", () => {
  const { laterRunsFor, summarizeFailureEvidence } = prefetchHelpers();
  const input = fixture("later-success.json");
  const laterRuns = laterRunsFor(input.failedRun, input.completedRuns);
  const evidence = summarizeFailureEvidence({ ...input, laterRuns });

  assert.equal(laterRuns.map(({ run_id }) => run_id).join(","), "411");
  assert.equal(evidence.later_success_after_failure, true);
  assert.equal(evidence.classification_constraints.may_classify_p0_or_p1, false);
  assert.equal(evidence.classification_constraints.later_success_negates_current_high_priority, true);
  assert.equal(evidence.classification_constraints.may_create_focused_fix_issue, false);
});
