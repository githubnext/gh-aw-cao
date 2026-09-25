import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { IDBFactory } from "fake-indexeddb";
import {
  loadDatabaseQuerySources,
} from "../../dashboard/site/src/data/queries/database.js";
import {
  DATABASE_STORES,
  readCollections,
} from "../../dashboard/site/src/data/storage/indexeddb.js";
import {
  installSqliteIndexedDB,
} from "../../dashboard/site/src/data/storage/sqlite-indexeddb.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const siteRoot = join(repositoryRoot, "dashboard/site");
const dashboardPath = join(siteRoot, "dashboard.json");
const databaseQueriesPath = join(siteRoot, "src/data/queries/database.json");
const reportDirectory = resolve(
  process.env.DASHBOARD_QUERY_PARITY_OUTPUT ?? "test-results/dashboard-query-parity",
);
const reportPath = join(reportDirectory, "report.json");
const accessToken = "dashboard-query-parity-access-token";
const serverURL = "http://127.0.0.1:18443";
const metadata = {
  "as-of": "2026-09-23T18:05:00Z",
  completeness: "complete",
  freshness: "fresh",
  "artifact-generation": "synthetic-query-parity",
};

function logicalSource(rows) {
  return { rows, metadata };
}

function representativeSources() {
  const workflows = [
    ["alpha", "review", "orchestrator"],
    ["beta", "live", "worker"],
    ["idle", "review", "worker"],
  ];
  const runs = [
    ["1001", "alpha", "success", "workflow_dispatch", "2026-09-23T17:00:00Z", 4],
    ["1002", "alpha", "failure", "schedule", "2026-09-23T17:15:00Z", 9],
    ["1003", "beta", "success", "schedule", "2026-09-23T17:30:00Z", 6],
    ["1004", "beta", "timed-out", "workflow_dispatch", "2026-09-23T17:45:00Z", 12],
  ];
  const workflowPath = (name) => `.github/workflows/${name}.md`;
  return {
    campaigns: logicalSource([
      {
        campaign: "synthetic-operations",
        "campaign-name": "Synthetic operations",
        "campaign-description": "Representative query parity data",
        "campaign-mode": "review",
        "campaign-enabled": true,
        "campaign-worker-count": 2,
        "observed-at": metadata["as-of"],
      },
    ]),
    repositories: logicalSource([
      {
        organization: "synthetic-org",
        repository: "control-plane",
        visibility: "private",
        "rollout-mode": "review",
        "observed-at": metadata["as-of"],
      },
      {
        organization: "synthetic-org",
        repository: "target",
        visibility: "private",
        "rollout-mode": "live",
        "observed-at": metadata["as-of"],
      },
    ]),
    workflows: logicalSource(workflows.map(([name, mode, role], index) => ({
      organization: "synthetic-org",
      repository: index === 1 ? "target" : "control-plane",
      workflow: workflowPath(name),
      "workflow-id": String(500 + index),
      "workflow-name": `Synthetic ${name}`,
      "workflow-role": role,
      "workflow-active": "true",
      "workflow-registry-state": "active",
      "admission-status": "admitted",
      "inventory-ready": true,
      campaign: "synthetic-operations",
      "campaign-name": "Synthetic operations",
      "rollout-mode": mode,
      "created-at": "2026-09-01T00:00:00Z",
      "updated-at": metadata["as-of"],
      "observed-at": metadata["as-of"],
    }))),
    runs: logicalSource(runs.map(([id, workflow, conclusion, event, startedAt, aic], index) => ({
      organization: "synthetic-org",
      repository: workflow === "beta" ? "target" : "control-plane",
      workflow: workflowPath(workflow),
      run: id,
      "run-attempt": 1,
      "run-status": "completed",
      "run-conclusion": conclusion,
      event,
      "started-at": startedAt,
      "ended-at": new Date(Date.parse(startedAt) + (index + 1) * 60_000).toISOString(),
      duration: (index + 1) * 60,
      "rollout-mode": workflow === "beta" ? "live" : "review",
      engine: index % 2 === 0 ? "copilot" : "claude",
      "requested-model": index % 2 === 0 ? "model-a" : "model-b",
      "resolved-model": index % 2 === 0 ? "model-a" : "model-c",
      "aic-total": aic,
      "observed-at": metadata["as-of"],
    }))),
    usage: logicalSource(runs.map(([id, workflow, , , startedAt, aic], index) => ({
      organization: "synthetic-org",
      repository: workflow === "beta" ? "target" : "control-plane",
      workflow: workflowPath(workflow),
      run: id,
      engine: index % 2 === 0 ? "copilot" : "claude",
      "resolved-model": index % 2 === 0 ? "model-a" : "model-c",
      "rollout-mode": workflow === "beta" ? "live" : "review",
      aic,
      "input-tokens": 1000 + index * 100,
      "output-tokens": 100 + index * 10,
      "observed-at": startedAt,
    }))),
    "work-items": logicalSource(runs.map(([id, workflow, conclusion, , startedAt]) => ({
      "work-item-id": `synthetic:${workflow}`,
      name: `Synthetic ${workflow}`,
      objective: "Exercise dashboard query semantics",
      organization: "synthetic-org",
      repository: workflow === "beta" ? "target" : "control-plane",
      workflow: workflowPath(workflow),
      run: id,
      campaign: "synthetic-operations",
      "lifecycle-state": conclusion === "success" ? "completed" : "blocked",
      phase: "completed",
      "verification-state": conclusion === "success" ? "verified" : "pending",
      "outcome-state": conclusion === "success" ? "accepted" : "pending",
      "started-at": startedAt,
      "observed-at": metadata["as-of"],
    }))),
    "operational-values": logicalSource([
      {
        "operation-id": "synthetic-operations",
        operation: "Synthetic operations",
        repository: "control-plane",
        "verification-state": "verified",
        "outcome-state": "accepted",
        value: 42,
        "observed-at": metadata["as-of"],
      },
    ]),
    outcomes: logicalSource([
      {
        "safe-output": "issue-17",
        "safe-output-kind": "create-issue",
        "outcome-title": "Synthetic finding",
        "outcome-status": "open",
        "outcome-state": "accepted",
        organization: "synthetic-org",
        repository: "control-plane",
        workflow: workflowPath("alpha"),
        run: "1002",
        "rollout-mode": "review",
        "published-at": "2026-09-23T17:16:00Z",
        "observed-at": metadata["as-of"],
        "external-link": { href: "https://example.invalid/issues/17" },
      },
    ]),
    "grader-observations": logicalSource([
      {
        organization: "synthetic-org",
        repository: "control-plane",
        workflow: workflowPath("alpha"),
        run: "1001",
        grader: "synthetic-quality",
        score: 0.75,
        "observed-at": metadata["as-of"],
      },
    ]),
    "firewall-observations": logicalSource([
      {
        organization: "synthetic-org",
        repository: "control-plane",
        workflow: workflowPath("alpha"),
        run: "1001",
        domain: "api.github.com",
        decision: "allowed",
        "request-count": 3,
        "observed-at": metadata["as-of"],
      },
    ]),
  };
}

