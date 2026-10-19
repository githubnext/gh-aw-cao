import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readFormalSearchArchive } from "../../scripts/collect-formal-search-evidence.mjs";
import { FormalSearchEvidenceGap, formalSearchFrontier, normalizeFormalSearch,
  parseFormalSearchCounters, scoreFormalSearch } from "../../scripts/native-formal-search-value.mjs";
import { censusDigest, readCensusJson } from "../../scripts/operational-value-census-io.mjs";

const progress = "Progress(12) at 2026-10-18 01:00:00: 1,000 states generated (10 s/min), 800 distinct states found (8 ds/min), 200 states left on queue.";
const model = { id: "QueueOrdering", module: "WorkQueue",
  sourceSha256: { "WorkQueue.tla": "model-sha", "QueueOrdering.cfg": "config-sha" } };
const contract = { repository: "github/gh-aw", until: "2026-10-18T15:00:12Z", tlcSha256: "a".repeat(64) };
const run = { id: 1, head_sha: "b".repeat(40) };
const job = { started_at: "2026-10-18T00:00:00Z", completed_at: "2026-10-18T04:40:01Z" };
const result = () => ({ schema_version: 1, repository: contract.repository, sha: run.head_sha,
  run_id: "1", run_attempt: "1", config: model.id, module: model.module,
  tlc_sha256: contract.tlcSha256, tlc_actual_sha256: contract.tlcSha256, source_sha256: model.sourceSha256,
  started_at: job.started_at, finished_at: "2026-10-18T04:40:00Z", timeout_seconds: 16800,
  command: ["java", "-XX:+UseParallelGC", "-Xmx1g", "-cp", "/tmp/tla2tools.jar", "tlc2.TLC",
    "-workers", "2", "-seed", "1", "-fp", "0", "-checkpoint", "5", "-config", "/tmp/QueueOrdering.cfg",
    "-metadir", "/tmp/state", "/tmp/WorkQueue.tla"],
  status: "timed_out", exhausted: false, exit_code: 1, signal: "SIGINT", final_counts: null,
  latest_progress: { depth: "12", states_generated: "1000", distinct_states: "800", states_remaining: "200" } });

test("native TLC counters preserve partial searches without manufacturing finite-state proofs", () => {
  const parsed = parseFormalSearchCounters(`unretained tool text\n${progress}`);
  assert.equal(parsed.counters.distinct, 800);
  assert.equal(parsed.counters.depth, 12);
  assert.equal(parsed.noErrors, false);
  assert.equal(parsed.safeLog, progress);
  const normalized = normalizeFormalSearch(result(), progress, contract, model, run, job);
  assert.equal(normalized.exhausted, false);
  assert.deepEqual(normalizeFormalSearch(normalized.result, normalized.safeLog, contract, model, run, job), normalized);
  const finalLog = `${progress}\nModel checking completed. No error has been found.\n1000 states generated, 800 distinct states found, 0 states left on queue.`;
  const completed = { ...result(), status: "passed", exhausted: true, signal: null, exit_code: 0,
    final_counts: { states_generated: "1000", distinct_states: "800", states_remaining: "0" } };
  assert.equal(normalizeFormalSearch(completed, finalLog, contract, model, run, job).exhausted, true);
  for (const changed of [{ ...completed, signal: "SIGTERM" }, { ...completed, exit_code: 1 },
    { ...result(), status: "passed", exhausted: true }]) {
    assert.throws(() => normalizeFormalSearch(changed, finalLog, contract, model, run, job), FormalSearchEvidenceGap);
  }
  for (const log of ["", progress.replace("1,000", "1,,000"), progress.replace("800", "1800"),
    progress.replace("200 states left", "900 states left"), progress.replace("1,000", "9007199254740992")]) {
    assert.throws(() => parseFormalSearchCounters(log), FormalSearchEvidenceGap);
  }
});

test("formal evidence requires exact model, tool, run, initial attempt, command and protected time scope", () => {
  for (const changed of [{ ...result(), sha: "c".repeat(40) }, { ...result(), run_attempt: "2" },
    { ...result(), tlc_actual_sha256: "different" }, { ...result(), source_sha256: {} },
    { ...result(), finished_at: contract.until }, { ...result(), started_at: "2026-10-17T23:59:59Z" },
    { ...result(), command: result().command.map(token => token === "2" ? "4" : token) },
    { ...result(), latest_progress: { ...result().latest_progress, distinct_states: "801" } }]) {
    assert.throws(() => normalizeFormalSearch(changed, progress, contract, model, run, job), FormalSearchEvidenceGap);
  }
  assert.throws(() => normalizeFormalSearch(result(), progress, contract, model, run,
    { ...job, completed_at: "invalid" }), FormalSearchEvidenceGap);
});

