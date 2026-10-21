CREATE TABLE IF NOT EXISTS cao_operational_webhook_queues (
    namespace TEXT NOT NULL REFERENCES cao_operational_namespaces(namespace) ON DELETE CASCADE,
    name TEXT NOT NULL,
    config BYTEA NOT NULL,
    policy_revision BIGINT NOT NULL DEFAULT 0,
    policy_digest TEXT NOT NULL DEFAULT '',
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    tenant_cursor TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (namespace, name)
);

CREATE TABLE IF NOT EXISTS cao_operational_webhook_deliveries (
    namespace TEXT NOT NULL,
    queue TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    tenant TEXT NOT NULL,
    source TEXT NOT NULL,
    tenants TEXT[] NOT NULL DEFAULT '{}',
    sources TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL,
    retain_until TIMESTAMPTZ NOT NULL,
    storage_bytes BIGINT NOT NULL CHECK (storage_bytes > 0),
    PRIMARY KEY (namespace, queue, delivery_id),
    FOREIGN KEY (namespace, queue) REFERENCES cao_operational_webhook_queues(namespace, name) ON DELETE CASCADE
);
ALTER TABLE cao_operational_webhook_deliveries
    ADD COLUMN IF NOT EXISTS tenants TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS sources TEXT[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS cao_operational_webhook_jobs (
    namespace TEXT NOT NULL,
    queue TEXT NOT NULL,
    id TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    subscription_id TEXT NOT NULL,
    document BYTEA NOT NULL,
    tenant TEXT NOT NULL,
    source TEXT NOT NULL,
    destination TEXT NOT NULL,
    app TEXT NOT NULL,
    workflow TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('ready','claimed','dispatching','succeeded','expired','rejected','cancelled','failed','ambiguous')),
    version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
    fence BIGINT NOT NULL DEFAULT 0 CHECK (fence >= 0),
    owner TEXT NOT NULL DEFAULT '',
    attempt BIGINT NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    not_before TIMESTAMPTZ NOT NULL,
    lease_until TIMESTAMPTZ,
    terminal_at TIMESTAMPTZ,
    retain_until TIMESTAMPTZ NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    accepted_status INTEGER NOT NULL DEFAULT 0 CHECK (accepted_status IN (0,200,204)),
    workflow_run_id BIGINT NOT NULL DEFAULT 0 CHECK (workflow_run_id >= 0),
    storage_bytes BIGINT NOT NULL CHECK (storage_bytes > 0),
    PRIMARY KEY (namespace, queue, id),
    UNIQUE (namespace, queue, delivery_id, subscription_id),
    FOREIGN KEY (namespace, queue, delivery_id) REFERENCES cao_operational_webhook_deliveries(namespace, queue, delivery_id) ON DELETE CASCADE
);
ALTER TABLE cao_operational_webhook_jobs
    ADD COLUMN IF NOT EXISTS accepted_status INTEGER NOT NULL DEFAULT 0 CHECK (accepted_status IN (0,200,204)),
    ADD COLUMN IF NOT EXISTS workflow_run_id BIGINT NOT NULL DEFAULT 0 CHECK (workflow_run_id >= 0);
CREATE INDEX IF NOT EXISTS cao_operational_webhook_delivery_tenant
    ON cao_operational_webhook_deliveries(namespace, queue, tenant);
CREATE INDEX IF NOT EXISTS cao_operational_webhook_delivery_source
    ON cao_operational_webhook_deliveries(namespace, queue, source);
CREATE INDEX IF NOT EXISTS cao_operational_webhook_ready
    ON cao_operational_webhook_jobs(namespace, queue, tenant, created_at, id) WHERE state = 'ready';
CREATE INDEX IF NOT EXISTS cao_operational_webhook_active
    ON cao_operational_webhook_jobs(namespace, queue) WHERE state IN ('ready','claimed','dispatching');
CREATE INDEX IF NOT EXISTS cao_operational_webhook_leases
    ON cao_operational_webhook_jobs(namespace, queue, lease_until) WHERE state IN ('claimed','dispatching');
CREATE INDEX IF NOT EXISTS cao_operational_webhook_retention
    ON cao_operational_webhook_jobs(namespace, queue, retain_until) WHERE terminal_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS cao_operational_webhook_source
    ON cao_operational_webhook_jobs(namespace, queue, source);
CREATE INDEX IF NOT EXISTS cao_operational_webhook_destination
    ON cao_operational_webhook_jobs(namespace, queue, destination);