function dashboardQueries() {
  const document = JSON.parse(readFileSync(dashboardPath, "utf8"));
  const resolveContext = (value) => {
    if (Array.isArray(value)) return value.map(resolveContext);
    if (!value || typeof value !== "object") return value;
    if (value.context === "time-end") return { value: metadata["as-of"] };
    return Object.fromEntries(Object.entries(value).map(
      ([key, item]) => [key, resolveContext(item)],
    ));
  };
  // Ingestion receipts describe each backend's own writes, so their values are
  // intentionally backend-local rather than cross-backend query results.
  return resolveContext(document.dashboard.queries).filter(
    (query) => query.from !== "transactions",
  );
}

function rowsByQuery(result, names) {
  return Object.fromEntries(names.map((name) => [name, result[name]?.rows ?? []]));
}

async function executeNodeBackend(factory, sources, queries, names) {
  const result = await loadDatabaseQuerySources(factory, sources, {
    ingest: true,
    queries,
    sourceNames: names,
  });
  return rowsByQuery(result, names);
}

async function executeBrowserBackend(sources, queries, names) {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
    ...(executablePath ? { executablePath } : {}),
  });
  try {
    const context = await browser.newContext();
    await context.route("http://dashboard.test/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/" || pathname === "/index.html") {
        await route.fulfill({ contentType: "text/html", body: "<main>Query parity</main>" });
        return;
      }
      if (pathname === "/sources/manifest.json") {
        await route.fulfill({ status: 404, body: "Not found" });
        return;
      }
      if (pathname === "/sources.json") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(sources),
        });
        return;
      }
      const filePath = join(siteRoot, pathname);
      if (!filePath.startsWith(`${siteRoot}/`) || !existsSync(filePath)) {
        await route.fulfill({ status: 404, body: "Not found" });
        return;
      }
      await route.fulfill({
        contentType: pathname.endsWith(".json") ? "application/json" : "application/javascript",
        body: readFileSync(filePath),
      });
    });
    const page = await context.newPage();
    await page.goto("http://dashboard.test/");
    return await page.evaluate(async ({ queries: definitions, names: requested }) => {
      const { loadCanonicalDashboardSources } = await import(
        `${location.origin}/src/data-processor.js`
      );
      const result = await loadCanonicalDashboardSources(
        `${location.origin}/sources.json`,
        requested,
        { githubUrlBase: "https://github.com", pages: [], queries: definitions },
      );
      return Object.fromEntries(requested.map((name) => [name, result[name]?.rows ?? []]));
    }, { queries, names });
  } finally {
    await browser.close();
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeDeployedArtifact(directory, factory, sources) {
  const canonical = await readCollections(factory, DATABASE_STORES.filter(
    (name) => name !== "transactions",
  ));
  const runCollections = new Set(["campaigns", "repositories", "workflows", "runs"]);
  const encode = (collections, phase) => [
    JSON.stringify({ kind: "metadata", schemaVersion: 13, ingestionVersion: 3, phase }),
    ...collections.flatMap((collection) => canonical[collection].map((record) =>
      JSON.stringify({ kind: "record", collection, record })
    )),
    "",
  ].join("\n");
  const runs = encode([...runCollections], "runs");
  const records = encode(["domains", "tools", "audits", "issues"], "records");
  const runsName = "gh-aw-logs-runs/synthetic.jsonl";
  const recordsName = "gh-aw-logs-records/synthetic.jsonl";
  await mkdir(join(directory, dirname(runsName)), { recursive: true });
  await mkdir(join(directory, dirname(recordsName)), { recursive: true });
  await Promise.all([
    writeFile(join(directory, runsName), runs),
    writeFile(join(directory, recordsName), records),
    writeFile(
      join(directory, "inventory-sources.json"),
      `${JSON.stringify(Object.fromEntries(Object.entries(sources).filter(
        ([name]) => !runCollections.has(name) && !["domains", "tools", "audits", "issues"].includes(name),
      )), null, 2)}\n`,
    ),
    writeFile(
      join(directory, "payload-hashes.json"),
      `${JSON.stringify({
        [runsName]: sha256(runs),
        [recordsName]: sha256(records),
      }, null, 2)}\n`,
    ),
  ]);
}

async function waitForServer() {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${serverURL}/api/v1/health`);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Redis dashboard server did not become ready: ${lastError}`);
}

