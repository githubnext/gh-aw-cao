CREATE TABLE IF NOT EXISTS __idb_databases (
  name TEXT PRIMARY KEY, version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS __idb_stores (
  database_name TEXT NOT NULL, name TEXT NOT NULL, key_path TEXT NOT NULL,
  PRIMARY KEY (database_name, name)
);
CREATE TABLE IF NOT EXISTS __idb_indexes (
  database_name TEXT NOT NULL, store_name TEXT NOT NULL, name TEXT NOT NULL, key_path TEXT NOT NULL,
  PRIMARY KEY (database_name, store_name, name)
);
CREATE TABLE IF NOT EXISTS __idb_records (
  database_name TEXT NOT NULL, store_name TEXT NOT NULL, record_key TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (database_name, store_name, record_key)
);
CREATE TABLE IF NOT EXISTS __cao_overlay_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1), snapshot_revision TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS __cao_overlay_deleted (
  database_name TEXT NOT NULL, store_name TEXT NOT NULL, record_key TEXT NOT NULL,
  PRIMARY KEY (database_name, store_name, record_key)
);
INSERT OR IGNORE INTO main.__idb_databases SELECT * FROM snapshot.__idb_databases;
INSERT OR IGNORE INTO main.__idb_stores SELECT * FROM snapshot.__idb_stores;
INSERT OR IGNORE INTO main.__idb_indexes SELECT * FROM snapshot.__idb_indexes;

CREATE TEMP VIEW __idb_records AS
SELECT database_name, store_name, record_key, value FROM main.__idb_records
UNION ALL
SELECT base.database_name, base.store_name, base.record_key, base.value
FROM snapshot.__idb_records AS base
WHERE NOT EXISTS (
  SELECT 1 FROM main.__idb_records AS local
  WHERE local.database_name = base.database_name AND local.store_name = base.store_name
    AND local.record_key = base.record_key
) AND NOT EXISTS (
  SELECT 1 FROM main.__cao_overlay_deleted AS deleted
  WHERE deleted.database_name = base.database_name AND deleted.store_name = base.store_name
    AND deleted.record_key = base.record_key
);
