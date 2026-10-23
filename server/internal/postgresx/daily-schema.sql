-- Generated from server/spec/daily-counts.tsp. Do not edit.

CREATE TABLE IF NOT EXISTS cao_daily_contract (digest TEXT PRIMARY KEY);

CREATE TABLE IF NOT EXISTS daily_run_counts (
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  day TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  repository TEXT NOT NULL,
  workflow_path TEXT NOT NULL,
  total BIGINT NOT NULL,
  successful BIGINT NOT NULL,
  failed BIGINT NOT NULL,
  approval BIGINT NOT NULL,
  pending BIGINT NOT NULL,
  other BIGINT NOT NULL,
  PRIMARY KEY (namespace, id),
  UNIQUE (namespace, day, repository_id, workflow_id),
  CHECK (total >= 0 AND successful >= 0 AND failed >= 0 AND approval >= 0 AND pending >= 0 AND other >= 0),
  CHECK (total = successful + failed + approval + pending + other)
);

CREATE TABLE IF NOT EXISTS run_count_contributions (
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  owner TEXT,
  repository TEXT,
  workflow_path TEXT,
  started_at TIMESTAMPTZ,
  attempt BIGINT,
  status TEXT,
  conclusion TEXT,
  updated_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (namespace, id)
);

CREATE TABLE IF NOT EXISTS daily_run_count_state (
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  initialized_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (namespace, id)
);
