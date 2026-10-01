import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  loadAgentDashboardDocument,
  readAgentCatalog,
} from "../../activity/agent-catalog.mjs";

const executeFile = promisify(execFile);
const campaignJsonUrl = new URL("../../package.json", import.meta.url);
const campaignJson = JSON.parse(await readFile(campaignJsonUrl, "utf8"));
const cao = fileURLToPath(new URL(campaignJson.bin.cao, campaignJsonUrl));
const caoShell = fileURLToPath(new URL("../../cao.sh", import.meta.url));

test("materialized Go agent artifacts match the dashboard source", async () => {
  const [catalog, dashboard, generatedCatalog, generatedDashboard] = await Promise.all([
    readAgentCatalog(),
    loadAgentDashboardDocument(),
    readFile(new URL("../../dashboard/site/src/agent/catalog.generated.json", import.meta.url), "utf8"),
    readFile(new URL("../../dashboard/site/src/agent/queries.generated.json", import.meta.url), "utf8"),
  ]);
  assert.deepEqual(JSON.parse(generatedCatalog), catalog);
  assert.deepEqual(JSON.parse(generatedDashboard), dashboard.dashboard.queries);
});

/**
 * @param {string[]} args
 */
async function runCao(args) {
  const { stdout } = await executeFile(process.execPath, [cao, ...args], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

test("cao queries lists named dashboard queries as JSON", async () => {
  const payload = JSON.parse(await runCao(["queries", "--json"]));
  assert.equal(payload.command, "queries");
  assert.ok(payload.queries.length > 0);
  const ids = payload.queries.map((query) => query.id);
  assert.deepEqual(ids, [...ids], "query order is deterministic");
  const query = payload.queries.find((entry) => entry.id === "campaign-runs");
  assert.ok(query, "campaign-runs is catalogued");
  assert.equal(query.execution.local, true);
  assert.equal(query.execution.backend, "sqlite");
  assert.ok(query.execution.requirements.includes("runs"));
  assert.ok(query.subject.length > 0);
});

test("every agent-facing query defines its own objective and verifiable acceptance", async () => {
  const { queries } = await readAgentCatalog();
  for (const query of queries) {
    for (const field of ["subject", "objective", "acceptance"]) {
      assert.ok(typeof query[field] === "string" && query[field].trim(), `${query.id} needs ${field}`);
    }
  }
});

test("cao queries prints a human readable catalog by default", async () => {
  const output = await runCao(["queries"]);
  assert.match(output, /campaign-runs/);
  assert.doesNotMatch(output, /^\{/);
});

test("cao query-info explains one query and its parameters", async () => {
  const payload = JSON.parse(await runCao(["query-info", "campaign-runs", "--json"]));
  assert.equal(payload.query.id, "campaign-runs");
  assert.ok(Array.isArray(payload.query.parameters));
  assert.ok(payload.query["used-by-pages"].length > 0);
});

test("cao query-info exposes authored semantic annotations", async () => {
  const payload = JSON.parse(await runCao(["query-info", "cost-by-campaign", "--json"]));
  assert.match(payload.query.objective, /Identify campaigns/);
  const text = await runCao(["query-info", "cost-by-campaign"]);
  assert.match(text, /objective: Identify campaigns/);
});

test("cao.sh prompt renders a named query using the dashboard prompt template without a snapshot", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cao-agent-prompt-"));
  try {
    const { stdout } = await executeFile(caoShell, ["prompt", "cost-by-campaign"], { cwd });
    assert.match(stdout, /^Improve CAO by increasing ROI/);
    assert.match(stdout, /Query: cost-by-campaign/);
    assert.match(stdout, /Focus on this query's objective and acceptance/);
    assert.match(stdout, /report a no-op or incomplete investigation/);
    assert.match(stdout, /Subject:\nPresent observed AI Credit cost grouped by centrally managed campaign\./);
    assert.doesNotMatch(stdout, /Subject:\nReuse shared query stages/);
    assert.match(stdout, /Named CAO query IDs: .*cost-by-campaign/);
    assert.match(stdout, /\/analyze-cao/);
    assert.match(stdout, /No data preview was supplied/);
    assert.match(stdout, /"evidence": \{\}/);
    assert.doesNotMatch(stdout, /Page: undefined|View: undefined/);
    assert.match(stdout, /Create a PR with the changes\.\n$/);
    await assert.rejects(access(path.join(cwd, ".cao")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("cao prompt rejects unknown queries and undeclared parameters without a stack trace", async () => {
  for (const args of [
    ["prompt"],
    ["prompt", "not-a-query"],
    ["prompt", "cost-by-campaign", "--param", "unknown=value"]
  ]) {
    const result = await runCaoResult(args);
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  }
});

test("cao pages relates pages to the queries they read", async () => {
  const payload = JSON.parse(await runCao(["pages", "--json"]));
  assert.ok(payload.pages.length > 0);
  const page = payload.pages.find((entry) => entry.queries.length > 0);
  assert.ok(page, "at least one page declares queries");
  const detail = JSON.parse(await runCao(["pages", page.id, "--json"]));
  assert.deepEqual(detail.page, page);
});

test("cao query-info reports an unknown query without a stack trace", async () => {
  let error;
  try {
    await executeFile(process.execPath, [cao, "query-info", "not-a-query"]);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  assert.equal(error.code, 1);
  assert.match(error.stderr, /Unknown dashboard query: not-a-query/);
  assert.doesNotMatch(error.stderr, /\n\s+at /);
});

test("cao --help documents the agent analysis bootstrap", async () => {
  const output = await runCao(["--help"]);
  assert.match(output, /Agent analysis:/);
  for (const line of [
    "cao download",
    "cao pages",
    "cao queries",
    "cao query-info",
    "cao prompt QUERY_ID",
    "cao query QUERY_ID",
    "cao mcp",
  ]) {
    assert.ok(output.includes(line), `usage mentions ${line}`);
  }
});

/**
 * Runs the CLI and returns its outcome without throwing, so tests can assert
 * on exit codes and diagnostics the same way an operator reads them.
 * @param {string[]} args
 */
async function runCaoResult(args) {
  try {
    const { stdout, stderr } = await executeFile(process.execPath, [cao, ...args], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "cao-agent-cli-"));
const database = path.join(temporaryDirectory, "gh-aw-logs.sqlite");

test.after(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("cao prompt includes a bounded preview from an explicitly selected snapshot", async () => {
  await runCao(["query", "campaign-runs", "--database", database]);
  const output = await runCao(["prompt", "campaign-runs", "--database", database, "--param", "campaign=dashboard"]);
  assert.match(output, /Query: campaign-runs/);
  assert.match(output, /"campaign": "dashboard"/);
  assert.match(output, /"availability": "empty"/);
  assert.match(output, /"rows": \[\]/);
  assert.match(output, /Create a PR with the changes\.\n$/);
});

test("cao prompt refuses a missing snapshot instead of creating one", async () => {
  const missing = path.join(temporaryDirectory, "missing.sqlite");
  const result = await runCaoResult(["prompt", "campaign-runs", "--database", missing]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /No CAO snapshot/);
  await assert.rejects(access(missing));
});

test("cao query does not create an empty default database when no snapshot was downloaded", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cao-agent-no-snapshot-"));
  try {
    await assert.rejects(
      executeFile(process.execPath, [cao, "query", "firewall-most-blocked-domains"], { cwd }),
      (error) => {
        assert.match(error.stderr, /No downloaded CAO snapshot.*run cao download/);
        return true;
      },
    );
    await assert.rejects(access(path.join(cwd, ".cao", "gh-aw-logs.sqlite")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("cao query does not mistake an existing empty default database for downloaded evidence", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cao-agent-empty-snapshot-"));
  try {
    await mkdir(path.join(cwd, ".cao"));
    await writeFile(path.join(cwd, ".cao", "gh-aw-logs.sqlite"), "");
    await assert.rejects(
      executeFile(process.execPath, [cao, "query", "firewall-most-blocked-domains"], { cwd }),
      (error) => {
        assert.match(error.stderr, /No downloaded CAO snapshot.*run cao download/);
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("cao query reads one named dashboard query as JSON", async () => {
  const payload = JSON.parse(await runCao(["query", "campaign-runs", "--database", database]));
  assert.equal(payload.query, "campaign-runs");
  assert.ok(Array.isArray(payload.rows));
  assert.equal(payload.metadata.availability, "empty");
  assert.equal(payload.metadata["returned-rows"], 0);
  assert.equal(payload.metadata.limit, 500);
  assert.ok(payload.metadata["as-of"]);
});

test("cao query honours an explicit row bound", async () => {
  const payload = JSON.parse(
    await runCao(["query", "campaign-runs", "--limit", "5", "--database", database]),
  );
  assert.equal(payload.metadata.limit, 5);
});

test("cao query rejects a row bound that is not a positive integer", async () => {
  for (const limit of ["0", "-1", "abc", "2.5"]) {
    const result = await runCaoResult(["query", "campaign-runs", "--limit", limit, "--database", database]);
    assert.equal(result.code, 1, `--limit ${limit} is refused`);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  }
});

test("cao query accepts a declared parameter", async () => {
  const payload = JSON.parse(await runCao([
    "query",
    "campaign-runs",
    "--param",
    "campaign=dashboard",
    "--database",
    database,
  ]));
  assert.deepEqual(payload.metadata.parameters, { campaign: "dashboard" });
});

test("cao query refuses an undeclared parameter and names the declared ones", async () => {
  const result = await runCaoResult([
    "query",
    "campaign-runs",
    "--param",
    "nope=value",
    "--database",
    database,
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown parameter "nope"/);
  assert.match(result.stderr, /declared parameters: campaign/);
});

test("cao query refuses a parameter that is not KEY=VALUE", async () => {
  const result = await runCaoResult(["query", "campaign-runs", "--param", "campaign", "--database", database]);
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test("cao query refuses an unknown named query", async () => {
  const result = await runCaoResult(["query", "not-a-query", "--database", database]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown dashboard query: not-a-query/);
});

test("cao query never accepts SQL as a query identifier", async () => {
  const result = await runCaoResult(["query", "select * from runs", "--database", database]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown dashboard query/);
});

test("cao query --id names the canonical record option when it is not a query", async () => {
  const result = await runCaoResult(["query", "--id", "nope", "--database", database]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /pass --collection COLLECTION/);
});

test("cao query keeps reading canonical collections", async () => {
  const rows = JSON.parse(await runCao([
    "query",
    "--collection",
    "runs",
    "--limit",
    "2",
    "--database",
    database,
  ]));
  assert.ok(Array.isArray(rows));
});

test("cao query keeps reading a declarative query from stdin", () => {
  const stdout = execFileSync(
    process.execPath,
    [cao, "query", "--stdin", "--database", database],
    { input: JSON.stringify({ name: "adhoc", from: "runs", limit: 1 }), maxBuffer: 32 * 1024 * 1024 },
  ).toString();
  assert.ok(Array.isArray(JSON.parse(stdout)));
});

test("cao query rejects an option it does not declare", async () => {
  const result = await runCaoResult(["query", "campaign-runs", "--json", "--database", database]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown option --json/);
});

test("cao pages reports an unknown page without a stack trace", async () => {
  const result = await runCaoResult(["pages", "not-a-page"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown dashboard page: not-a-page/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test("cao pages prints a human readable catalog by default", async () => {
  const output = await runCao(["pages"]);
  assert.doesNotMatch(output, /^\{/);
  const { pages } = JSON.parse(await runCao(["pages", "--json"]));
  assert.ok(output.includes(pages[0].id));
});

test("cao query-info prints a human readable report by default", async () => {
  const output = await runCao(["query-info", "campaign-runs"]);
  assert.match(output, /campaign-runs/);
  assert.doesNotMatch(output, /^\{/);
});

test("cao query-info requires a query identifier", async () => {
  const result = await runCaoResult(["query-info"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /requires a query identifier/);
});

test("cao discovery writes JSON to stdout and nothing else", async () => {
  for (const args of [["queries", "--json"], ["pages", "--json"], ["query-info", "campaign-runs", "--json"]]) {
    const result = await runCaoResult(args);
    assert.equal(result.code, 0);
    assert.doesNotThrow(() => JSON.parse(result.stdout), `${args[0]} emits JSON only`);
  }
});

test("cao discovery is deterministic across runs", async () => {
  const [first, second] = await Promise.all([runCao(["queries", "--json"]), runCao(["queries", "--json"])]);
  assert.equal(first, second);
});

test("every catalogued query reports an execution verdict an agent can act on", async () => {
  const { queries } = JSON.parse(await runCao(["queries", "--json"]));
  for (const query of queries) {
    assert.equal(typeof query.execution.local, "boolean");
    if (query.execution.local) assert.equal(query.execution.backend, "sqlite");
    else assert.ok(query.execution.reason, `${query.id} explains why it cannot run locally`);
  }
});

test("every page relates only to catalogued queries", async () => {
  const { queries } = JSON.parse(await runCao(["queries", "--json"]));
  const { pages } = JSON.parse(await runCao(["pages", "--json"]));
  const catalogued = new Set(queries.map((query) => query.id));
  for (const page of pages) {
    for (const queryId of page.queries) assert.ok(catalogued.has(queryId), `${queryId} is catalogued`);
  }
});
