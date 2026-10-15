import { DatabaseSync } from "node:sqlite";
import { chmodSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { createHash } from "node:crypto";
import { parseDashboardCommand } from "./cli-actions.mjs";
import { maximumCliActionInputCharacters, maximumCliActionRequestBytes } from "./cli-action-contract.mjs";

export const dashboardQueueLimits = Object.freeze({
  maxConcurrency: 32,
  maxJobs: 10000,
  maxInputBytes: maximumCliActionRequestBytes,
  maxChunkBytes: 16 * 1024,
  maxOutputBytes: 1024 * 1024,
  maxDatabaseOutputBytes: 64 * 1024 * 1024,
  maxDatabaseBytes: 128 * 1024 * 1024,
  maxOutputChunks: 4096,
  maxPageSize: 500,
  maxPreviewBytes: 64 * 1024,
  retentionDays: 30,
});

const terminal = new Set(["completed", "failed", "canceled", "timed-out"]);
const statuses = new Set(["queued", "running", ...terminal]);
const sensitiveKey = /(?:token|secret|password|credential|authorization|private[-_]?key)/i;
const secretText = /(?:\b(?:gh[pousr]_[a-z0-9_]+|github_pat_[a-z0-9_]+|AKIA[A-Z0-9]{16})|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|(?:token|secret|password|credential|authorization|private[-_]?key)\s*["']?\s*[:=]\s*["']?\S+|--[\w-]*(?:token|password|secret|credential)\b)/i;
const redact = (text) => text
  .replace(/\b(?:gh[pousr]_[a-z0-9_]+|github_pat_[a-z0-9_]+)/gi, "[REDACTED]")
  .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED]")
  .replace(/\bBearer\s+\S+/gi, "******")
  .replace(/((?:token|secret|password|credential|authorization|private[-_]?key)\s*["']?\s*[:=]\s*).*/gi, "$1[REDACTED]")
  .replace(/-----BEGIN .*PRIVATE KEY-----.*/gi, "[REDACTED]");

function monday(timestamp) {
  const date = new Date(timestamp);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid queue ${label}.`);
  }
  return value;
}

function validateInvocation(invocation, maxBytes) {
  if (!invocation || typeof invocation !== "object") throw new Error("Invalid queue invocation.");
  const { actionId, command, arguments: args = {}, values = {}, input } = invocation;
  if (typeof actionId !== "string" || !actionId || actionId.length > 256
    || !args || typeof args !== "object" || Array.isArray(args)
    || Object.values(args).some((arg) => typeof arg !== "boolean")
    || !values || typeof values !== "object" || Array.isArray(values)
    || Object.values(values).some((value) => typeof value !== "string")
    || (input !== undefined && (typeof input !== "string" || input.length > maximumCliActionInputCharacters))) {
    throw new Error("Invalid queue invocation.");
  }
  parseDashboardCommand(command);
  const normalized = { actionId, command, arguments: args, values, ...(input === undefined ? {} : { input }) };
  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json) > maxBytes) throw new Error("Queue input limit exceeded.");
  if (secretText.test(json) || Object.keys(values).some((key) => sensitiveKey.test(key) && values[key])) {
    throw new Error("Secret-bearing CLI input cannot be persisted.");
  }
  return json;
}

/**
 * Single-owner durable queue. The caller supplies its database filename and the
 * existing executeDashboardCommand adapter; credentials stay outside invocations.
 * Admission is rechecked before every start and periodically while blocked.
 */
export function createCliActionQueue({
  filename, execute, admission = async () => ({ concurrency: maxConcurrency }),
  maxConcurrency = 1, timeoutMs = 15 * 60 * 1000,
  limits: overrides = {}, now = Date.now, admissionPollMs = 1000, sensitiveValues = [],
  retentionDays = overrides.retentionDays ?? dashboardQueueLimits.retentionDays,
}) {
  if (typeof filename !== "string" || !filename || filename === ":memory:"
    || typeof execute !== "function") throw new Error("A durable filename and executor are required.");
  const limits = { ...dashboardQueueLimits, ...overrides, retentionDays };
  for (const [key, value] of Object.entries(limits)) {
    integer(value, key === "retentionDays" ? 7 : 1,
      key === "retentionDays" ? 3650 : dashboardQueueLimits[key], key);
  }
  integer(maxConcurrency, 1, limits.maxConcurrency, "concurrency");
  integer(timeoutMs, 1, 15 * 60 * 1000, "timeout");
  integer(admissionPollMs, 1, 60000, "admission interval");
  if (!Array.isArray(sensitiveValues) || sensitiveValues.some((value) => typeof value !== "string" || value.length < 4)) {
    throw new Error("Invalid queue sensitive values.");
  }
  const secrets = [...new Set([...sensitiveValues, ...Object.entries(process.env)
    .filter(([key, value]) => sensitiveKey.test(key) && value?.length >= 8
      && !["true", "false", "enabled", "disabled"].includes(value.toLowerCase()))
    .map(([, value]) => value)])];
  const sanitize = (text) => {
    for (const secret of secrets) text = text.replaceAll(secret, "[REDACTED]");
    return redact(text);
  };
  const requested = resolve(filename);
  mkdirSync(dirname(requested), { recursive: true, mode: 0o700 });
  if (lstatSync(dirname(requested)).isSymbolicLink()) throw new Error("Queue directory cannot be a symbolic link.");
  const parentPath = realpathSync(dirname(requested));
  const parent = statSync(parentPath);
  if (process.getuid && parent.uid !== process.getuid()) throw new Error("Queue directory must be owned by the current user.");
  if (parent.mode & 0o077) {
    if (basename(parentPath) !== ".cao") throw new Error("Queue directory must be owner-only.");
    chmodSync(parentPath, 0o700);
  }
  const checkFile = (filename) => {
    try {
      const file = lstatSync(filename);
      if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1
        || (process.getuid && file.uid !== process.getuid())) {
        throw new Error("Queue files must be regular, single-link files owned by the current user.");
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  };
  const ownershipPath = `${requested}.owner.sqlite`;
  for (const databasePath of [requested, ownershipPath]) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) checkFile(`${databasePath}${suffix}`);
  }
  let path;
  try {
    path = realpathSync(requested);
    if (statSync(path).nlink !== 1) throw new Error("Hard-linked queue databases are not supported.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    path = resolve(parentPath, basename(requested));
  }
  // An OS-backed SQLite exclusive transaction releases ownership on a crash.
  // Keep this separate from the WAL database so normal commits cannot release it.
  const ownership = new DatabaseSync(`${path}.owner.sqlite`);
  let db;
  try {
    ownership.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE");
    chmodSync(`${path}.owner.sqlite`, 0o600);
    db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA wal_autocheckpoint=128;
      PRAGMA journal_size_limit=1048576;
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, invocation TEXT NOT NULL,
        idempotency_key TEXT UNIQUE, fingerprint TEXT NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER,
        completed_at INTEGER, completion_week TEXT, deadline INTEGER,
        ok INTEGER, exit_code INTEGER, error TEXT, output_bytes INTEGER NOT NULL DEFAULT 0,
        output_chunks INTEGER NOT NULL DEFAULT 0, output_truncated INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS jobs_fifo ON jobs(status,id);
      CREATE INDEX IF NOT EXISTS jobs_retention ON jobs(completion_week);
      CREATE TABLE IF NOT EXISTS output (
        job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, stream TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(job_id,seq)
      );
      CREATE TABLE IF NOT EXISTS queue_state (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_claims (
        job_id INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE RESTRICT
      );
    `);
    const pageSize = db.prepare("PRAGMA page_size").get().page_size;
    const maxPages = Math.floor(limits.maxDatabaseBytes / pageSize);
    if (db.prepare("PRAGMA page_count").get().page_count > maxPages) throw new Error("Queue database size limit exceeded.");
    db.exec(`PRAGMA max_page_count=${maxPages}`);
    if (!db.prepare("PRAGMA table_info(jobs)").all().some(({ name }) => name === "retry_of")) {
      db.exec("ALTER TABLE jobs ADD COLUMN retry_of INTEGER");
    }
    if (db.prepare("SELECT count(*) AS count FROM jobs WHERE status='running'").get().count
      || db.prepare("SELECT count(*) AS count FROM execution_claims").get().count) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT OR REPLACE INTO queue_state VALUES('recovery_blocked',?)")
          .run("CLI queue recovery is blocked: interrupted subprocess termination is unverified. Operator reconciliation is required.");
        db.prepare(`UPDATE jobs SET status='failed',ok=0,error='CLI action interrupted; subprocess termination is unverified.',
          completed_at=?,completion_week=? WHERE status='running'`).run(now(), monday(now()));
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
  } catch {
    db?.close();
    ownership.close();
    throw new Error("CLI queue database is unavailable or already owned.");
  }
  const listeners = new Set();
  const active = new Map();
  let closed = false;
  let pumping = false;
  let pumpTimer;
  let closePromise;
  let pumpTask = Promise.resolve();
  const recoveryReason = db.prepare("SELECT value FROM queue_state WHERE key='recovery_blocked'").get()?.value;
  let reconciliationFailed = Boolean(recoveryReason);
  let admissionReason = recoveryReason;
  let revision = 0;
  const assertOpen = () => { if (closed) throw new Error("CLI queue is closed."); };
  const emit = (event) => {
    revision += 1;
    for (const listener of listeners) {
      try { listener(event); } catch { /* Subscribers cannot break persistence. */ }
    }
  };
  function retain() {
    // Keep the partial cutoff week; only earlier, fully expired weeks can drop.
    const cutoff = monday(now() - limits.retentionDays * 86400000);
    db.prepare(`DELETE FROM jobs WHERE completion_week < ? AND status NOT IN ('queued','running')
      AND id NOT IN (SELECT job_id FROM execution_claims)`).run(cutoff);
  }
  retain();
  function detail(id) {
    assertOpen();
    const row = db.prepare("SELECT * FROM jobs WHERE id=?").get(integer(Number(id), 1, Number.MAX_SAFE_INTEGER, "id"));
    if (!row) return null;
    const preview = { stdout: "", stderr: "" };
    let remaining = limits.maxPreviewBytes;
    for (const chunk of db.prepare("SELECT stream,data FROM output WHERE job_id=? ORDER BY seq").iterate(row.id)) {
      const bytes = Buffer.from(chunk.data);
      if (bytes.length > remaining) break;
      preview[chunk.stream] += chunk.data;
      remaining -= bytes.length;
      if (remaining === 0) break;
    }
    return {
      id: row.id, ...JSON.parse(row.invocation), status: row.status,
      createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at,
      completionWeek: row.completion_week, deadline: row.deadline,
      idempotencyKey: row.idempotency_key, outputBytes: row.output_bytes,
      ...preview, ok: row.ok === null ? null : Boolean(row.ok),
      exitCode: row.exit_code, error: row.error, retryOf: row.retry_of,
      outputChunks: row.output_chunks, outputTruncated: Boolean(row.output_truncated),
      result: row.ok === null ? null : { ok: Boolean(row.ok), exitCode: row.exit_code, ...(row.error ? { error: row.error } : {}) },
      ...(row.status === "queued" && admissionReason ? { reason: admissionReason } : {}),
    };
  }
  function finish(id, status, result) {
    const completedAt = now();
    const changed = db.prepare(`UPDATE jobs SET status=?,ok=?,exit_code=?,error=?,completed_at=?,completion_week=?
      WHERE id=? AND status IN ('queued','running')`).run(status, result.ok ? 1 : 0,
      Number.isInteger(result.exitCode) ? result.exitCode : null,
      result.error ?? null, completedAt, monday(completedAt), id).changes;
    if (changed) {
      emit({ type: status, id, status });
      retain();
    }
  }
  function append(id, stream, data) {
    if (!data || closed) return;
    const row = db.prepare("SELECT status,output_bytes,output_chunks FROM jobs WHERE id=?").get(id);
    if (row?.status !== "running") return;
    const bytes = Buffer.byteLength(data);
    const total = db.prepare("SELECT coalesce(sum(output_bytes),0) AS bytes FROM jobs").get().bytes;
    if (bytes > limits.maxChunkBytes || row.output_bytes + bytes > limits.maxOutputBytes
      || row.output_chunks >= limits.maxOutputChunks || total + bytes > limits.maxDatabaseOutputBytes) {
      db.prepare("UPDATE jobs SET output_truncated=1 WHERE id=?").run(id);
      return;
    }
    const seq = row.output_chunks + 1;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO output VALUES(?,?,?,?)").run(id, seq, stream, data);
      db.prepare("UPDATE jobs SET output_bytes=output_bytes+?,output_chunks=? WHERE id=?").run(bytes, seq, id);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    emit({ type: "output", status: "running", id, chunk: { sequence: seq, stream, data } });
  }
  function recordTerminalExitCode(id, exitCode) {
    if (!Number.isInteger(exitCode)) return;
    const changed = db.prepare(`UPDATE jobs SET exit_code=? WHERE id=? AND status IN ('canceled','timed-out')`)
      .run(exitCode, id).changes;
    if (changed) emit({ type: "settled", id });
  }
  function start(row, decision) {
    const id = row.id;
    const controller = new AbortController();
    const deadline = now() + timeoutMs;
    db.prepare("UPDATE jobs SET status='running',started_at=?,deadline=? WHERE id=? AND status='queued'").run(now(), deadline, id);
    db.prepare("INSERT INTO execution_claims(job_id) VALUES(?)").run(id);
    const buffers = { stdout: "", stderr: "" };
    const dropping = { stdout: false, stderr: false };
    const privateKey = { stdout: false, stderr: false };
    const persistLine = (stream, line) => {
      if (/-----BEGIN .*PRIVATE KEY-----/.test(line)) privateKey[stream] = true;
      if (privateKey[stream]) {
        if (/-----END .*PRIVATE KEY-----/.test(line)) privateKey[stream] = false;
        append(id, stream, "[REDACTED]\n");
      } else append(id, stream, sanitize(line));
    };
    const consume = ({ stream, data }) => {
      if (closed || controller.signal.aborted) return;
      if (!(stream === "stdout" || stream === "stderr") || typeof data !== "string") throw new Error("Invalid CLI output.");
      // Frame before redaction: secrets split across subprocess chunks cannot leak.
      // Overlong lines are discarded rather than persisting an unclassifiable tail.
      let cursor = 0;
      while (cursor < data.length) {
        const end = data.indexOf("\n", cursor);
        const stop = end < 0 ? data.length : end + 1;
        if (!dropping[stream]) {
          if (Buffer.byteLength(buffers[stream]) + Buffer.byteLength(data.slice(cursor, stop)) > limits.maxChunkBytes) {
            buffers[stream] = "";
            dropping[stream] = true;
            db.prepare("UPDATE jobs SET output_truncated=1 WHERE id=?").run(id);
          } else buffers[stream] += data.slice(cursor, stop);
        }
        if (end >= 0) {
          if (!dropping[stream]) persistLine(stream, buffers[stream]);
          buffers[stream] = "";
          dropping[stream] = false;
        }
        cursor = stop;
      }
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish(id, "timed-out", { ok: false, error: "The CLI action exceeded its time limit." });
    }, timeoutMs);
    const state = { controller, promise: null };
    let executionResult;
    active.set(id, state);
    state.promise = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return execute({
        ...JSON.parse(row.invocation), signal: controller.signal, deadline, timeoutMs,
        onOutput: async (chunk) => {
          await decision.onOutput?.(chunk);
          consume(chunk);
        },
      });
    }).then((result) => {
      executionResult = result;
      recordTerminalExitCode(id, result?.exitCode);
      if (!controller.signal.aborted) {
        for (const stream of ["stdout", "stderr"]) {
          if (typeof result?.[stream] === "string" && result[stream]) consume({ stream, data: result[stream] });
          persistLine(stream, buffers[stream]);
        }
        finish(id, result?.ok ? "completed" : "failed", {
          ok: Boolean(result?.ok), exitCode: result?.exitCode,
          ...(!result?.ok ? { error: "The CLI action did not complete successfully." } : {}),
        });
      }
    }).catch((error) => {
      executionResult = { ok: false, exitCode: Number.isInteger(error?.code) ? error.code : null };
      recordTerminalExitCode(id, executionResult.exitCode);
      finish(id, "failed", { ok: false, error: "The CLI action did not complete successfully." });
    }).finally(async () => {
      clearTimeout(timer);
      await completeAdmission(decision, { started: true, result: executionResult });
      db.prepare("DELETE FROM execution_claims WHERE job_id=?").run(id);
      active.delete(id);
      schedule();
    });
    emit({ type: "running", id, status: "running" });
  }
  async function completeAdmission(decision, result) {
    try {
      if (!result.started && typeof decision?.release === "function") await decision.release();
      else await decision?.complete?.(result);
    } catch {
      reconciliationFailed = true;
      admissionReason = "CLI action admission reconciliation is unavailable.";
    }
  }
  function schedule(delay = 0) {
    if (closed || pumpTimer) return;
    pumpTimer = setTimeout(() => { pumpTimer = undefined; pumpTask = pump(); }, delay);
    pumpTimer.unref();
  }
  async function pump() {
    if (closed || pumping) return;
    pumping = true;
    try {
      while (!closed && !reconciliationFailed && active.size < maxConcurrency) {
        const row = db.prepare("SELECT id,invocation FROM jobs WHERE status='queued' ORDER BY id LIMIT 1").get();
        if (!row) break;
        let decision;
        try { decision = await admission({ id: row.id, running: active.size, ...JSON.parse(row.invocation) }); } catch { decision = { concurrency: 0 }; }
        if (closed) {
          await completeAdmission(decision, { started: false });
          break;
        }
        const concurrency = Number.isInteger(decision?.concurrency)
          ? Math.max(0, Math.min(maxConcurrency, decision.concurrency)) : 0;
        const diagnostic = [decision?.reason, decision?.message]
          .filter((value) => typeof value === "string" && value).join(": ");
        admissionReason = concurrency === 0
          ? (diagnostic ? sanitize(diagnostic.slice(0, 512)) : "CLI action admission is currently blocked.")
          : undefined;
        if (active.size >= concurrency) {
          await completeAdmission(decision, { started: false });
          schedule(admissionPollMs);
          break;
        }
        // Cancellation may have occurred during the asynchronous admission check.
        if (db.prepare("SELECT status FROM jobs WHERE id=?").get(row.id)?.status === "queued") {
          try { start(row, decision); } catch {
            await completeAdmission(decision, { started: false });
            throw new Error("CLI queue could not claim its next action.");
          }
        } else await completeAdmission(decision, { started: false });
      }
    } catch {
      admissionReason = "CLI queue execution is unavailable.";
      schedule(admissionPollMs);
    } finally { pumping = false; }
  }
  function enqueue(invocation, idempotencyKey, retryOf = null) {
    assertOpen();
    retain();
    const json = validateInvocation(invocation, limits.maxInputBytes);
    if (secrets.some((secret) => json.includes(secret))) throw new Error("Secret-bearing CLI input cannot be persisted.");
    const fingerprint = createHash("sha256").update(json).digest("hex");
    if (idempotencyKey !== undefined) {
      if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)
        || secretText.test(idempotencyKey)) throw new Error("Invalid queue idempotency key.");
      const existing = db.prepare("SELECT id,fingerprint FROM jobs WHERE idempotency_key=?").get(idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error("Queue idempotency key conflicts with another invocation.");
        return detail(existing.id);
      }
    }
    if (db.prepare("SELECT count(*) AS count FROM jobs").get().count >= limits.maxJobs) throw new Error("CLI queue capacity exceeded.");
    const inserted = db.prepare(`INSERT INTO jobs(invocation,idempotency_key,fingerprint,status,created_at,retry_of)
      VALUES(?,?,?,'queued',?,?)`).run(json, idempotencyKey ?? null, fingerprint, now(), retryOf);
    const id = Number(inserted.lastInsertRowid);
    emit({ type: "queued", id, status: "queued" });
    schedule();
    return detail(id);
  }
  const api = {
    enqueue, detail,
    list({ status, limit = 50, offset = 0 } = {}) {
      assertOpen();
      integer(limit, 1, limits.maxPageSize, "page size");
      integer(offset, 0, Number.MAX_SAFE_INTEGER, "offset");
      if (status !== undefined && !statuses.has(status)) throw new Error("Invalid queue status.");
      const commands = db.prepare(`SELECT id FROM jobs ${status ? "WHERE status=?" : ""} ORDER BY id DESC LIMIT ? OFFSET ?`)
        .all(...(status ? [status] : []), limit, offset).map(({ id }) => detail(id));
      const total = db.prepare(`SELECT count(*) AS count FROM jobs ${status ? "WHERE status=?" : ""}`)
        .get(...(status ? [status] : [])).count;
      return { commands, total, running: active.size, pausedReason: admissionReason ?? null, revision };
    },
    output(id, after = 0, limit = 100) {
      assertOpen();
      if (!detail(id)) return [];
      integer(after, 0, Number.MAX_SAFE_INTEGER, "cursor");
      integer(limit, 1, limits.maxPageSize, "page size");
      return db.prepare("SELECT seq AS sequence,stream,data FROM output WHERE job_id=? AND seq>? ORDER BY seq LIMIT ?")
        .all(Number(id), after, limit).map((row) => ({ ...row }));
    },
    cancel(id) {
      assertOpen();
      const row = detail(id);
      if (!row || terminal.has(row.status)) return row;
      active.get(Number(id))?.controller.abort();
      finish(Number(id), "canceled", { ok: false, error: "The CLI action was canceled." });
      schedule();
      return detail(id);
    },
    retry(id, idempotencyKey) {
      assertOpen();
      const row = detail(id);
      if (!row || !terminal.has(row.status)) throw new Error("Only terminal CLI actions can be retried.");
      return enqueue(row, idempotencyKey, row.id);
    },
    subscribe(listener) {
      assertOpen();
      if (typeof listener !== "function") throw new Error("Invalid queue listener.");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      clearTimeout(pumpTimer);
      for (const { controller } of active.values()) controller.abort();
      closePromise = Promise.allSettled([pumpTask, ...[...active.values()].map(({ promise }) => promise)]).then(() => {
        db.prepare(`UPDATE jobs SET status='failed',ok=0,error='CLI action interrupted by server shutdown.',
          completed_at=?,completion_week=? WHERE status='running'`).run(now(), monday(now()));
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        db.close();
        ownership.exec("ROLLBACK");
        ownership.close();
        listeners.clear();
      });
      return closePromise;
    },
  };
  schedule();
  return api;
}
