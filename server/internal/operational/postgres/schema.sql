CREATE TABLE IF NOT EXISTS cao_operational_namespaces (
    namespace TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
    config BYTEA NOT NULL,
    protected_bytes BIGINT NOT NULL DEFAULT 0 CHECK (protected_bytes >= 0),
    protected_entries BIGINT NOT NULL DEFAULT 0 CHECK (protected_entries >= 0)
);

CREATE TABLE IF NOT EXISTS cao_operational_records (
    namespace TEXT NOT NULL REFERENCES cao_operational_namespaces(namespace) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    field TEXT NOT NULL DEFAULT '',
    value BYTEA NOT NULL,
    expires_at TIMESTAMPTZ,
    position BIGINT GENERATED ALWAYS AS IDENTITY,
    PRIMARY KEY (namespace, kind, name, field)
);
CREATE INDEX IF NOT EXISTS cao_operational_expiry
    ON cao_operational_records(namespace, expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS cao_operational_order
    ON cao_operational_records(namespace, kind, name, position);

CREATE TABLE IF NOT EXISTS cao_operational_cache (
    namespace TEXT NOT NULL REFERENCES cao_operational_namespaces(namespace) ON DELETE CASCADE,
    key TEXT NOT NULL,
    query BOOLEAN NOT NULL,
    value BYTEA NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    position BIGINT GENERATED ALWAYS AS IDENTITY,
    PRIMARY KEY (namespace, key)
);
CREATE INDEX IF NOT EXISTS cao_operational_cache_expiry
    ON cao_operational_cache(namespace, expires_at);

CREATE TABLE IF NOT EXISTS cao_operational_cli_queues (
    namespace TEXT NOT NULL REFERENCES cao_operational_namespaces(namespace) ON DELETE CASCADE,
    name TEXT NOT NULL,
    config BYTEA NOT NULL,
    owner TEXT NOT NULL DEFAULT '',
    fence BIGINT NOT NULL DEFAULT 0,
    lease_until TIMESTAMPTZ,
    recovery_blocked BOOLEAN NOT NULL DEFAULT FALSE,
    revision BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (namespace, name)
);

CREATE TABLE IF NOT EXISTS cao_operational_cli_commands (
    namespace TEXT NOT NULL,
    queue TEXT NOT NULL,
    id BIGINT GENERATED ALWAYS AS IDENTITY,
    invocation BYTEA NOT NULL,
    idempotency_key TEXT,
    fingerprint BYTEA NOT NULL,
    retry_of BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','canceled','timed-out')),
    created_at TIMESTAMPTZ NOT NULL,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    completion_week DATE,
    deadline TIMESTAMPTZ,
    exit_code INTEGER,
    error TEXT NOT NULL DEFAULT '',
    execution_claimed BOOLEAN NOT NULL DEFAULT FALSE,
    output_bytes INTEGER NOT NULL DEFAULT 0,
    output_chunks INTEGER NOT NULL DEFAULT 0,
    output_truncated BOOLEAN NOT NULL DEFAULT FALSE,
    storage_bytes BIGINT NOT NULL,
    PRIMARY KEY (namespace, queue, id),
    UNIQUE (namespace, queue, idempotency_key),
    FOREIGN KEY (namespace, queue) REFERENCES cao_operational_cli_queues(namespace, name) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS cao_operational_cli_fifo
    ON cao_operational_cli_commands(namespace, queue, status, id);
CREATE INDEX IF NOT EXISTS cao_operational_cli_retention
    ON cao_operational_cli_commands(namespace, completion_week)
    WHERE NOT execution_claimed AND status NOT IN ('queued','running');

CREATE TABLE IF NOT EXISTS cao_operational_cli_executions (
    namespace TEXT NOT NULL,
    queue TEXT NOT NULL,
    command_id BIGINT NOT NULL,
    name TEXT NOT NULL,
    runtime_id TEXT NOT NULL,
    PRIMARY KEY (namespace, queue, command_id),
    FOREIGN KEY (namespace, queue, command_id) REFERENCES cao_operational_cli_commands(namespace, queue, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cao_operational_cli_output (
    namespace TEXT NOT NULL,
    queue TEXT NOT NULL,
    command_id BIGINT NOT NULL,
    sequence INTEGER NOT NULL,
    stream TEXT NOT NULL CHECK (stream IN ('stdout','stderr')),
    data TEXT NOT NULL,
    PRIMARY KEY (namespace, queue, command_id, sequence),
    FOREIGN KEY (namespace, queue, command_id) REFERENCES cao_operational_cli_commands(namespace, queue, id) ON DELETE CASCADE
);

-- Security audit trail. Rows are append-only: a trigger rejects UPDATE and
-- permits DELETE only for retention or namespace removal. Each row carries the
-- exact canonical JSON that was hashed, and hash = sha256(prev_hash || record),
-- so edits, reordering, and gaps are detectable by VerifyAudit.
CREATE TABLE IF NOT EXISTS cao_operational_audit_events (
    namespace TEXT NOT NULL REFERENCES cao_operational_namespaces(namespace) ON DELETE CASCADE,
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    occurred_at TIMESTAMPTZ NOT NULL,
    event TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('success','denied','failure')),
    actor TEXT NOT NULL DEFAULT '',
    record TEXT NOT NULL,
    prev_hash BYTEA NOT NULL CHECK (octet_length(prev_hash) = 32),
    hash BYTEA NOT NULL CHECK (octet_length(hash) = 32),
    PRIMARY KEY (namespace, sequence)
);
CREATE INDEX IF NOT EXISTS cao_operational_audit_time
    ON cao_operational_audit_events(namespace, occurred_at);
CREATE INDEX IF NOT EXISTS cao_operational_audit_actor
    ON cao_operational_audit_events(namespace, actor, sequence);
CREATE INDEX IF NOT EXISTS cao_operational_audit_token_lifecycle
    ON cao_operational_audit_events(namespace, event, ((record::jsonb)->'attributes'->>'hashed_token'))
    WHERE event IN ('token.revoked','token.expired','token.revoke_failed');

CREATE OR REPLACE FUNCTION cao_operational_audit_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND (pg_trigger_depth() > 1 OR current_setting('cao.audit_retention', true) = 'on') THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'cao_operational_audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;
DROP TRIGGER IF EXISTS cao_operational_audit_append_only ON cao_operational_audit_events;
CREATE TRIGGER cao_operational_audit_append_only
    BEFORE UPDATE OR DELETE ON cao_operational_audit_events
    FOR EACH ROW EXECUTE FUNCTION cao_operational_audit_append_only();
