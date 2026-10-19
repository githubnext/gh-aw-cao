import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fixturePopulation, safeLedgerFixture, verifyLedgerProjection } from "../../scripts/ledger-projection-oracle.mjs";
import { ledgerProjectionModule, scoreLedgerProjection } from "../../scripts/native-ledger-projection-value.mjs";
import { censusDigest, readCensusJson } from "../../scripts/operational-value-census-io.mjs";

const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = text => createHash("sha256").update(text).digest("hex");
const id = index => `ldg-${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`;
const log = { name: "log", type: "log", max_segment_kb: 100,
  schema: { type: "object", required: ["workflow_run_id"], additionalProperties: false,
    properties: { workflow_run_id: { type: "string" } } } };
const table = { name: "smoke", type: "table", key: "workflow_run_id", max_segment_kb: 100 };
const record = (index, value, parents = [], operation = "append") => {
  const body = { version: 1, id: id(index), type: "ledger_append", parents,
    timestamp: "2026-10-01T00:00:00.000Z", payload: { id: id(index + 100), operation, value } };
  return { ...body, sha: `sha256:${hash(canonical(body))}` };
};

function workspace(run) {
  const root = mkdtempSync(path.join(tmpdir(), "cao-ledger-replay-test-"));
  try {
    const native = path.join(root, "native"), memory = path.join(root, "memory");
    mkdirSync(native);
    mkdirSync(path.join(memory, "ledger/shards"), { recursive: true });
    const bundle = readCensusJson("docs/operational-value/proof/ledger-projections/native-sources.json.gz");
    for (const source of bundle.sources) {
      assert.match(source.file, /^[a-z0-9_-]+\.cjs$/);
      assert.equal(hash(source.text), source.sha256);
      assert.equal(createHash("sha1").update(`blob ${Buffer.byteLength(source.text)}\0`).update(source.text).digest("hex"), source.gitBlob);
      writeFileSync(path.join(native, source.file), source.text);
    }
    const write = rows => writeFileSync(path.join(memory, "ledger/shards/00000000-0000-4000-8000-000000000000.jsonl"),
      rows.map(row => `${canonical(row)}\n`).join(""));
    run({ root, native, memory, write });
  } finally { rmSync(root, { recursive: true }); }
}

test("ledger row scoring preserves native counts and distinguishes unknown from valid zero", () => {
  const evidence = { valid: true, readOnly: true, eligible: 3, matched: 2 };
  assert.equal(scoreLedgerProjection("verified-rows", evidence), 2);
  assert.equal(scoreLedgerProjection("unmatched-rows", evidence), 1);
  assert.equal(scoreLedgerProjection("verified-rows", { ...evidence, matched: 0 }), 0);
  for (const bad of [{}, { ...evidence, eligible: 0 }, { ...evidence, matched: 4 }, { ...evidence, readOnly: false }]) {
    assert.equal(scoreLedgerProjection("verified-rows", bad), null);
  }
});

test("the safe retained facet excludes extra payloads, arbitrary identifiers and noncanonical timestamps", () => {
  const good = record(1, { workflow_run_id: "12345" });
  assert.equal(safeLedgerFixture(good, log), true);
  assert.equal(safeLedgerFixture({ ...good, timestamp: "October 1, 2026" }, log), false);
  assert.equal(safeLedgerFixture({ ...good, id: "arbitrary" }, log), false);
  assert.equal(safeLedgerFixture(record(2, { workflow_run_id: "12345", extra: "excluded" }), log), false);
  assert.equal(safeLedgerFixture(record(2, { workflow_run_id: "not-a-run" }), log), false);
});

test("the actual pinned production ledger stack round-trips causally ordered log fixtures into read-only SQLite", () => {
  workspace(({ native, memory, write }) => {
    const first = record(1, { workflow_run_id: "12345" });
    const second = record(2, { workflow_run_id: "23456" }, [first.sha]);
    write([second, first]);
    assert.deepEqual(fixturePopulation(memory, log).map(row => row.sha), [first.sha, second.sha]);
    const result = verifyLedgerProjection(native, memory, log);
    assert.equal(result.status, "available");
    assert.equal(result.readOnly, true);
    assert.equal(result.eligible, 2);
    assert.equal(result.matched, 2);
    assert.ok(result.proofs.every(row => row.expectedSha256 === row.actualSha256));
  });
});

