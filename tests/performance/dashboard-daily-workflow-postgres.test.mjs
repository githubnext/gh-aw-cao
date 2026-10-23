/**
 * Build the existing server, set CAO_POSTGRES_URL to a LOCAL test database, then:
 * DASHBOARD_SERVER_BINARY=path/to/cao-dashboard node --test tests/performance/dashboard-daily-workflow-postgres.test.mjs
 * Add CAO_DAILY_WORKFLOW_FULL=1 for 25,000 runs and 1,375,000 real children.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import { promisify } from "node:util";
import { CANONICAL_SCHEMA_VERSION } from "../../dashboard/site/src/data/model/schema.js";
import { NORMALIZED_JSONL_INGESTION_VERSION } from "../../dashboard/site/src/data/ingest/coordinator.js";
import { waitForServer } from "../e2e/dashboard-query-parity-readiness.mjs";

const execute = promisify(execFile);
const endpoint = process.env.CAO_POSTGRES_URL;
const full = process.env.CAO_DAILY_WORKFLOW_FULL === "1";
const runs = full ? 25_000 : 250;
const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const output = path.resolve("test-results/daily-workflow-aggregates");
const binary = path.resolve(process.env.DASHBOARD_SERVER_BINARY || ".tmp/cao-dashboard");
const statementTimeout = Number(process.env.CAO_DAILY_WORKFLOW_POSTGRES_STATEMENT_MS ?? (full ? 300_000 : 30_000));
assert.ok(Number.isSafeInteger(statementTimeout) && statementTimeout > 0);
const query = [{
  name: "daily-workflow-benchmark", from: "daily-workflow-aggregates",
  aggregate: {
    by: ["date"],
    values: [
      { field: "run-count", as: "runs", reducer: "sum" },
      { field: "aic-total-sum", as: "aic", reducer: "sum" },
      { field: "mcp-tool-calls-sum", as: "toolCalls", reducer: "sum" },
    ],
  },
}];

async function fixture(directory) {
  const manifest = {};
  for (const phase of ["runs", "records"]) {
    const relative = `gh-aw-logs-${phase}/workload.jsonl`;
    await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
    const file = await open(path.join(directory, relative), "w");
    const hash = createHash("sha256");
    async function line(record) {
      const text = `${JSON.stringify(record)}\n`;
      hash.update(text);
      await file.write(text);
    }
    const record = async (collection, value) => line({ kind: "record", collection, record: value });
    try {
      await line({
        kind: "metadata", schemaVersion: CANONICAL_SCHEMA_VERSION,
        ingestionVersion: NORMALIZED_JSONL_INGESTION_VERSION,
        phase, records: phase === "runs" ? runs + 11 : runs * 55,
      });
      if (phase === "runs") {
        await record("repositories", { id: "daily:repository", owner: "benchmark", name: "daily" });
        for (let workflow = 0; workflow < 10; workflow += 1) {
          await record("workflows", {
            id: `daily:workflow:${workflow}`, repositoryId: "daily:repository",
            path: `.github/workflows/daily-${workflow}.md`,
          });
        }
      }
      for (let index = 0; index < runs; index += 1) {
        const id = `daily:run:${index}`;
        const timestamp = `${day}T${String(index % 24).padStart(2, "0")}:00:00.000Z`;
        if (phase === "runs") {
          await record("runs", {
            id, repositoryId: "daily:repository", workflowId: `daily:workflow:${index % 10}`,
            githubRunId: String(index + 1), owner: "benchmark", repository: "daily",
            attempt: 1, startedAt: timestamp, createdAt: timestamp, observedAt: timestamp,
            conclusion: index % 5 === 0 ? "failure" : "success", aicTotal: 1 + index % 4,
          });
        } else {
          for (let child = 0; child < 50; child += 1) {
            await record("tools", {
              id: `${id}:tool:${child}`, runId: id, source: "mcp", type: "mcp.tool_call",
              mcpServer: "github", mcpTool: `tool_${child}`, invocationCount: 1,
              status: "success", timestamp, observedAt: timestamp,
            });
          }
          for (let child = 0; child < 5; child += 1) {
            await record("domains", {
              id: `${id}:domain:${child}`, runId: id, domain: `domain-${child}.example`,
              decision: "allowed", requestCount: 1, timestamp, observedAt: timestamp,
            });
          }
        }
      }
    } finally {
      await file.close();
    }
    manifest[relative] = hash.digest("hex");
  }
  await writeFile(path.join(directory, "payload-hashes.json"), JSON.stringify(manifest));
  await writeFile(path.join(directory, "inventory-sources.json"), "{}");
  await writeFile(path.join(directory, "queries.json"), JSON.stringify(query));
}

async function nativeQuery(env, namespace, directory) {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const token = randomUUID();
  const child = spawn(binary, [
    "serve", "--postgres-url", env.CAO_POSTGRES_URL,
    "--redis-namespace", namespace, "--listen", `127.0.0.1:${port}`,
    "--site", "dashboard/site", "--access-token", token,
    "--database-queries", "dashboard/site/src/data/queries/database.json",
    "--dashboard-queries", path.join(directory, "queries.json"),
    "--agent-catalog", "dashboard/site/src/agent/catalog.generated.json",
    "--mcp-contract", "dashboard/site/src/agent/mcp-contract.json",
  ], { env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  try {
    await waitForServer(origin, { child });
    const startedAt = performance.now();
    const response = await fetch(`${origin}/api/v1/query`, {
      method: "POST", headers: { authorization: ["Bearer", token].join(" "), "content-type": "application/json" },
      body: JSON.stringify({ sourceNames: ["daily-workflow-benchmark"], queries: query }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    return { durationMs: performance.now() - startedAt, payload };
  } catch (error) {
    throw new Error(`Native PostgreSQL HTTP query failed: ${error.message}\n${logs}`);
  } finally {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
}

test("daily workload uses production PostgreSQL ingestion and native analytics", {
  skip: endpoint ? false : "set CAO_POSTGRES_URL to a local test database",
  timeout: 1_200_000,
}, async () => {
  const parsed = new URL(endpoint);
  const socket = parsed.searchParams.get("host");
  assert.ok(["127.0.0.1", "[::1]"].includes(parsed.hostname) || socket?.startsWith("/"),
    "benchmark permits only loopback or Unix-socket PostgreSQL");
  const schema = `daily_benchmark_${randomUUID().replaceAll("-", "")}`;
  const directory = path.join(output, schema);
  await mkdir(directory, { recursive: true });
  const psql = async (url, sql) => {
    const { stdout } = await execute("psql", [url, "-X", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql], { maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim();
  };
  await psql(endpoint, `CREATE SCHEMA ${schema}`);
  parsed.searchParams.set("options", `-csearch_path=${schema} -cstatement_timeout=${statementTimeout}`);
  const isolated = parsed.toString().replaceAll("+", "%20");
  const env = { ...process.env, CAO_POSTGRES_URL: isolated };
  delete env.CAO_POLICY_PATH;
  delete env.CAO_MARKETPLACE_POLICY_PATH;
  const report = {
    status: "incomplete", runs, tools: runs * 50, domains: runs * 5, full,
    limitations: [
      "Synthetic manifested canonical shards; excludes fixture generation, provisioning, downloads and upstream normalization.",
      "Table bytes include provisioned tables and indexes; not comparable to SQLite JSON bytes alone.",
      "HTTP duration includes request/response overhead; payload.metrics.durationMs measures native query execution.",
    ],
  };
  try {
    await fixture(directory);
    await execute(binary, ["database", "bootstrap", "--store", "canonical", "--namespace", schema], {
      env: { ...env, CAO_DATABASE_ADMIN_URL: isolated }, maxBuffer: 8 * 1024 * 1024,
    });
    await execute(binary, ["database", "bootstrap", "--store", "operational", "--namespace", schema], {
      env: { ...env, CAO_DATABASE_ADMIN_URL: isolated }, maxBuffer: 8 * 1024 * 1024,
    });
    const startedAt = performance.now();
    await execute(binary, [
      "ingest", "--source", directory, "--redis-namespace", schema,
      "--database-queries", "dashboard/site/src/data/queries/database.json",
    ], { env, maxBuffer: 8 * 1024 * 1024, timeout: 900_000 });
    report.ingestionMs = performance.now() - startedAt;
    report.recordsPerSecond = (runs * 56 + 11) * 1_000 / report.ingestionMs;
    const counts = JSON.parse(await psql(isolated, `SELECT json_build_object(
      'runs',(SELECT count(*) FROM runs),'tools',(SELECT count(*) FROM tools),
      'domains',(SELECT count(*) FROM domains),'groups',(SELECT count(*) FROM daily_workflow_aggregates),
      'aic',(SELECT sum(aic_total_sum) FROM daily_workflow_aggregates),
      'toolCalls',(SELECT sum(mcp_tool_calls_sum) FROM daily_workflow_aggregates),
      'domainRequests',(SELECT sum(firewall_allowed_calls_sum) FROM daily_workflow_aggregates))`));
    assert.deepEqual(counts, {
      runs, tools: runs * 50, domains: runs * 5, groups: 10,
      aic: Math.floor(runs / 4) * 10 + (runs % 4) * (runs % 4 + 1) / 2,
      toolCalls: runs * 50, domainRequests: runs * 5,
    });
    report.counts = counts;
    report.tableBytes = Number(await psql(isolated, `SELECT sum(pg_total_relation_size(c.oid))
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='${schema}' AND c.relkind='r'`));
    report.native = await nativeQuery(env, schema, directory);
    assert.ok(report.native.durationMs < 10_000);
    assert.deepEqual(report.native.payload.sources["daily-workflow-benchmark"].rows, [{
      date: day, runs, aic: counts.aic, toolCalls: runs * 50,
    }]);
    assert.ok(report.native.payload.metrics.operations < 1_000,
      "native aggregate query must not scale with child history");
    assert.deepEqual(report.native.payload.metrics.fallbackOperations, []);
    assert.ok(report.tableBytes > 0 && report.recordsPerSecond > 0);
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.failure = error.message;
    throw error;
  } finally {
    await writeFile(path.join(output, `report-postgres-${full ? "full" : "sample"}.json`), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report));
    await psql(endpoint, `DROP SCHEMA ${schema} CASCADE`);
    await rm(directory, { recursive: true, force: true });
  }
});
