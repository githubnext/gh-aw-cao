CREATE TABLE IF NOT EXISTS cao_operational_cli_queues (
    name TEXT PRIMARY KEY,
    config BLOB NOT NULL,
    owner TEXT NOT NULL DEFAULT '',
    fence INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER,
    recovery_blocked INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cao_operational_cli_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    queue TEXT NOT NULL REFERENCES cao_operational_cli_queues(name) ON DELETE CASCADE,
    invocation BLOB NOT NULL,
    idempotency_key TEXT,
    fingerprint BLOB NOT NULL,
    retry_of INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','canceled','timed-out')),
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    completion_week TEXT,
    deadline INTEGER,
    exit_code INTEGER,
    error TEXT NOT NULL DEFAULT '',
    execution_claimed INTEGER NOT NULL DEFAULT 0,
    output_bytes INTEGER NOT NULL DEFAULT 0,
    output_chunks INTEGER NOT NULL DEFAULT 0,
    output_truncated INTEGER NOT NULL DEFAULT 0,
    UNIQUE (queue, idempotency_key)
);
CREATE INDEX IF NOT EXISTS cao_operational_cli_fifo
    ON cao_operational_cli_commands(queue, status, id);
CREATE TABLE IF NOT EXISTS cao_operational_cli_executions (
    command_id INTEGER PRIMARY KEY REFERENCES cao_operational_cli_commands(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    runtime_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cao_operational_cli_output (
    command_id INTEGER NOT NULL REFERENCES cao_operational_cli_commands(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    stream TEXT NOT NULL CHECK (stream IN ('stdout','stderr')),
    data TEXT NOT NULL,
    PRIMARY KEY (command_id, sequence)
);

CREATE TABLE IF NOT EXISTS cao_operational_audit_events (
    sequence INTEGER PRIMARY KEY,
    occurred_at INTEGER NOT NULL,
    event TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('success','denied','failure')),
    actor TEXT NOT NULL DEFAULT '',
    record TEXT NOT NULL,
    prev_hash BLOB NOT NULL CHECK (length(prev_hash) = 32),
    hash BLOB NOT NULL CHECK (length(hash) = 32)
);
CREATE INDEX IF NOT EXISTS cao_operational_audit_time
    ON cao_operational_audit_events(occurred_at);
CREATE INDEX IF NOT EXISTS cao_operational_audit_actor
    ON cao_operational_audit_events(actor, sequence);
-- Retention maintenance inserts the marker row inside its transaction; the
-- delete trigger rejects every other delete.
CREATE TABLE IF NOT EXISTS cao_operational_audit_retention (
    active INTEGER PRIMARY KEY CHECK (active = 1)
);
CREATE TRIGGER IF NOT EXISTS cao_operational_audit_no_update
BEFORE UPDATE ON cao_operational_audit_events
BEGIN
    SELECT RAISE(ABORT, 'cao_operational_audit_events is append-only');
END;
CREATE TRIGGER IF NOT EXISTS cao_operational_audit_no_delete
BEFORE DELETE ON cao_operational_audit_events
WHEN NOT EXISTS (SELECT 1 FROM cao_operational_audit_retention)
BEGIN
    SELECT RAISE(ABORT, 'cao_operational_audit_events is append-only');
END;
