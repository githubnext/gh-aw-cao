import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { archiveHostContract, localCheckerDependencies } from "../../scripts/author-host-assertion-functions.mjs";
import { hostGateObservation, reviewedHostSourceProfile, verifiedHostStep } from "../../scripts/collect-host-assertion-evidence.mjs";
import { hostAssertionModule, scoreHostAssertions } from "../../scripts/native-host-assertion-value.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "../../scripts/operational-value-census-io.mjs";

test("native assertion scoring retains demonstrated partial proofs without completing unknown coverage", () => {
  const evidence = { valid: true, assessments: [{ id: "native-1", passed: true }, { id: "native-2", passed: null }] };
  assert.equal(scoreHostAssertions("observed-proofs", evidence), 1);
  assert.equal(scoreHostAssertions("complete-proofs", evidence), null);
  assert.equal(scoreHostAssertions("complete-proofs", { valid: true, assessments: [{ id: "native-1", passed: true }] }), 1);
  for (const assessments of [[], [{ id: "unobserved", passed: null }], [{ id: "failed", passed: false }],
    [{ id: "duplicate", passed: true }, { id: "duplicate", passed: true }]]) {
    assert.equal(scoreHostAssertions("observed-proofs", { valid: true, assessments }), null);
  }
});

test("only a unique exact host assertion completed successfully before cutoff establishes native proof", () => {
  const until = "2026-10-18T15:00:12Z";
  const step = { name: "Verify", number: 1, status: "completed", conclusion: "success",
    started_at: "2026-10-18T14:00:00Z", completed_at: "2026-10-18T14:01:00Z" };
  const contract = { until, jobs: { verifier: { name: "verifier" } } }, gate = { job: "verifier", name: "Verify" };
  const response = { total_count: 1, jobs: [{ id: 1, name: "verifier", steps: [step] }] };
  assert.equal(hostGateObservation(contract, gate, response).passed, true);
  assert.equal(verifiedHostStep({ ...step, conclusion: "failure" }, until), false);
  assert.equal(verifiedHostStep({ ...step, completed_at: until }, until), false);
  assert.equal(verifiedHostStep({ ...step, started_at: "invalid" }, until), false);
  assert.equal(hostGateObservation(contract, gate, { ...response, jobs: [{ name: "agent", steps: [step] }] }).passed, null);
  assert.equal(hostGateObservation(contract, gate, { ...response, jobs: [{ name: "verifier", steps: [step, step] }] }).passed, null);
  assert.throws(() => hostGateObservation(contract, gate, { ...response, total_count: 2 }), /Incomplete/);
});

test("checker dependency parsing ignores strings/comments/directives and rejects unresolved executable imports", () => {
  assert.deepEqual(localCheckerDependencies('/* require("./fake") */\nconst x = require("./real.cjs");'), ["./real.cjs"]);
  assert.deepEqual(localCheckerDependencies('import x from "./module.js"; export {x}; await import("node:fs");', "module"),
    ["./module.js", "node:fs"]);
  assert.throws(() => localCheckerDependencies('require(variable)'), /dynamic/);
  assert.throws(() => localCheckerDependencies('/* eslint-disable checker/dependencies */ require(variable)'), /dynamic/);
  assert.throws(() => localCheckerDependencies("const = invalid"), /syntax/);
});

test("historical checker profiles cannot mix jobs, dependencies or runtime trees across versions", () => {
  const old = { jobs: { agent: { sha256: "old-job" } },
    dependencies: [{ path: "checker.cjs", gitBlob: "checker" }],
    runtimeTrees: [{ path: "actions", gitTree: "old-runtime" }] };
  const current = { ...old, jobs: { agent: { sha256: "current-job" } },
    runtimeTrees: [{ path: "actions", gitTree: "current-runtime" }], historicalSourceProfiles: [old] };
  assert.equal(reviewedHostSourceProfile(current, old), old);
  assert.equal(reviewedHostSourceProfile(current, current), current);
  assert.equal(reviewedHostSourceProfile(current, { ...old, jobs: current.jobs }), null);
  assert.equal(reviewedHostSourceProfile(current, { ...old, runtimeTrees: current.runtimeTrees }), null);
  assert.equal(reviewedHostSourceProfile(current, { ...old, dependencies: [] }), null);
});

