CREATE TABLE cao_dashboard_export_manifest_v1 (
  contract VARCHAR(64) NOT NULL,
  schema_version INTEGER NOT NULL,
  source VARCHAR(255) NOT NULL,
  generation VARCHAR(255) NOT NULL,
  exported_at VARCHAR(32) NOT NULL,
  CHECK (contract = 'gh-aw-cao.dashboard-sql-export'),
  CHECK (schema_version = 1)
);

CREATE TABLE cao_dashboard_export_rows_v1 (
  entity_kind VARCHAR(16) NOT NULL,
  source_id VARCHAR(255) NOT NULL,
  observed_at VARCHAR(32) NOT NULL,
  github_repository_id VARCHAR(32),
  repository_owner VARCHAR(255),
  repository_name VARCHAR(255),
  repository_visibility VARCHAR(32),
  github_workflow_id VARCHAR(32),
  workflow_name VARCHAR(255),
  workflow_path VARCHAR(1024),
  workflow_state VARCHAR(32),
  github_run_id VARCHAR(32),
  run_attempt INTEGER,
  run_event VARCHAR(64),
  run_status VARCHAR(32),
  run_conclusion VARCHAR(32),
  run_created_at VARCHAR(32),
  run_started_at VARCHAR(32),
  run_completed_at VARCHAR(32),
  run_head_sha VARCHAR(64),
  run_head_branch VARCHAR(255),
  github_job_id VARCHAR(32),
  job_name VARCHAR(255),
  job_status VARCHAR(32),
  job_conclusion VARCHAR(32),
  job_started_at VARCHAR(32),
  job_completed_at VARCHAR(32),
  session_source_id VARCHAR(255),
  session_kind VARCHAR(64),
  session_status VARCHAR(32),
  session_started_at VARCHAR(32),
  session_completed_at VARCHAR(32),
  event_timestamp VARCHAR(32),
  event_source VARCHAR(64),
  event_type VARCHAR(128),
  event_summary VARCHAR(1024),
  correlation_id VARCHAR(255),
  payload_ref VARCHAR(1024),
  source_sequence INTEGER,
  PRIMARY KEY (entity_kind, source_id),
  CHECK (entity_kind IN ('repository', 'workflow', 'run', 'job', 'session', 'event')),
  CHECK (source_sequence IS NULL OR source_sequence >= 0)
);

INSERT INTO cao_dashboard_export_manifest_v1
  (contract, schema_version, source, generation, exported_at)
VALUES
  ('gh-aw-cao.dashboard-sql-export', 1, 'enterprise-warehouse', 'warehouse-2026-09-09-05', '2026-09-09T05:00:00Z');

INSERT INTO cao_dashboard_export_rows_v1
  (entity_kind, source_id, observed_at, github_repository_id, repository_owner, repository_name, repository_visibility)
VALUES
  ('repository', 'repository-101', '2026-09-09T05:00:00Z', '101', 'githubnext', 'gh-aw-cao', 'public');

INSERT INTO cao_dashboard_export_rows_v1
  (entity_kind, source_id, observed_at, github_repository_id, github_workflow_id, workflow_name, workflow_path, workflow_state)
VALUES
  ('workflow', 'workflow-202', '2026-09-09T05:00:00Z', '101', '202', 'Dashboard', '.github/workflows/dashboard.md', 'active');

INSERT INTO cao_dashboard_export_rows_v1
  (entity_kind, source_id, observed_at, github_repository_id, github_workflow_id, github_run_id, run_attempt, run_event, run_status, run_conclusion)
VALUES
  ('run', 'run-303-1', '2026-09-09T05:00:00Z', '101', '202', '303', 1, 'workflow_dispatch', 'completed', 'success');

INSERT INTO cao_dashboard_export_rows_v1
  (entity_kind, source_id, observed_at, github_run_id, run_attempt, github_job_id, job_name, job_status, job_conclusion)
VALUES
  ('job', 'job-404', '2026-09-09T05:00:00Z', '303', 1, '404', 'agent', 'completed', 'success');

INSERT INTO cao_dashboard_export_rows_v1
  (entity_kind, source_id, observed_at, github_run_id, run_attempt, github_job_id, session_kind, session_status)
VALUES
  ('session', 'session-505', '2026-09-09T05:00:00Z', '303', 1, '404', 'agent', 'completed');

INSERT INTO cao_dashboard_export_rows_v1
  (entity_kind, source_id, observed_at, session_source_id, event_timestamp, event_source, event_type, source_sequence)
VALUES
  ('event', 'event-2', '2026-09-09T05:00:00Z', 'session-505', '2026-09-09T04:00:02Z', 'firewall', 'firewall.request.allowed', 2),
  ('event', 'event-1', '2026-09-09T05:00:00Z', 'session-505', '2026-09-09T04:00:01Z', 'agent', 'message.user', 1);