async function executeRedisBackend(artifactDirectory, queries, names) {
  const binary = process.env.DASHBOARD_SERVER_BINARY;
  if (!binary) throw new Error("DASHBOARD_SERVER_BINARY is required");
  const child = spawn(binary, [
    "serve",
    "--source", artifactDirectory,
    "--access-token", accessToken,
    "--listen", "127.0.0.1:18443",
    "--site", siteRoot,
    "--dashboard-queries", dashboardPath,
    "--database-queries", databaseQueriesPath,
    "--redis-url", process.env.REDIS_URL ?? "redis://127.0.0.1:6379/0",
    "--redis-namespace", `query-parity-${process.pid}`,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  try {
    await waitForServer();
    const response = await fetch(`${serverURL}/api/v1/query`, {
      method: "POST",
      headers: {
        authorization: ["Bearer", accessToken].join(" "),
        "content-type": "application/json",
      },
      body: JSON.stringify({ sourceNames: names, queries }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`Redis query failed (${response.status}): ${JSON.stringify(payload)}`);
    return rowsByQuery(payload.sources, names);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolvePromise) => child.once("exit", resolvePromise)),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 5000)),
    ]);
    if (!child.killed) child.kill("SIGKILL");
    if (child.exitCode && child.exitCode !== 0) {
      process.stderr.write(logs);
    }
  }
}

