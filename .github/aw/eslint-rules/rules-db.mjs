#!/usr/bin/env node
// ESLint Factory rules database builder.
//
// Rebuilds a queryable SQLite database from the append-only JSONL transaction
// logs that are the authoritative memory of the `eslint-rules` package. The
// JSONL logs always win: the database is a disposable derived artifact that can
// be thrown away and rebuilt from the same logs.
//
// Deliberate properties:
//   * Standard library only (`node:sqlite`, `node:fs`, `node:path`).
//   * Deterministic: identical logs produce an identical database file.
//   * Atomic: the destination is replaced by rename, never written in place.
//   * Fail closed: any malformed line, unknown schema, unsupported version, or
//     duplicate transaction id aborts the rebuild and leaves the previous
//     database untouched.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, rmSync, renameSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TRANSACTION_SCHEMA = "cao.eslint-rules.transaction";
export const SUPPORTED_SCHEMA_VERSIONS = [1];
export const DATABASE_SCHEMA_VERSION = 1;
export const TRANSACTION_KINDS = [
  "adoption-request",
  "lint-inventory",
  "repository-priority",
  "rule-candidate",
  "rule-normalization",
  "rule-outcome",
];

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,80}$/;
const LOG_BASENAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,239}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const WORKER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class RulesDatabaseError extends Error {}

function fail(message) {
  throw new RulesDatabaseError(message);
}

function requireString(record, field, where) {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) fail(`${where}: "${field}" must be a non-empty string`);
  return value;
}

function optionalString(record, field, where) {
  if (record[field] === undefined || record[field] === null) return "";
  if (typeof record[field] !== "string") fail(`${where}: "${field}" must be a string when present`);
  return record[field];
}

/** Reads every transaction log in the memory directory in deterministic order. */
export function readTransactionLogs(memoryDirectory) {
  const logDirectory = path.join(memoryDirectory, "transactions");
  if (!existsSync(logDirectory)) return [];
  const files = readdirSync(logDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name)
    .sort();
  return files.map((name) => {
    if (!LOG_BASENAME_PATTERN.test(name.slice(0, -".jsonl".length))) {
      fail(`transactions/${name}: log file name is not collision-safe`);
    }
    return { name, text: readFileSync(path.join(logDirectory, name), "utf8") };
  });
}

/** Stable JSON with lexicographically sorted object keys at every depth. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function parseTransaction(raw, sourceFile, sourceLine) {
  const where = `transactions/${sourceFile}:${sourceLine}`;
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    fail(`${where}: line is not valid JSON`);
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    fail(`${where}: line must be a JSON object`);
  }
  if (record.schema !== TRANSACTION_SCHEMA) {
    fail(`${where}: unexpected schema ${JSON.stringify(record.schema ?? null)}`);
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(record.schema_version)) {
    fail(`${where}: unsupported schema_version ${JSON.stringify(record.schema_version ?? null)}`);
  }
  const txnId = requireString(record, "txn_id", where);
  if (!IDENTIFIER_PATTERN.test(txnId)) fail(`${where}: "txn_id" is not collision-safe`);
  const recordedAt = requireString(record, "recorded_at", where);
  if (!TIMESTAMP_PATTERN.test(recordedAt) || Number.isNaN(Date.parse(recordedAt))) {
    fail(`${where}: "recorded_at" must be an ISO 8601 UTC timestamp`);
  }
  const worker = requireString(record, "worker", where);
  if (!WORKER_PATTERN.test(worker)) fail(`${where}: "worker" is not a slug`);
  const kind = requireString(record, "kind", where);
  if (!TRANSACTION_KINDS.includes(kind)) fail(`${where}: unknown kind ${JSON.stringify(kind)}`);
  const targetRepoValue = requireString(record, "target_repo", where);
  if (!REPOSITORY_PATTERN.test(targetRepoValue)) fail(`${where}: "target_repo" must be owner/repository`);
  const targetRepo = targetRepoValue.toLowerCase();
  const ruleKey = optionalString(record, "rule_key", where);
  if (!["lint-inventory", "repository-priority"].includes(kind) && !ruleKey) {
    fail(`${where}: "rule_key" is required for kind ${kind}`);
  }
  if (ruleKey && !IDENTIFIER_PATTERN.test(ruleKey)) fail(`${where}: "rule_key" is not collision-safe`);
  const payload = record.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    fail(`${where}: "payload" must be a JSON object`);
  }
  return {
    txnId,
    recordedAt,
    worker,
    kind,
    ruleKey,
    targetRepo,
    centralRepo: optionalString(record, "central_repo", where),
    correlationId: optionalString(record, "correlation_id", where),
    runUrl: optionalString(record, "run_url", where),
    sourceFile,
    sourceLine,
    payload: canonicalJson(payload),
  };
}

/** Validates every transaction and returns them in deterministic order. */
export function collectTransactions(memoryDirectory) {
  const transactions = [];
  const seen = new Map();
  for (const log of readTransactionLogs(memoryDirectory)) {
    const lines = log.text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index];
      if (raw.length === 0) continue;
      if (raw.trim().length === 0) fail(`transactions/${log.name}:${index + 1}: line contains only whitespace`);
      const transaction = parseTransaction(raw, log.name, index + 1);
      const previous = seen.get(transaction.txnId);
      if (previous) {
        fail(
          `transactions/${log.name}:${index + 1}: duplicate txn_id ${transaction.txnId} (first seen at transactions/${previous})`,
        );
      }
      seen.set(transaction.txnId, `${log.name}:${index + 1}`);
      transactions.push(transaction);
    }
  }
  transactions.sort(
    (left, right) =>
      left.recordedAt.localeCompare(right.recordedAt) ||
      left.txnId.localeCompare(right.txnId) ||
      left.sourceFile.localeCompare(right.sourceFile) ||
      left.sourceLine - right.sourceLine,
  );
  return transactions;
}

