import { DatabaseSync } from 'node:sqlite';

const METADATA_SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS __idb_databases (
    name TEXT PRIMARY KEY,
    version INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS __idb_stores (
    database_name TEXT NOT NULL,
    name TEXT NOT NULL,
    key_path TEXT NOT NULL,
    PRIMARY KEY (database_name, name),
    FOREIGN KEY (database_name) REFERENCES __idb_databases(name) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS __idb_indexes (
    database_name TEXT NOT NULL,
    store_name TEXT NOT NULL,
    name TEXT NOT NULL,
    key_path TEXT NOT NULL,
    PRIMARY KEY (database_name, store_name, name),
    FOREIGN KEY (database_name, store_name)
      REFERENCES __idb_stores(database_name, name) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS __idb_records (
    database_name TEXT NOT NULL,
    store_name TEXT NOT NULL,
    record_key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (database_name, store_name, record_key),
    FOREIGN KEY (database_name, store_name)
      REFERENCES __idb_stores(database_name, name) ON DELETE CASCADE
  );
`;

function createConnection(filename) {
  const connection = new DatabaseSync(filename);
  connection.exec('PRAGMA busy_timeout = 5000;');
  connection.exec(METADATA_SCHEMA);
  return connection;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function encodeKey(value) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('IndexedDB keys must be JSON-serializable');
  return encoded;
}

function valueAtKeyPath(value, keyPath) {
  if (Array.isArray(keyPath)) return keyPath.map((path) => valueAtKeyPath(value, path));
  return String(keyPath).split('.').reduce((current, part) => (
    current && typeof current === 'object'
      ? /** @type {Record<string, unknown>} */ (current)[part]
      : undefined
  ), value);
}

function keyRank(value) {
  if (typeof value === 'number') return 1;
  if (value instanceof Date) return 2;
  if (typeof value === 'string') return 3;
  if (Array.isArray(value)) return 4;
  return 5;
}

function compareKeys(left, right) {
  if (Object.is(left, right)) return 0;
  const rankDifference = keyRank(left) - keyRank(right);
  if (rankDifference !== 0) return rankDifference;
  if (Array.isArray(left) && Array.isArray(right)) {
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      const difference = compareKeys(left[index], right[index]);
      if (difference !== 0) return difference;
    }
    return left.length - right.length;
  }
  return left < right ? -1 : 1;
}

function matchesQuery(key, query) {
  if (query === undefined || query === null) return true;
  if (query instanceof SqliteIDBKeyRange) {
    const lower = compareKeys(key, query.lower);
    const upper = compareKeys(key, query.upper);
    return (query.lowerOpen ? lower > 0 : lower >= 0)
      && (query.upperOpen ? upper < 0 : upper <= 0);
  }
  return compareKeys(key, query) === 0;
}

function emit(target, name, event = { target }) {
  const listener = target[name];
  if (typeof listener === 'function') listener(event);
}

class SqliteIDBRequest {
  constructor() {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
  }

  succeed(result) {
    this.result = result;
    queueMicrotask(() => emit(this, 'onsuccess'));
  }

  fail(error) {
    this.error = error instanceof Error ? error : new Error(String(error));
    queueMicrotask(() => emit(this, 'onerror'));
  }
}

class SqliteIDBOpenRequest extends SqliteIDBRequest {
  constructor() {
    super();
    this.onblocked = null;
    this.onupgradeneeded = null;
  }
}

class SqliteDOMStringList {
  constructor(values) {
    this.values = [...values].sort();
  }

  contains(value) {
    return this.values.includes(String(value));
  }

  item(index) {
    return this.values[index] ?? null;
  }

  get length() {
    return this.values.length;
  }

  [Symbol.iterator]() {
    return this.values[Symbol.iterator]();
  }
}

class SqliteIDBIndex {
  constructor(transaction, storeName, name, keyPath) {
    this.transaction = transaction;
    this.storeName = storeName;
    this.name = name;
    this.keyPath = keyPath;
  }

  getAll(query) {
    return this.transaction.runRequest(() => {
      const store = this.transaction.database.records(this.storeName);
      return store
        .map(({ key, value }) => ({
          indexKey: valueAtKeyPath(value, this.keyPath),
          primaryKey: key,
          value
        }))
        .filter(({ indexKey }) => indexKey !== undefined && matchesQuery(indexKey, query))
        .sort((left, right) => (
          compareKeys(left.indexKey, right.indexKey)
          || compareKeys(left.primaryKey, right.primaryKey)
        ))
        .map(({ value }) => clone(value));
    });
  }
}

class SqliteIDBObjectStore {
  constructor(database, name, keyPath, transaction = null) {
    this.database = database;
    this.name = name;
    this.keyPath = keyPath;
    this.transaction = transaction;
  }

  createIndex(name, keyPath) {
    this.database.connection.prepare(`
      INSERT INTO __idb_indexes (database_name, store_name, name, key_path)
      VALUES (?, ?, ?, ?)
    `).run(this.database.name, this.name, String(name), JSON.stringify(keyPath));
    return new SqliteIDBIndex(
      this.transaction,
      this.name,
      String(name),
      keyPath
    );
  }

  index(name) {
    if (!this.transaction) throw new Error('Object store is not associated with a transaction');
    const row = this.database.connection.prepare(`
      SELECT key_path
      FROM __idb_indexes
      WHERE database_name = ? AND store_name = ? AND name = ?
    `).get(this.database.name, this.name, String(name));
    if (!row) throw new Error(`IndexedDB index does not exist: ${this.name}.${String(name)}`);
    return new SqliteIDBIndex(
      this.transaction,
      this.name,
      String(name),
      JSON.parse(String(row.key_path))
    );
  }

  put(value) {
    return this.requireTransaction().runRequest(() => {
      const record = clone(value);
      const key = valueAtKeyPath(record, this.keyPath);
      if (key === undefined) throw new TypeError(`Record is missing key path ${String(this.keyPath)}`);
      this.database.connection.prepare(`
        INSERT INTO __idb_records (database_name, store_name, record_key, value)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(database_name, store_name, record_key)
        DO UPDATE SET value = excluded.value
      `).run(this.database.name, this.name, encodeKey(key), JSON.stringify(record));
      return clone(key);
    });
  }

  get(key) {
    return this.requireTransaction().runRequest(() => {
      const row = this.database.connection.prepare(`
        SELECT value
        FROM __idb_records
        WHERE database_name = ? AND store_name = ? AND record_key = ?
      `).get(this.database.name, this.name, encodeKey(key));
      return row ? JSON.parse(String(row.value)) : undefined;
    });
  }

  getAll(query) {
    return this.requireTransaction().runRequest(() => this.database.records(this.name)
      .filter((record) => matchesQuery(record.key, query))
      .sort((left, right) => compareKeys(left.key, right.key))
      .map((record) => clone(record.value)));
  }

  getAllKeys(query) {
    return this.requireTransaction().runRequest(() => this.database.records(this.name)
      .map((record) => record.key)
      .filter((key) => matchesQuery(key, query))
      .sort(compareKeys)
      .map(clone));
  }

  delete(key) {
    return this.requireTransaction().runRequest(() => {
      this.database.connection.prepare(`
        DELETE FROM __idb_records
        WHERE database_name = ? AND store_name = ? AND record_key = ?
      `).run(this.database.name, this.name, encodeKey(key));
      return undefined;
    });
  }

  requireTransaction() {
    if (!this.transaction) throw new Error('Object store is not associated with a transaction');
    return this.transaction;
  }
}

class SqliteIDBTransaction {
  constructor(database, storeNames, mode) {
    this.database = database;
    this.storeNames = new Set(storeNames);
    this.mode = mode;
    this.error = null;
    this.onabort = null;
    this.oncomplete = null;
    this.onerror = null;
    this.active = true;
    if (mode === 'readwrite') database.connection.exec('BEGIN IMMEDIATE;');
    database.activeTransactions.add(this);
    setImmediate(() => this.finish());
  }

  objectStore(name) {
    const storeName = String(name);
    if (!this.storeNames.has(storeName)) {
      throw new Error(`Object store is outside this transaction: ${storeName}`);
    }
    return this.database.objectStore(storeName, this);
  }

  runRequest(operation) {
    const request = new SqliteIDBRequest();
    if (!this.active) {
      request.fail(new Error('IndexedDB transaction is inactive'));
      return request;
    }
    try {
      request.succeed(operation());
    } catch (error) {
      this.error = error instanceof Error ? error : new Error(String(error));
      request.fail(this.error);
    }
    return request;
  }

  finish() {
    if (!this.active) return;
    this.active = false;
    try {
      if (this.mode === 'readwrite') {
        this.database.connection.exec(this.error ? 'ROLLBACK;' : 'COMMIT;');
      }
    } catch (error) {
      this.error = error instanceof Error ? error : new Error(String(error));
    }
    if (this.error) {
      emit(this, 'onerror');
      emit(this, 'onabort');
    } else {
      emit(this, 'oncomplete');
    }
    this.database.releaseTransaction(this);
  }
}

class SqliteIDBDatabase {
  constructor(connection, name, version) {
    this.connection = connection;
    this.name = name;
    this.version = version;
    this.activeTransactions = new Set();
    this.closeRequested = false;
  }

  get objectStoreNames() {
    const rows = this.connection.prepare(`
      SELECT name
      FROM __idb_stores
      WHERE database_name = ?
      ORDER BY name
    `).all(this.name);
    return new SqliteDOMStringList(rows.map((row) => String(row.name)));
  }

  createObjectStore(name, options = {}) {
    const storeName = String(name);
    const keyPath = options.keyPath;
    if (typeof keyPath !== 'string' && !Array.isArray(keyPath)) {
      throw new TypeError('SQLite IndexedDB stores require a keyPath');
    }
    this.connection.prepare(`
      INSERT INTO __idb_stores (database_name, name, key_path)
      VALUES (?, ?, ?)
    `).run(this.name, storeName, JSON.stringify(keyPath));
    return new SqliteIDBObjectStore(this, storeName, keyPath);
  }

  deleteObjectStore(name) {
    this.connection.prepare(`
      DELETE FROM __idb_stores
      WHERE database_name = ? AND name = ?
    `).run(this.name, String(name));
  }

  transaction(storeNames, mode = 'readonly') {
    const names = Array.isArray(storeNames) ? storeNames.map(String) : [String(storeNames)];
    for (const name of names) this.objectStore(name);
    if (mode !== 'readonly' && mode !== 'readwrite') {
      throw new TypeError(`Unsupported IndexedDB transaction mode: ${String(mode)}`);
    }
    return new SqliteIDBTransaction(this, names, mode);
  }

  objectStore(name, transaction = null) {
    const row = this.connection.prepare(`
      SELECT key_path
      FROM __idb_stores
      WHERE database_name = ? AND name = ?
    `).get(this.name, String(name));
    if (!row) throw new Error(`IndexedDB object store does not exist: ${String(name)}`);
    return new SqliteIDBObjectStore(
      this,
      String(name),
      JSON.parse(String(row.key_path)),
      transaction
    );
  }

  records(storeName) {
    return this.connection.prepare(`
      SELECT record_key, value
      FROM __idb_records
      WHERE database_name = ? AND store_name = ?
    `).all(this.name, storeName).map((row) => ({
      key: JSON.parse(String(row.record_key)),
      value: JSON.parse(String(row.value))
    }));
  }

  close() {
    this.closeRequested = true;
    this.closeConnectionIfIdle();
  }

  releaseTransaction(transaction) {
    this.activeTransactions.delete(transaction);
    this.closeConnectionIfIdle();
  }

  closeConnectionIfIdle() {
    if (this.closeRequested && this.activeTransactions.size === 0) this.connection.close();
  }
}

export class SqliteIDBKeyRange {
  constructor(lower, upper, lowerOpen, upperOpen) {
    this.lower = lower;
    this.upper = upper;
    this.lowerOpen = lowerOpen;
    this.upperOpen = upperOpen;
  }

  static bound(lower, upper, lowerOpen = false, upperOpen = false) {
    if (compareKeys(lower, upper) > 0) throw new TypeError('Lower bound must not exceed upper bound');
    return new SqliteIDBKeyRange(lower, upper, lowerOpen, upperOpen);
  }
}

export class SqliteIndexedDBFactory {
  constructor(filename) {
    if (typeof filename !== 'string' || !filename.trim()) {
      throw new TypeError('SQLite database filename is required');
    }
    this.filename = filename;
  }

  open(name, version) {
    const request = new SqliteIDBOpenRequest();
    queueMicrotask(() => {
      let connection;
      try {
        connection = createConnection(this.filename);
        const databaseName = String(name);
        const row = connection.prepare(`
          SELECT version FROM __idb_databases WHERE name = ?
        `).get(databaseName);
        const oldVersion = row ? Number(row.version) : 0;
        const requestedVersion = version === undefined ? (oldVersion || 1) : Number(version);
        if (!Number.isInteger(requestedVersion) || requestedVersion < 1) {
          throw new TypeError('IndexedDB version must be a positive integer');
        }
        if (requestedVersion < oldVersion) {
          const error = new Error(`Requested version ${requestedVersion} is older than ${oldVersion}`);
          error.name = 'VersionError';
          throw error;
        }

        const database = new SqliteIDBDatabase(connection, databaseName, requestedVersion);
        if (oldVersion === 0) {
          connection.prepare(`
            INSERT INTO __idb_databases (name, version) VALUES (?, 0)
          `).run(databaseName);
        }
        if (requestedVersion > oldVersion) {
          connection.exec('BEGIN IMMEDIATE;');
          try {
            request.result = database;
            emit(request, 'onupgradeneeded', {
              target: request,
              oldVersion,
              newVersion: requestedVersion
            });
            connection.prepare(`
              UPDATE __idb_databases SET version = ? WHERE name = ?
            `).run(requestedVersion, databaseName);
            connection.exec('COMMIT;');
          } catch (error) {
            connection.exec('ROLLBACK;');
            throw error;
          }
        }
        request.succeed(database);
      } catch (error) {
        if (connection) connection.close();
        request.fail(error);
      }
    });
    return request;
  }

  deleteDatabase(name) {
    const request = new SqliteIDBOpenRequest();
    queueMicrotask(() => {
      let connection;
      try {
        connection = createConnection(this.filename);
        connection.prepare('DELETE FROM __idb_databases WHERE name = ?').run(String(name));
        connection.close();
        request.succeed(undefined);
      } catch (error) {
        if (connection) connection.close();
        request.fail(error);
      }
    });
    return request;
  }

  async databases() {
    const connection = createConnection(this.filename);
    try {
      return connection.prepare(`
        SELECT name, version FROM __idb_databases ORDER BY name
      `).all().map((row) => ({ name: String(row.name), version: Number(row.version) }));
    } finally {
      connection.close();
    }
  }
}

export function createSqliteIndexedDB(filename) {
  return new SqliteIndexedDBFactory(filename);
}

export function installSqliteIndexedDB(filename) {
  const indexedDB = createSqliteIndexedDB(filename);
  globalThis.indexedDB = indexedDB;
  globalThis.IDBKeyRange = SqliteIDBKeyRange;
  return indexedDB;
}