test("the fixed configuration frontier never sums repeated searches or silently shrinks missing cohorts", () => {
  const models = [{ id: "a" }, { id: "b" }];
  const fact = (model, distinct, at = "2026-10-18T01:00:00Z") =>
    ({ model, counters: { distinct }, at, status: "available", exhausted: false });
  const rows = [fact("a", 100), fact("a", 90), fact("a", 100), fact("b", 80), fact("b", 900, "2026-10-18T16:00:00Z")];
  assert.equal(scoreFormalSearch("explored-states", formalSearchFrontier(rows, models, contract.until)), 180);
  assert.equal(scoreFormalSearch("exhausted-configurations", formalSearchFrontier(rows, models, contract.until)), 0);
  assert.equal(scoreFormalSearch("explored-states", formalSearchFrontier(rows.slice(0, 3), models, contract.until)), null);
  assert.equal(scoreFormalSearch("invented", formalSearchFrontier(rows, models, contract.until)), null);
});

test("native artifact decoding checks exact root entries and immutable model bytes without extracting arbitrary files", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "cao-formal-archive-test-"));
  try {
    const files = { "WorkQueue.tla": "model", "QueueOrdering.cfg": "config", "result.json": JSON.stringify(result()), "tlc.log": progress };
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(directory, name), text);
    const hashes = Object.fromEntries(["WorkQueue.tla", "QueueOrdering.cfg"].map(name =>
      [name, createHash("sha256").update(files[name]).digest("hex")]));
    execFileSync("zip", ["-q", "artifact.zip", ...Object.keys(files)], { cwd: directory });
    const archive = readFileSync(path.join(directory, "artifact.zip"));
    assert.equal(readFormalSearchArchive(archive, { ...model, sourceSha256: hashes }).log, progress);
    assert.throws(() => readFormalSearchArchive(archive, model), FormalSearchEvidenceGap);
    execFileSync("zip", ["-q", "missing.zip", "result.json", "tlc.log"], { cwd: directory });
    assert.throws(() => readFormalSearchArchive(readFileSync(path.join(directory, "missing.zip")), model), FormalSearchEvidenceGap);
    assert.throws(() => readFormalSearchArchive(Buffer.from("not zip"), model), FormalSearchEvidenceGap);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("retained native formal-search facts replay independently against their frozen source cohort", {
  skip: !existsSync("docs/operational-value/proof/formal-search/index.json"),
}, () => {
  const directory = "docs/operational-value/proof/formal-search";
  const [contract] = readCensusJson(`${directory}/contracts.json`), index = readCensusJson(`${directory}/index.json`);
  const facts = readCensusJson(`${directory}/facts.json.gz`), sources = readCensusJson(`${directory}/sources.json.gz`);
  assert.equal(censusDigest(contract), index.contractSha256);
  assert.equal(censusDigest(facts), index.factsSha256);
  assert.equal(censusDigest(sources), index.sourcesSha256);
  for (const source of sources) {
    assert.equal(createHash("sha1").update(`blob ${Buffer.byteLength(source.text)}\0`).update(source.text).digest("hex"), source.gitBlob);
  }
  const available = facts.filter(row => row.status === "available");
  assert.equal(available.length, index.available);
  assert.equal(available.length, 4);
  assert.equal(index.inventoryRuns, 10);
  assert.equal(index.knownModels, 2);
  for (const fact of available) {
    const model = contract.models.find(model => model.id === fact.model);
    const replay = normalizeFormalSearch(fact.result, fact.safeLog, contract, model,
      { id: fact.runId, head_sha: fact.headSha }, fact.job);
    assert.deepEqual(replay.counters, fact.counters);
    assert.equal(replay.exhausted, fact.exhausted);
    assert.equal(replay.verdict, fact.verdict);
  }
  const frontier = formalSearchFrontier(facts, contract.models, contract.until);
  assert.equal(scoreFormalSearch("explored-states", frontier), 196955486);
  assert.equal(scoreFormalSearch("exhausted-configurations", frontier), 1);
  assert.equal(scoreFormalSearch("explored-states", formalSearchFrontier(facts, contract.models, "2026-10-17T15:00:12Z")), 195319696);
  const original = `${directory}/preflight/8925e9f07de701fad9c12720c40f5c21750ce8ea6e1ee9fbce5b2fa086e327d7`;
  assert.equal(censusDigest(readCensusJson(`${original}/facts.json.gz`)), index.factsSha256);
  const timeline = JSON.parse(readFileSync(
    "docs/operational-value/proof/reports/github-gh-aw/daily-work-queue-formal-verification-timeline.json", "utf8"));
  assert.equal(timeline.valueFunction.definition.evidence.sourcePolicySha256, censusDigest(contract));
  for (const snapshot of timeline.snapshots) {
    const replay = formalSearchFrontier(facts, contract.models, snapshot.window.endAt);
    assert.equal(snapshot.metrics["explored-states"], scoreFormalSearch("explored-states", replay));
    assert.equal(snapshot.metrics["exhausted-configurations"], scoreFormalSearch("exhausted-configurations", replay));
    assert.ok(snapshot.provenance.some(row => row.kind === "native-formal-search-index" && row.ref === censusDigest(index)));
  }
});