function summariseRules(transactions) {
  const rules = new Map();
  for (const transaction of transactions) {
    if (!transaction.ruleKey) continue;
    const rule = rules.get(transaction.ruleKey) || {
      ruleKey: transaction.ruleKey,
      firstSeenAt: transaction.recordedAt,
      lastSeenAt: transaction.recordedAt,
      candidates: 0,
      outcomes: 0,
      normalizations: 0,
      adoptionRequests: 0,
      targets: new Set(),
    };
    rule.lastSeenAt = transaction.recordedAt;
    rule.targets.add(transaction.targetRepo);
    if (transaction.kind === "rule-candidate") rule.candidates += 1;
    if (transaction.kind === "rule-outcome") rule.outcomes += 1;
    if (transaction.kind === "rule-normalization") rule.normalizations += 1;
    if (transaction.kind === "adoption-request") rule.adoptionRequests += 1;
    rules.set(transaction.ruleKey, rule);
  }
  return [...rules.values()].sort((left, right) => left.ruleKey.localeCompare(right.ruleKey));
}

function summariseInventory(transactions) {
  const inventory = new Map();
  for (const transaction of transactions) {
    if (transaction.kind !== "lint-inventory") continue;
    inventory.set(transaction.targetRepo, transaction);
  }
  return [...inventory.values()].sort((left, right) => left.targetRepo.localeCompare(right.targetRepo));
}

function summarisePriorities(transactions) {
  const priorities = new Map();
  for (const transaction of transactions) {
    if (transaction.kind !== "repository-priority") continue;
    priorities.set(transaction.targetRepo, transaction);
  }
  return [...priorities.values()].sort((left, right) => left.targetRepo.localeCompare(right.targetRepo));
}

const DDL = [
  "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
  `CREATE TABLE transactions (
    seq INTEGER PRIMARY KEY,
    txn_id TEXT NOT NULL UNIQUE,
    recorded_at TEXT NOT NULL,
    worker TEXT NOT NULL,
    kind TEXT NOT NULL,
    rule_key TEXT NOT NULL,
    target_repo TEXT NOT NULL,
    central_repo TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    run_url TEXT NOT NULL,
    source_file TEXT NOT NULL,
    source_line INTEGER NOT NULL,
    payload TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE rules (
    rule_key TEXT PRIMARY KEY,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    candidate_count INTEGER NOT NULL,
    outcome_count INTEGER NOT NULL,
    normalization_count INTEGER NOT NULL,
    adoption_request_count INTEGER NOT NULL,
    target_count INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE lint_inventory (
    target_repo TEXT PRIMARY KEY,
    recorded_at TEXT NOT NULL,
    txn_id TEXT NOT NULL,
    payload TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE repository_priority (
    target_repo TEXT PRIMARY KEY,
    recorded_at TEXT NOT NULL,
    txn_id TEXT NOT NULL,
    payload TEXT NOT NULL
  ) STRICT`,
  "CREATE INDEX transactions_rule_key ON transactions (rule_key, seq)",
  "CREATE INDEX transactions_target_repo ON transactions (target_repo, seq)",
];

