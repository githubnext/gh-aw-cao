-- Apply separately after canonical bootstrap. Never grant ALL TABLES or
-- default table privileges: canonical and operational storage may share a schema.
BEGIN;
REVOKE CREATE ON SCHEMA :"schema" FROM PUBLIC, :"runtime";
GRANT USAGE ON SCHEMA :"schema" TO :"runtime";
REVOKE ALL ON :"schema".cao_contract, :"schema".cao_state FROM PUBLIC, :"runtime";
GRANT SELECT ON :"schema".cao_contract TO :"runtime";
GRANT SELECT, INSERT, UPDATE ON :"schema".cao_state TO :"runtime";
REVOKE ALL ON FUNCTION :"schema".cao_analyze_native() FROM PUBLIC, :"runtime";
GRANT EXECUTE ON FUNCTION :"schema".cao_analyze_native() TO :"runtime";
GRANT SELECT, INSERT, UPDATE, DELETE ON
    :"schema".cao_github_resources, :"schema".cao_quality, :"schema".cao_repository_lifecycle,
    :"schema".repositories, :"schema".campaigns, :"schema".workflows,
    :"schema".runs, :"schema".audits, :"schema".domains, :"schema".evals,
    :"schema".experiments, :"schema".eval_observations, :"schema".experiment_assignments,
    :"schema".friction, :"schema".graders, :"schema".grader_observations,
    :"schema".issues, :"schema".operational_values, :"schema".outcome_performance,
    :"schema".security_findings, :"schema".skills, :"schema".tools,
    :"schema".transactions, :"schema".work_items TO :"runtime";
-- The database administrator must separately grant TEMPORARY on this database
-- to runtime for ingestion staging. A schema owner cannot grant database rights.
COMMIT;
