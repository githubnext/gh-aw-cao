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
