import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const executeFile = promisify(execFile);
const campaignJsonUrl = new URL("../../package.json", import.meta.url);
const campaignJson = JSON.parse(await readFile(campaignJsonUrl, "utf8"));
const cao = fileURLToPath(new URL(campaignJson.bin.cao, campaignJsonUrl));

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
  assert.ok(query.intent.length > 0);
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
    "cao query QUERY_ID",
    "cao mcp",
  ]) {
    assert.ok(output.includes(line), `usage mentions ${line}`);
  }
});