function stableJSON(value) {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right)
    ).map(([key, item]) => `${JSON.stringify(key)}:${stableJSON(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function normalizedRows(rows, ordered) {
  const normalized = JSON.parse(JSON.stringify(rows));
  return ordered ? normalized : normalized.toSorted((left, right) =>
    stableJSON(left).localeCompare(stableJSON(right))
  );
}

function normalizedParityRows(query, rows, ordered) {
  const normalized = normalizedRows(rows, ordered);
  if (query?.from !== "transactions") return normalized;
  return normalized.map((row) => {
    const copy = { ...row };
    delete copy.id;
    delete copy["created-at"];
    delete copy["payload-hash"];
    return copy;
  });
}

function compareBackends(results, queries) {
  const baselineName = "node-indexeddb";
  const queryIndex = new Map(queries.map((query) => [query.name, query]));
  const mismatches = [];
  for (const [backend, rowsByName] of Object.entries(results)) {
    if (backend === baselineName) continue;
    for (const [name, baselineRows] of Object.entries(results[baselineName])) {
      const query = queryIndex.get(name);
      if (backend === "redis" && query?.from === "transactions") continue;
      const ordered = (query?.["order-by"]?.length ?? 0) > 0;
      const expected = normalizedParityRows(query, baselineRows, ordered);
      const actual = normalizedParityRows(query, rowsByName[name] ?? [], ordered);
      if (stableJSON(actual) !== stableJSON(expected)) {
        mismatches.push({
          query: name,
          backend,
          semantics: ordered ? "ordered" : "unordered",
          expectedRows: expected.length,
          actualRows: actual.length,
          expected,
          actual,
        });
      }
    }
  }
  return mismatches;
}

async function main() {
  mkdirSync(reportDirectory, { recursive: true });
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "dashboard-query-parity-"));
  const artifactDirectory = join(temporaryDirectory, "artifact");
  const sqlitePath = join(temporaryDirectory, "dashboard.sqlite");
  const sources = representativeSources();
  const queries = dashboardQueries();
  const names = queries.map(({ name }) => name);
  const report = {
    generatedAt: new Date().toISOString(),
    queryCount: queries.length,
    backends: [],
    orderedQueries: queries.filter((query) => query["order-by"]?.length).length,
    unorderedQueries: queries.filter((query) => !query["order-by"]?.length).length,
    mismatches: [],
    status: "failed",
  };
  try {
    const nodeFactory = new IDBFactory();
    const nodeRows = await executeNodeBackend(nodeFactory, sources, queries, names);
    await mkdir(artifactDirectory, { recursive: true });
    await writeDeployedArtifact(artifactDirectory, nodeFactory, sources);
    const [browserRows, sqliteRows, redisRows] = await Promise.all([
      executeBrowserBackend(sources, queries, names),
      executeNodeBackend(installSqliteIndexedDB(sqlitePath), sources, queries, names),
      executeRedisBackend(artifactDirectory, queries, names),
    ]);
    const results = {
      "node-indexeddb": nodeRows,
      "playwright-indexeddb": browserRows,
      "sqlite-indexeddb": sqliteRows,
      redis: redisRows,
    };
    report.backends = Object.keys(results);
    report.mismatches = compareBackends(results, queries);
    report.status = report.mismatches.length === 0 ? "passed" : "failed";
    if (report.mismatches.length > 0) {
      throw new Error(`${report.mismatches.length} dashboard query parity comparison(s) failed`);
    }
    process.stdout.write(
      `Dashboard query parity passed for ${queries.length} queries across ${report.backends.length} backends.\n`,
    );
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

await main();