test("explicit host contract supersession retains the exact prior function, sources and native facts", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "cao-host-contract-"));
  try {
    const contract = { workflowId: "sample", jobs: { agent: { sha256: "frozen" } } };
    const rows = [{ id: "retained", passed: true, observedAt: "2026-01-01T00:00:00Z" }];
    const part = { file: "sample-observations-001.json.gz", count: 1, sha256: censusDigest(rows) };
    const index = { complete: true, contractSha256: censusDigest(contract), partitions: [part] };
    const module = `${directory}/function.mjs`;
    writeFileSync(module, "export const preserved = true;\n");
    writeCensusJson(`${directory}/sample-sources.json.gz`, { protected: "source" });
    writeCensusJson(`${directory}/sample-index.json`, index);
    writeCensusJson(`${directory}/${part.file}`, rows);
    const archive = archiveHostContract(directory, contract, module);
    assert.deepEqual(readCensusJson(`${archive}/contract.json`), contract);
    assert.deepEqual(readCensusJson(`${archive}/index.json`), index);
    assert.deepEqual(readCensusJson(`${archive}/${part.file}`), rows);
    assert.equal(readFileSync(`${archive}/function.txt`, "utf8"), readFileSync(module, "utf8"));
    assert.equal(existsSync(`${directory}/sample-index.json`), false);
    writeCensusJson(`${directory}/sample-index.json`, index);
    writeCensusJson(`${directory}/${part.file}`, [{ id: "changed" }]);
    assert.throws(() => archiveHostContract(directory, contract, module), /evidence changed/);
    assert.equal(existsSync(`${directory}/sample-index.json`), true);
    assert.deepEqual(readCensusJson(`${archive}/${part.file}`), rows);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

{
  for (const contract of readCensusJson("docs/operational-value/proof/host-assertions/contracts.json")) {
    test(`${contract.workflowId} retains coherent native receipts and independently reproducible evaluated periods`, () => {
      const directory = "docs/operational-value/proof/host-assertions";
      const index = readCensusJson(`${directory}/${contract.workflowId}-index.json`);
      assert.equal(index.complete, true);
      assert.equal(index.contractSha256, censusDigest(contract));
      const rows = index.partitions.flatMap(part => {
        const rows = readCensusJson(`${directory}/${part.file}`);
        assert.equal(rows.length, part.count);
        assert.equal(censusDigest(rows), part.sha256);
        return rows;
      });
      assert.equal(rows.length, index.observations);
      assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
      assert.equal(new Set(rows.map(row => row.runId)).size, index.inventoryRuns);
      const proven = rows.filter(row => row.passed === true);
      assert.equal(proven.length, index.proven);
      if (contract.workflowId === "smoke-copilot-sub-agents") {
        assert.equal(index.inventoryRuns, 82);
        assert.equal(proven.length, 0);
        const controls = rows.filter(row => row.receipt?.experiment?.status === "available");
        assert.equal(controls.length, 1);
        const control = controls[0], experiment = control.receipt.experiment;
        assert.equal(control.runId, 38658519209);
        assert.equal(experiment.variant, "single_agent_control");
        assert.equal(experiment.logLayout, "protected-job-step-interval");
        assert.equal(control.passed, null);
        assert.match(control.missingReason, /Synthetic control/);
        const jobs = { total_count: 2, jobs: [{ id: control.receipt.jobId, name: "agent",
          steps: [{ ...control.receipt, name: contract.gates[0].name }] },
        { id: experiment.jobId, name: experiment.jobName, steps: [experiment.selectorReceipt] }] };
        assert.equal(hostGateObservation(contract, contract.gates[0], jobs, experiment).passed, null);
      } else assert.ok(proven.length > 0);
      if (contract.workflowId === "daily-max-ai-credits-test") {
        assert.equal(rows.length, 144);
        assert.equal(proven.length, 2);
      }
      if (contract.workflowId === "smoke-goose") {
        assert.equal(index.inventoryRuns, 532);
        assert.equal(proven.length, 1);
        assert.equal(proven[0].sourceValidation.reviewedSourceRevision, "e6b87a4f169c7d194aa5f862f9b6e983ad11d3ae");
        const previous = `${directory}/versions/smoke-goose/c2d412d7f7ab0a3c8d52413e21d94123a93ef56c07c9addfce0dacb43fe74367`;
        assert.equal(readCensusJson(`${previous}/index.json`).proven, 0);
        assert.match(readCensusJson(`${previous}/contract.json`).acceptance, /Goose 1\.54\.0/);
        assert.match(contract.limitations.join(" "), /does not certify the current Goose version/);
      }
      const sources = readCensusJson(`${directory}/${contract.workflowId}-sources.json.gz`);
      for (const row of rows.filter(row => row.sourceValidation && verifiedHostStep(row.receipt, contract.until))) {
        assert.equal(row.attempt, 1);
        assert.equal(row.sourceGap, null);
        assert.equal(verifiedHostStep(row.receipt, contract.until), true);
        const profile = reviewedHostSourceProfile(contract, row.sourceValidation);
        assert.ok(profile);
        if (row.sourceValidation.reviewedSourceRevision) {
          assert.equal(profile.sourceRevision, row.sourceValidation.reviewedSourceRevision);
        }
        const source = profile === contract ? sources.sources.find(row => row.path.endsWith(".lock.yml"))
          : sources.historicalSources.find(row => row.revision === profile.sourceRevision && row.path.endsWith(".lock.yml"));
        const workflow = parse(source.text);
        for (const [id, job] of Object.entries(profile.jobs)) assert.equal(censusDigest(workflow.jobs[id]), job.sha256);
      }
      const module = hostAssertionModule(contract);
      const timeline = JSON.parse(readFileSync(
        `docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`, "utf8"));
      if (contract.historicalSourceProfiles) assert.equal(timeline.valueFunction.definition.evidence.sourceProfilesSha256,
        censusDigest([contract.jobs, contract.dependencies, contract.runtimeTrees, contract.historicalSourceProfiles]));
      if (contract.conditionOracleSha256) assert.equal(timeline.valueFunction.definition.evidence.conditionPolicySha256,
        censusDigest([contract.gates, contract.conditionOracleSha256,
          ...(contract.conditionJobOracleSha256 ? [contract.conditionJobOracleSha256] : [])]));
      const replay = module.collectBatch(timeline.snapshots.map(snapshot => ({
        repository: contract.repository, windowStart: snapshot.window.startAt,
        windowEnd: snapshot.window.endAt, observedAt: snapshot.observedAt,
      })));
      for (const [position, snapshot] of timeline.snapshots.entries()) {
        const period = rows.filter(row => row.at >= snapshot.window.startAt && row.at < snapshot.window.endAt);
        const count = period.filter(row => row.passed === true).length;
        assert.equal(snapshot.metrics["observed-proofs"], count || null);
        assert.equal(snapshot.metrics["complete-proofs"], count && period.every(row => row.passed === true) ? count : null);
        assert.deepEqual(snapshot.evidence, replay[position].evidence);
        assert.ok(snapshot.provenance.some(row => row.kind === "native-host-assertion-index" && row.ref === censusDigest(index)));
      }
    });
  }
}