test("production table upserts preserve one fixture row without re-crediting duplicate run keys", () => {
  workspace(({ native, memory, write }) => {
    const value = { record_type: "repo_memory_ledger_smoke", workflow_run_id: "12345", result: "passed" };
    const first = record(1, value, [], "upsert"), second = record(2, value, [first.sha], "upsert");
    write([first, second]);
    const result = verifyLedgerProjection(native, memory, table);
    assert.equal(result.status, "available");
    assert.equal(result.records, 2);
    assert.equal(result.eligible, 1);
    assert.equal(result.matched, 1);
  });
});

test("missing parents and tampered hashes cannot become positive ledger replay evidence", () => {
  workspace(({ native, memory, write }) => {
    write([record(1, { workflow_run_id: "12345" }, [`sha256:${"a".repeat(64)}`])]);
    assert.equal(verifyLedgerProjection(native, memory, log).status, "unavailable");
    const good = record(1, { workflow_run_id: "12345" });
    write([{ ...good, payload: { ...good.payload, value: { workflow_run_id: "23456" } } }]);
    assert.equal(verifyLedgerProjection(native, memory, log).status, "unavailable");
  });
});

for (const contract of readCensusJson("docs/operational-value/proof/ledger-projections/contracts.json")) {
  test(`${contract.workflowId} replays every retained genuine Git state through production SQLite`, () => {
      const directory = "docs/operational-value/proof/ledger-projections";
      const index = readCensusJson(`${directory}/${contract.workflowId}-index.json`);
      assert.equal(index.complete, true);
      assert.equal(index.contractSha256, censusDigest(contract));
      assert.equal(contract.oracleSha256, hash(readFileSync("scripts/ledger-projection-oracle.mjs")));
      assert.deepEqual(readCensusJson(`${directory}/native-sources.json.gz`).sources.map(({ text: _, ...source }) => source),
        contract.nativeSources);
      const states = readCensusJson(`${directory}/${index.statesFile}`);
      assert.equal(states.length, index.states);
      assert.equal(censusDigest(states), index.statesSha256);
      const blobs = new Map(readCensusJson(`${directory}/fixture-blobs.json.gz`).map(blob => {
        assert.equal(createHash("sha1").update(`blob ${Buffer.byteLength(blob.text)}\0`).update(blob.text).digest("hex"), blob.gitBlob);
        return [blob.gitBlob, blob.text];
      }));
      assert.equal(states.filter(state => state.result.status === "available").length, 4);
      assert.equal(states.at(-1).result.matched, 4);
      for (const state of states) {
        workspace(({ native, memory }) => {
          for (const file of state.files) {
            assert.match(file.path, /^ledger\/shards\/[a-f0-9-]{36}\.jsonl$/);
            assert.ok(blobs.has(file.gitBlob));
            writeFileSync(path.join(memory, file.path), blobs.get(file.gitBlob));
          }
          assert.deepEqual(verifyLedgerProjection(native, memory, contract.config), state.result);
        });
      }
      const module = ledgerProjectionModule(contract);
      const timeline = JSON.parse(readFileSync(
        `docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`, "utf8"));
      const requests = timeline.snapshots.map(snapshot => ({ repository: contract.repository,
        windowStart: snapshot.window.startAt, windowEnd: snapshot.window.endAt, observedAt: snapshot.observedAt }));
      const replay = module.collectBatch(requests);
      for (const [position, snapshot] of timeline.snapshots.entries()) {
        assert.deepEqual(snapshot.evidence, replay[position].evidence);
        for (const id of ["verified-rows", "unmatched-rows"]) {
          assert.equal(snapshot.metrics[id], scoreLedgerProjection(id, replay[position].evidence));
        }
      }
  });
}
