import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { base, cutoff, readCustody, readJson, sha256, verifyLock } from "../docs/operational-value/proof/native-go-quality/custody.mjs";
import { evaluateNative } from "../docs/operational-value/proof/native-go-quality/model.mjs";

export function verifyClosure() {
  return verifyLock();
}

export async function replay() {
  const lock = verifyClosure();
  const custody = readCustody();
  const index = readJson(new URL("history/history.json.gz", base));
  assert.equal(index.complete, true);
  assert.equal(index.repositoryId, 1036865607);
  assert.equal(index.sourceRevision, custody.data.revision);
  assert.equal(index.until, cutoff);
  assert.equal(index.partitions.length, 346);
  let count = 0;
  const identities = new Set();
  for (const part of index.partitions) {
    assert.match(part.file, /^entities-\d{5}\.json\.gz$/);
    const file = new URL(`history/${part.file}`, base);
    const entities = readJson(file);
    assert.equal(sha256(JSON.stringify(entities)), part.sha256);
    assert.equal(entities.length, part.count);
    for (const row of entities) {
      assert.ok(!identities.has(row.id));
      identities.add(row.id);
    }
    count += entities.length;
  }
  assert.equal(count, 58048);
  const adoptions = custody.data.workflows.map(workflow => {
    const { commit, parent, adoptedAt } = workflow.adoption, info = custody.commit(commit);
    assert.equal(info.parents[0], parent);
    assert.equal(info.at, adoptedAt);
    for (const suffix of ["md", "lock.yml"]) {
      const file = `.github/workflows/${workflow.slug}.${suffix}`;
      assert.equal(custody.resolve(parent, file), null);
      assert.match(custody.resolve(commit, file), /^[a-f0-9]{40}$/);
      assert.ok(custody.source(commit, file));
    }
    return { slug: workflow.slug, ...workflow.adoption, sourceRevisionsRetained: workflow.history.length,
      executor: workflow.slug === "daily-testify-uber-super-expert" ? "Copilot agent, issue output; later SDK era retained"
        : workflow.slug === "go-logger" ? "Claude agent, bounded logging PR; later deterministic preflight retained"
          : "Claude agent, ast-grep finding issue; later deterministic ast-grep gate retained",
      historicalExecutorContinuity: null };
  });
  const result = evaluateNative();
  const quantities = {};
  for (const slug of ["go-logger", "go-pattern-detector", "daily-testify-uber-super-expert"]) {
    const module = await import(`../docs/operational-value/proof/functions/${slug}.mjs`);
    const rows = result.rows.filter(row => row.slug === slug);
    const known = rows.filter(row => row.value !== null);
    const positive = known.filter(row => row.value > 0);
    const start = module.definition.adoption.adoptedAt;
    const request = { windowStart: start, windowEnd: cutoff, observedAt: cutoff };
    const first = await module.collectBatch([request]), second = await module.collectBatch([request]);
    assert.deepEqual(second, first);
    const value = module.scoreMetric("native-partial", first[0].evidence);
    assert.equal(value, known.length ? known.reduce((sum, row) => sum + row.value, 0) : null);
    quantities[slug] = { selectedImplementations: rows.length, evaluatedNativeCases: known.length,
      independentlyVerifiedUsefulOutcomeObservations: positive.length, nativeQuantity: positive.length ? value : null,
      checkedSelectedFacetQuantity: value,
      measurementStatus: positive.length ? "finite-useful-partial-observation" : "no-useful-outcome-established-not-completed-measurement",
      fullGoalAcceptance: null, safeguards: null, receiptBackedAttribution: null, actualCosts: null,
      period: { startInclusive: start, endExclusive: cutoff, cadenceDays: 7, noCasePeriods: "null" },
      positiveCases: positive };
  }
  return { schemaVersion: 1, repository: custody.data.repository, revision: custody.data.revision, cutoff,
    contract: "Outcome-informed retrospective v2; original stricter v1 preserved",
    instrument: sha256(readFileSync(new URL("instrument-lock.json", base))),
    retainedFiles: lock.files.length, discovery: { partitions: 346, entities: count, currentMarkersAreNotReceipts: true },
    adoptions, parsedNativeFiles: result.parsedFiles, invalidNativeFiles: result.invalidFiles,
    dependencySemanticsIndependentlyVerified: result.standardProof, patternGap: result.patternGap,
    independentLocalGoWitness: result.witness,
    nativeClaimQualification: "Two source-proven sites conditionally prevent nil flag-field dereference after a failed prerequisite. This is not evidence of two observed historical panics, improved full-suite behavior, or target test execution.",
    quantities, finiteUsefulMeasuredWorkflowCount: Object.values(quantities).filter(row => row.independentlyVerifiedUsefulOutcomeObservations > 0).length,
    notThreeCompletedNativeMeasurements: true, keepDecision: "not rated",
    limits: "Selected cases, not whole-history totals. No historical target tests/code/workflows executed. Issue/PR bodies are observed current content, not creation receipts. No monetary values or sole causation." };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const result = await replay();
  if (process.argv.includes("--write")) writeFileSync(new URL("assessment.json", base), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}