function writeDatabase(databasePath, transactions) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA journal_mode = DELETE");
    for (const statement of DDL) database.exec(statement);
    const insertTransaction = database.prepare(
      `INSERT INTO transactions
        (seq, txn_id, recorded_at, worker, kind, rule_key, target_repo, central_repo, correlation_id, run_url, source_file, source_line, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    transactions.forEach((transaction, index) => {
      insertTransaction.run(
        index + 1,
        transaction.txnId,
        transaction.recordedAt,
        transaction.worker,
        transaction.kind,
        transaction.ruleKey,
        transaction.targetRepo,
        transaction.centralRepo,
        transaction.correlationId,
        transaction.runUrl,
        transaction.sourceFile,
        transaction.sourceLine,
        transaction.payload,
      );
    });
    const rules = summariseRules(transactions);
    const insertRule = database.prepare(
      "INSERT INTO rules (rule_key, first_seen_at, last_seen_at, candidate_count, outcome_count, normalization_count, adoption_request_count, target_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const rule of rules) {
      insertRule.run(
        rule.ruleKey,
        rule.firstSeenAt,
        rule.lastSeenAt,
        rule.candidates,
        rule.outcomes,
        rule.normalizations,
        rule.adoptionRequests,
        rule.targets.size,
      );
    }
    const inventory = summariseInventory(transactions);
    const insertInventory = database.prepare(
      "INSERT INTO lint_inventory (target_repo, recorded_at, txn_id, payload) VALUES (?, ?, ?, ?)",
    );
    for (const entry of inventory) {
      insertInventory.run(entry.targetRepo, entry.recordedAt, entry.txnId, entry.payload);
    }
    const priorities = summarisePriorities(transactions);
    const insertPriority = database.prepare(
      "INSERT INTO repository_priority (target_repo, recorded_at, txn_id, payload) VALUES (?, ?, ?, ?)",
    );
    for (const entry of priorities) {
      insertPriority.run(entry.targetRepo, entry.recordedAt, entry.txnId, entry.payload);
    }
    const insertMeta = database.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    for (const [key, value] of [
      ["database_schema_version", String(DATABASE_SCHEMA_VERSION)],
      ["inventory_count", String(inventory.length)],
      ["repository_priority_count", String(priorities.length)],
      ["rule_count", String(rules.length)],
      ["transaction_count", String(transactions.length)],
      ["transaction_schema", TRANSACTION_SCHEMA],
    ]) {
      insertMeta.run(key, value);
    }
    return { rules: rules.length, inventory: inventory.length, priorities: priorities.length };
  } finally {
    database.close();
  }
}

const TEMPORARY_SUFFIXES = ["", "-journal", "-wal", "-shm"];

/**
 * Rebuilds `databasePath` from the JSONL transaction logs under `memoryDirectory`.
 * Throws without touching an existing database when the logs are malformed.
 */
export function rebuildDatabase({ memoryDirectory, databasePath }) {
  const transactions = collectTransactions(memoryDirectory);
  const resolved = path.resolve(databasePath);
  const temporaryPath = `${resolved}.rebuild.tmp`;
  mkdirSync(path.dirname(resolved), { recursive: true });
  for (const suffix of TEMPORARY_SUFFIXES) rmSync(`${temporaryPath}${suffix}`, { force: true });
  let summary;
  try {
    summary = writeDatabase(temporaryPath, transactions);
  } catch (error) {
    for (const suffix of TEMPORARY_SUFFIXES) rmSync(`${temporaryPath}${suffix}`, { force: true });
    throw error;
  }
  renameSync(temporaryPath, resolved);
  return { transactions: transactions.length, ...summary };
}

function parseArguments(argv) {
  const options = { command: argv[0] || "", memoryDirectory: "", databasePath: "" };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--memory") options.memoryDirectory = argv[++index] || "";
    else if (argument === "--database") options.databasePath = argv[++index] || "";
    else fail(`unknown argument ${JSON.stringify(argument)}`);
  }
  return options;
}

export function run(argv) {
  const options = parseArguments(argv);
  if (options.command !== "build" && options.command !== "verify") {
    fail("usage: rules-db.mjs <build|verify> --memory <directory> [--database <path>]");
  }
  if (!options.memoryDirectory) fail("--memory is required");
  if (options.command === "verify") {
    return { command: "verify", transactions: collectTransactions(options.memoryDirectory).length };
  }
  if (!options.databasePath) fail("--database is required for build");
  return {
    command: "build",
    database: options.databasePath,
    ...rebuildDatabase({ memoryDirectory: options.memoryDirectory, databasePath: options.databasePath }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`rules-db: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
