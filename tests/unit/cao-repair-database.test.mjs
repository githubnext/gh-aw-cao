import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { commandHandlers } from "../../activity/commands/index.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const cao = path.join(root, manifest.bin.cao);
const runCao = (args) => JSON.parse(execFileSync(process.execPath, [cao, ...args], { encoding: "utf8" }));

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "cao-repair-database-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, database: path.join(directory, "snapshot.sqlite") };
}

function ingest(database) {
  runCao([
    "ingest", "--database", database,
    "--context", path.join(root, "dashboard/site/test/fixtures/gh-aw-logs/context.json"),
    "--logs", path.join(root, "dashboard/site/test/fixtures/gh-aw-logs/run-303"),
    "--retention-days", "all", "--run-retention-days", "all",
  ]);
}

test("registers and advertises only repair-database for Node SQLite maintenance", () => {
  assert.equal(commandHandlers.has("repair-database"), true);
  assert.equal(commandHandlers.has("doctor"), false);
  const help = execFileSync(process.execPath, [cao, "--help"], { encoding: "utf8" });
  assert.match(help, /cao repair-database \[--database FILE\] \[--ttl-days DAYS\|all\] \[--run-ttl-days DAYS\|all\]/);
  assert.match(help, /Mutates SQLite: backs up before repairs and prunes expired\/orphaned records, even without corruption/);
  assert.doesNotMatch(help, /cao doctor\b/);
});

test("rejects retired doctor before parsing options or falling back to legacy ingestion", (t) => {
  const { directory, database } = fixture(t);
  ingest(database);
  const before = readFileSync(database);
  mkdirSync(path.join(directory, "logs"));
  writeFileSync(path.join(directory, "doctor"), "{}");
  const files = readdirSync(directory).sort();
  for (const args of [
    ["doctor"], ["doctor", "--help"], ["doctor", "--json"],
    ["doctor", "logs"], ["doctor", database],
    ["doctor", "--database", database],
    ["doctor", "--database", "missing.sqlite", "--ttl-days", "all"],
  ]) {
    const result = spawnSync(process.execPath, [cao, ...args], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Error: Unknown command: doctor; use repair-database for SQLite backup, repair, and retention\n");
    assert.deepEqual(readFileSync(database), before);
    assert.deepEqual(readdirSync(directory).sort(), files);
  }
});

test("preserves historical retention flags and backs up healthy SQLite before pruning", (t) => {
  const { database } = fixture(t);
  ingest(database);
  const query = (filename) => runCao(["query", "--database", filename, "--collection", "runs"]);
  const runs = query(database);
  assert.equal(runs.length, 1);
  const retained = runCao(["repair-database", "--database", database, "--ttl-days", "all", "--run-ttl-days", "all"]);
  assert.equal(retained.command, "repair-database");
  assert.equal(retained.healthy, true);
  assert.equal(retained.ttlDays, "all");
  assert.equal(retained.runTtlDays, "all");
  assert.equal(retained.after.counts.runs, 1);
  assert.deepEqual(retained.repairs.errors, []);

  const repaired = runCao(["repair-database", "--database", database, "--ttl-days", "7", "--run-ttl-days", "30"]);
  assert.equal(repaired.command, "repair-database");
  assert.equal(repaired.healthy, true);
  assert.equal(repaired.ttlDays, 7);
  assert.equal(repaired.runTtlDays, 30);
  assert.deepEqual(repaired.before.sqlite.integrity, ["ok"]);
  assert.equal(repaired.before.counts.runs, 1);
  assert.equal(repaired.after.counts.runs, 0);
  assert.ok(repaired.repairs.actions.includes("prune-expired-or-orphaned-records"));
  assert.ok(repaired.repairs.canonicalRecordsRemoved > 0);
  assert.match(repaired.repairs.backup, /\.doctor-backup-.*\.sqlite$/);
  assert.deepEqual(query(repaired.repairs.backup), runs);
});

test("reports an unhealthy repair with exit status 2 without changing the original", (t) => {
  const { directory, database } = fixture(t);
  writeFileSync(database, "not a SQLite database");
  const before = readFileSync(database);
  const result = spawnSync(process.execPath, [cao, "repair-database", "--database", database], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.command, "repair-database");
  assert.equal(report.healthy, false);
  assert.equal(report.error, "Database repair requires a successful backup");
  assert.equal(report.repairs.backup, null);
  assert.ok(report.repairs.errors.some((error) => error.startsWith("backup:")));
  assert.deepEqual(readFileSync(database), before);
  assert.deepEqual(readdirSync(directory), ["snapshot.sqlite"]);
});

test("rejects unsupported and invalid options before mutating the snapshot", (t) => {
  const { database } = fixture(t);
  ingest(database);
  const before = readFileSync(database);
  for (const args of [
    ["--read-only"], ["--ttl-days", "0"], ["--run-ttl-days", "0"],
  ]) {
    const result = spawnSync(process.execPath, [cao, "repair-database", "--database", database, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Error: /);
    assert.deepEqual(readFileSync(database), before);
  }
});
