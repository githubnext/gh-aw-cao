-- Run using psql -X -v ON_ERROR_STOP=1 as the non-login schema owner, after
-- database bootstrap. Supply schema, runtime, retention and reader variables.
-- Roles must be fresh non-owner roles without inherited privileged membership.
BEGIN;
REVOKE CREATE ON SCHEMA :"schema" FROM PUBLIC, :"runtime", :"retention", :"reader";
GRANT USAGE ON SCHEMA :"schema" TO :"runtime", :"retention", :"reader";

REVOKE ALL ON TABLE
    :"schema".cao_operational_namespaces,
    :"schema".cao_operational_records,
    :"schema".cao_operational_cache,
    :"schema".cao_operational_cli_queues,
    :"schema".cao_operational_cli_commands,
    :"schema".cao_operational_cli_executions,
    :"schema".cao_operational_cli_output,
    :"schema".cao_operational_webhook_queues,
    :"schema".cao_operational_webhook_deliveries,
    :"schema".cao_operational_webhook_jobs,
    :"schema".cao_operational_audit_events
    FROM PUBLIC, :"runtime", :"retention", :"reader";
REVOKE ALL (namespace, version, config, protected_bytes, protected_entries)
    ON :"schema".cao_operational_namespaces FROM :"runtime", :"retention", :"reader";
GRANT SELECT ON :"schema".cao_operational_namespaces TO :"runtime", :"retention", :"reader";
-- UPDATE of any column permits FOR UPDATE; identity/config remain immutable.
GRANT UPDATE (protected_bytes, protected_entries)
    ON :"schema".cao_operational_namespaces TO :"runtime";
GRANT SELECT, INSERT, UPDATE, DELETE ON
    :"schema".cao_operational_records,
    :"schema".cao_operational_cache,
    :"schema".cao_operational_cli_queues,
    :"schema".cao_operational_cli_commands,
    :"schema".cao_operational_cli_executions,
    :"schema".cao_operational_cli_output,
    :"schema".cao_operational_webhook_queues,
    :"schema".cao_operational_webhook_deliveries,
    :"schema".cao_operational_webhook_jobs TO :"runtime";
GRANT USAGE ON SEQUENCE
    :"schema".cao_operational_records_position_seq,
    :"schema".cao_operational_cache_position_seq,
    :"schema".cao_operational_cli_commands_id_seq TO :"runtime";
GRANT SELECT, INSERT ON :"schema".cao_operational_audit_events TO :"runtime";
GRANT SELECT ON :"schema".cao_operational_audit_events TO :"reader";
REVOKE ALL ON FUNCTION :"schema".cao_operational_retain_audit(TEXT)
    FROM PUBLIC, :"runtime", :"reader", :"retention";
GRANT EXECUTE ON FUNCTION :"schema".cao_operational_retain_audit(TEXT) TO :"retention";
COMMIT;
