import { createReadStream } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { processDataRequest } from "./site/src/data-worker.js";
import {
  finalizeNormalizedJsonlIngestion,
  ingestDashboardSources,
  ingestNormalizedJsonl,
} from "./site/src/data/ingest/coordinator.js";
import { loadDatabaseQuerySources } from "./site/src/data/queries/database.js";
import {
  continuationRevision,
  paginateDashboardSources,
  resolveDashboardQuerySources,
} from "./site/src/data/queries/declarative.js";
import { installSqliteIndexedDB } from "./site/src/data/storage/sqlite-indexeddb.js";

const indexedDB = installSqliteIndexedDB(workerData.databasePath);
const sourceDatabase = new DatabaseSync(workerData.databasePath);
sourceDatabase.exec("CREATE TABLE preview_sources (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
const evaluatedAt = new Date().toISOString();
const status = { revision: 1, healthRevision: 1, evaluatedAt };
let logicalSources = {};

async function initialize() {
  const sources = JSON.parse(workerData.sourcesContent ?? "{}");
  await ingestDashboardSources(indexedDB, sources);
  const insert = sourceDatabase.prepare("INSERT INTO preview_sources (name, value) VALUES (?, ?)");
  for (const [name, source] of Object.entries(sources)) insert.run(name, JSON.stringify(source));
  logicalSources = Object.fromEntries(Object.entries(sources).map(([name, source]) => [
    name, { source: name, rows: [], metadata: source.metadata ?? {} },
  ]));
  for (const shard of workerData.shards) {
    await ingestNormalizedJsonl(indexedDB, createReadStream(shard.path), {
      expectedPhase: shard.phase,
      payloadIdentity: shard.hash,
      payloadScope: shard.path,
      deferMaintenance: true,
    });
  }
  await finalizeNormalizedJsonlIngestion(indexedDB);
  return status;
}

async function query(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || !Array.isArray(payload.sourceNames)
      || payload.sourceNames.length > 100
      || payload.sourceNames.some((name) => typeof name !== "string" || !name || name.length > 200)
      || (payload.queries !== undefined && !Array.isArray(payload.queries))
      || (payload.compiledQueries !== undefined && !Array.isArray(payload.compiledQueries))
      || (payload.aliases !== undefined && (!Array.isArray(payload.aliases)
        || payload.aliases.some((name) => typeof name !== "string")))
      || (payload.replacedSources !== undefined && (!Array.isArray(payload.replacedSources)
        || payload.replacedSources.some((name) => typeof name !== "string")))
      || (payload.pagination !== undefined && (!payload.pagination
        || typeof payload.pagination !== "object" || Array.isArray(payload.pagination)))) {
    throw Object.assign(new Error("Invalid dashboard query request."), { statusCode: 400 });
  }
  const queries = [...(payload.queries ?? []), ...(payload.compiledQueries ?? [])];
  const replaced = new Set(payload.replacedSources ?? []);
  const requested = [...new Set([
    ...payload.sourceNames.filter((name) => !replaced.has(name)),
    ...(payload.aliases ?? []),
  ])];
  const inputs = { ...logicalSources };
  const readSource = sourceDatabase.prepare("SELECT value FROM preview_sources WHERE name = ?");
  for (const name of resolveDashboardQuerySources(queries, requested)) {
    const source = readSource.get(name);
    if (source) inputs[name] = JSON.parse(String(source.value));
  }
  const sources = await loadDatabaseQuerySources(indexedDB, inputs, {
    sourceNames: requested, queries,
  });
  return {
    ...status,
    sources: paginateDashboardSources(
      Object.fromEntries(requested.map((name) => [name, sources[name]])),
      payload.pagination ?? {},
      continuationRevision(queries, status.revision),
    ),
  };
}

let pending = initialize();
pending.then(
  (status) => parentPort.postMessage({ ready: status }),
  (error) => {
    parentPort.postMessage({ failed: error.message });
    parentPort.close();
  },
);
parentPort.on("message", ({ id, operation, payload }) => {
  const result = pending.then(async () => {
    if (operation === "query") return query(payload);
    if (operation === "diagnostics") return processDataRequest({
      operation: "query-canonical-database-diagnostics",
    });
    if (operation === "refresh") return status;
    if (operation === "memory") return processDataRequest({
      ...payload, operation: "query-repository-memory",
    });
    throw new Error("Unknown SQLite dashboard operation.");
  });
  result.then(
    (result) => parentPort.postMessage({ id, result }),
    (error) => parentPort.postMessage({
      id,
      error: {
        error: error.message,
        code: error.code ?? "",
        queryId: error.queryId ?? "",
        boundary: error.boundary ?? "",
        statusCode: error.statusCode ?? 422,
      },
    }),
  );
  pending = result.catch(() => {});
});
