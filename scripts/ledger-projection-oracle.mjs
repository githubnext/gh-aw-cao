import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const keys = (value, expected) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === expected.split(",").sort().join(",");
const uuid = value => typeof value === "string" && /^ldg-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const runId = value => typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value);
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

export function fixturePopulation(memoryDirectory, config) {
  const directory = path.join(memoryDirectory, "ledger/shards");
  const files = readdirSync(directory);
  if (files.length > 1024) throw new Error("Native fixture file budget exhausted");
  const records = new Map();
  for (const file of files) {
    if (!/^[a-f0-9-]{36}\.jsonl$/.test(file) || !lstatSync(path.join(directory, file)).isFile()) {
      return null;
    }
    const text = readFileSync(path.join(directory, file), "utf8"), lines = text.split("\n");
    if (lines.pop() !== "" || Buffer.byteLength(text) > 100 * 1024) return null;
    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; return null; }
      if (!safeLedgerFixture(record, config) || line !== canonical(record)) return null;
      const { sha, ...body } = record;
      if (sha !== `sha256:${createHash("sha256").update(canonical(body)).digest("hex")}`) return null;
      records.set(sha, record);
    }
  }
  const ordered = [], remaining = new Map([...records].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  while (remaining.size) {
    const ready = [...remaining.values()].filter(record => record.parents.every(parent =>
      records.has(parent) && !remaining.has(parent)));
    if (!ready.length) return null;
    for (const record of ready) { ordered.push(record); remaining.delete(record.sha); }
  }
  return ordered;
}

export function safeLedgerFixture(record, config) {
  if (!keys(record, "id,parents,payload,sha,timestamp,type,version") || record.version !== 1
    || !uuid(record.id) || record.type !== "ledger_append" || !Array.isArray(record.parents)
    || record.parents.some(value => !/^sha256:[a-f0-9]{64}$/.test(value))
    || typeof record.timestamp !== "string" || !Number.isFinite(Date.parse(record.timestamp))
    || new Date(record.timestamp).toISOString() !== record.timestamp
    || typeof record.sha !== "string" || !/^sha256:[a-f0-9]{64}$/.test(record.sha)
    || !keys(record.payload, "id,operation,value") || !uuid(record.payload.id)) return false;
  const { operation, value } = record.payload;
  if (config.type === "log") return operation === "append"
    && keys(value, "workflow_run_id") && runId(value.workflow_run_id);
  return config.type === "table" && operation === "upsert"
    && keys(value, "record_type,workflow_run_id,result") && value.record_type === "repo_memory_ledger_smoke"
    && value.result === "passed" && runId(value.workflow_run_id);
}

export function verifyLedgerProjection(sourceDirectory, memoryDirectory, config) {
  const require = createRequire(path.join(sourceDirectory, "native-oracle.cjs"));
  const { Ledger, canonicalJSON } = require("./ledger_store.cjs");
  const { replayBuiltin } = require("./ledger_builtin.cjs");
  const { materializeReplay } = require("./ledger_replay.cjs");
  const ledger = new Ledger({ memoryDir: memoryDirectory, maxSegmentBytes: config.max_segment_kb * 1024 });
  const temporary = mkdtempSync(path.join(tmpdir(), "cao-ledger-projection-"));
  let readOnly;
  try {
    const input = fixturePopulation(memoryDirectory, config);
    if (!input) return { status: "unavailable", reason: "Independent fixture envelope, hash or causal-history validation failed." };
    const state = ledger.reconstruct();
    if (state.diagnostics.length) return { status: "unavailable", reason: "Canonical ledger diagnostics prohibit a valid production projection.",
      diagnosticCodes: [...new Set(state.diagnostics.map(row => row.code))] };
    if (!state.records.length) return { status: "unavailable", reason: "No persisted fixture opportunity." };
    if (!state.records.every(record => safeLedgerFixture(record, config))) {
      return { status: "unavailable", reason: "Historical records do not match the frozen partial fixture facet." };
    }
    const database = ledger.project(state);
    if (!database) throw new Error("Native ledger production projection requires Node SQLite");
    materializeReplay(database, config.name, `builtin:${config.type}`, state.records,
      replayBuiltin(config, state.records), state.records.length);
    const filename = path.join(temporary, "projection.sqlite");
    database.exec(`VACUUM INTO '${filename.replaceAll("'", "''")}'`);
    chmodSync(filename, 0o444);
    readOnly = new DatabaseSync(filename, { readOnly: true });
    const actual = readOnly.prepare("SELECT * FROM state ORDER BY 1").all();
    assertReadOnly(readOnly);
    const expected = config.type === "log"
      ? input.map((record, position) => ({ position, value: JSON.stringify({ workflow_run_id: record.payload.value.workflow_run_id }) }))
      : [...new Map(input.map(record => [record.payload.value.workflow_run_id, {
        key: record.payload.value.workflow_run_id,
        value: JSON.stringify({ record_type: "repo_memory_ledger_smoke", result: "passed",
          workflow_run_id: record.payload.value.workflow_run_id }),
      }])).values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const digest = value => createHash("sha256").update(canonicalJSON(value)).digest("hex");
    const actualByKey = new Map(actual.map(row => [row.position ?? row.key, row]));
    const proofs = expected.map(row => ({ identity: String(row.position ?? row.key), expectedSha256: digest(row),
      actualSha256: actualByKey.has(row.position ?? row.key) ? digest(actualByKey.get(row.position ?? row.key)) : null }));
    if (actual.length > expected.length) throw new Error("Native ledger projection contains unexplained rows");
    return { status: "available", readOnly: true, eligible: expected.length,
      matched: proofs.filter(row => row.expectedSha256 === row.actualSha256).length,
      records: state.records.length, proofs };
  } finally {
    readOnly?.close();
    ledger.close();
    rmSync(temporary, { recursive: true });
  }
}

function assertReadOnly(database) {
  try { database.exec("DELETE FROM state"); }
  catch (error) {
    if (/readonly database/.test(error.message)) return;
    throw error;
  }
  throw new Error("Native ledger projection was writable");
}

if (process.argv[1] === import.meta.filename) {
  if (process.argv.length !== 5) throw new Error("usage: ledger-projection-oracle.mjs SOURCE_DIRECTORY MEMORY_DIRECTORY CONFIG_JSON");
  console.log(JSON.stringify(verifyLedgerProjection(process.argv[2], process.argv[3], JSON.parse(process.argv[4]))));
}
