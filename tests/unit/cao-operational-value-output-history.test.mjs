import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { collectOutputHistory, normalizeOutputIdentity, readOutputHistory } from "../../.github/skills/add-operational-value/scripts/collect-output-history.mjs";

const until = "2026-10-18T15:00:12Z";
const clock = () => "2026-10-18T15:30:00Z";
const item = (number, changes = {}) => ({ number, node_id: `I_${number}`,
  html_url: `https://github.com/octo/example/issues/${number}`, state: "open",
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", closed_at: null,
  body: "<!-- gh-aw-workflow-id: improve -->\n<!-- gh-aw-agentic-workflow: Improve, workflow_id: improve, run: https://github.com/octo/example/actions/runs/123, id: 123 -->",
  user: { type: "Bot" }, ...changes });
const source = { path: ".github/workflows/improve.md", type: "blob", sha: "b".repeat(40) };
const read = file => JSON.parse(gunzipSync(readFileSync(file)));
function service(pages, options = {}) {
  const calls = [];
  const get = async (endpoint, query) => {
    calls.push(query ?? endpoint);
    if (endpoint === "repos/octo/example") return { id: 9, full_name: "octo/example", default_branch: "main" };
    if (endpoint === "repos/old/example") return { id: options.aliasId ?? 9 };
    if (endpoint.includes("/commits?")) return [{ sha: "a".repeat(40) }];
    if (endpoint.includes("/git/trees/")) return { truncated: options.truncated ?? false,
      tree: [source, { path: source.path.replace(".md", ".lock.yml"), type: "blob", sha: "c".repeat(40) },
        { path: ".github/workflows/README.md", type: "blob", sha: "d".repeat(40) }] };
    const page = Number(query.match(/after:"page-(\d+)"/)?.[1] ?? 0);
    const rows = pages[page] ?? [];
    const convert = value => ({ id: value.node_id, number: value.number, url: value.html_url, body: value.body,
      state: value.pull_request?.merged_at ? "MERGED" : value.state.toUpperCase(),
      mergedAt: value.pull_request?.merged_at, stateReason: value.state_reason, createdAt: value.created_at,
      updatedAt: value.updated_at, closedAt: value.closed_at, author: { __typename: value.user?.type } });
    return { data: { repository: { databaseId: 9,
      issues: { nodes: rows.filter(row => !row.pull_request).map(convert),
        pageInfo: { hasNextPage: rows.filter(row => !row.pull_request).length === 100, endCursor: `page-${page + 1}` } },
      pullRequests: { nodes: rows.filter(row => row.pull_request).map(convert),
        pageInfo: { hasNextPage: rows.filter(row => row.pull_request).length === 100, endCursor: `page-${page + 1}` } },
    } } };
  };
  return { get, calls };
}

test("output normalization preserves lineage but neither raw prompts nor value claims", () => {
  const value = item(1);
  value.body += "\nDO NOT PRESERVE THIS PROMPT. Fixes #44. https://github.com/octo/example/pull/45";
  const row = normalizeOutputIdentity(value, "octo/example", [], until, clock());
  assert.equal(row.workflowReference.workflowId, "improve");
  assert.equal(row.workflowReference.runId, "123");
  assert.deepEqual(row.relatedCandidates, [44, 45]);
  assert.ok(!JSON.stringify(row).includes("DO NOT PRESERVE"));
  assert.equal(Object.hasOwn(row, "value"), false);
  assert.match(row.bodySha256, /^[a-f0-9]{64}$/);
  assert.equal(normalizeOutputIdentity(item(2, { body: null }), "octo/example", [], until, clock()).workflowReference, null);
  const malformed = normalizeOutputIdentity(item(3, { body: '<!-- gh-aw-execution: DO NOT PRESERVE THIS PROMPT -->' }),
    "octo/example", [], until, clock());
  assert.equal(malformed.referenceError, "Invalid execution marker JSON");
  assert.ok(!JSON.stringify(malformed).includes("DO NOT PRESERVE"));
});

test("verified rename aliases do not broaden repository scope or turn markers into receipts", () => {
  const value = item(1);
  value.body = value.body.replaceAll("octo/example", "old/example");
  const row = normalizeOutputIdentity(value, "octo/example", ["old/example"], until, clock());
  assert.equal(row.workflowReference.repository, "old/example");
  assert.equal(row.repository, "octo/example");
  const outside = normalizeOutputIdentity(value, "octo/example", [], until, clock());
  assert.equal(outside.workflowReference, null);
  assert.match(outside.referenceError, /outside/);
});

test("cutoffs are half-open and footer conflicts stay explicit", () => {
  assert.equal(normalizeOutputIdentity(item(1, { created_at: until }), "octo/example", [], until, clock()), null);
  const row = normalizeOutputIdentity(item(2, { body: `${item(2).body}\n<!-- gh-aw-workflow-id: other -->` }),
    "octo/example", [], until, clock());
  assert.equal(row.workflowReference, null);
  assert.match(row.referenceError, /Conflicting/);
});

test("collector inventories installed Markdown once, excluding generated locks and unpaired documentation", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "output-history-"));
  try {
    const api = service([[item(1)]]);
    const result = await collectOutputHistory({ repository: "octo/example", until, outputDirectory: directory }, api.get, clock);
    assert.equal(result.workflows.length, 1);
    assert.deepEqual(result.unpairedMarkdown, [".github/workflows/README.md"]);
    assert.equal(result.totalEntities, 1);
    assert.equal(result.complete, true);
    assert.equal(result.knownRunReferences, 1);
    assert.ok(result.limitations.some(value => value.includes("Discussions")));
    const rows = read(path.join(directory, result.partitions[0].file));
    assert.equal(rows[0].id, "I_1");
    assert.deepEqual(readOutputHistory(directory).entities, rows);
    await assert.rejects(collectOutputHistory({ repository: "octo/example", until, outputDirectory: directory }, api.get, clock), /exists/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("budget exhaustion preserves a resumable partial acquisition instead of success-shaped coverage", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "output-history-resume-"));
  try {
    const pages = [Array.from({ length: 100 }, (_, i) => item(i + 1)), [item(101)]];
    const api = service(pages);
    const options = { repository: "octo/example", until, outputDirectory: directory, requestBudget: 4 };
    await assert.rejects(collectOutputHistory(options, api.get, clock), /budget exhausted/);
    const partial = read(path.join(directory, "history.json.gz"));
    assert.equal(partial.complete, false);
    assert.equal(partial.totalEntities, 100);
    const resumed = service(pages);
    const result = await collectOutputHistory({ ...options, resume: true }, resumed.get, clock);
    assert.equal(result.complete, true);
    assert.equal(result.totalEntities, 101);
    assert.ok(resumed.calls.some(call => call.includes('after:"page-1"')));
    assert.equal(readdirSync(directory).filter(file => file.startsWith("entities-")).length, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("approximate creation order never truncates collection at the first post-cutoff object", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "output-history-order-"));
  try {
    const first = Array.from({ length: 100 }, (_, i) => item(i + 1));
    first[99] = item(100, { created_at: "2026-10-18T15:01:00Z" });
    const api = service([first, [item(101)]]);
    const result = await collectOutputHistory({ repository: "octo/example", until, outputDirectory: directory }, api.get, clock);
    assert.equal(result.totalEntities, 100);
    assert.equal(result.excludedAfterCutoff, 1);
    assert.equal(result.partitions.length, 2);
    assert.equal(result.complete, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("repeated identities across page boundaries fail rather than silently deduplicate unstable pagination", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "output-history-repeat-"));
  try {
    const api = service([Array.from({ length: 100 }, (_, i) => item(i + 1)), [item(100)]]);
    await assert.rejects(collectOutputHistory({ repository: "octo/example", until, outputDirectory: directory }, api.get, clock), /identities repeated/);
    assert.equal(read(path.join(directory, "history.json.gz")).complete, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("truncated trees and wrong alias identity fail closed", async () => {
  for (const variant of [{ truncated: true }, { aliasId: 88 }]) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "output-history-invalid-"));
    try {
      const api = service([], variant);
      await assert.rejects(collectOutputHistory({ repository: "octo/example", until, outputDirectory: directory,
        aliases: variant.aliasId ? ["old/example"] : [] }, api.get, clock), /incomplete|different repository/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test("resume verifies existing partitions before accepting their identities or coverage", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "output-history-corrupt-"));
  try {
    const api = service([[item(1)]]);
    const options = { repository: "octo/example", until, outputDirectory: directory };
    const result = await collectOutputHistory(options, api.get, clock);
    writeFileSync(path.join(directory, result.partitions[0].file), gzipSync(JSON.stringify([item(2)])));
    await assert.rejects(collectOutputHistory({ ...options, resume: true }, api.get, clock), /integrity mismatch/);
    assert.throws(() => readOutputHistory(directory), /integrity mismatch/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("cursor traversal crosses both Search and REST page-number limits and replays offline", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "output-history-large-"));
  try {
    const pages = Array.from({ length: 101 }, (_, page) =>
      Array.from({ length: 100 }, (_, index) => item(page * 100 + index + 1)));
    const api = service(pages);
    const result = await collectOutputHistory({ repository: "octo/example", until,
      outputDirectory: directory, requestBudget: 110 }, api.get, clock);
    assert.equal(result.complete, true);
    assert.equal(result.totalEntities, 10100);
    assert.equal(result.partitions.length, 102);
    assert.equal(readOutputHistory(directory).entities.length, 10100);
    assert.ok(api.calls.some(call => call.includes('after:"page-100"')));
    assert.ok(!api.calls.some(call => call.startsWith("search/") || call.includes("&page=")));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("PR connection preserves merge facts without claiming acceptance or value", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "output-history-pull-"));
  try {
    const mergedAt = "2026-02-01T00:00:00Z";
    const api = service([[item(1, { state: "closed", html_url: "https://github.com/octo/example/pull/1",
      pull_request: { merged_at: mergedAt } })]]);
    await collectOutputHistory({ repository: "octo/example", until, outputDirectory: directory }, api.get, clock);
    const [row] = readOutputHistory(directory).entities;
    assert.equal(row.kind, "PullRequest");
    assert.equal(row.mergedAt, mergedAt);
    assert.equal(row.state, "CLOSED");
    assert.equal(Object.hasOwn(row, "value"), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("graph errors, wrong repository and stuck cursors never publish complete coverage", async () => {
  for (const response of [
    { errors: [{ message: "Query failed" }] },
    { data: { repository: { databaseId: 88 } } },
    { data: { repository: { databaseId: 9, issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "stuck" } } } } },
  ]) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "output-history-graph-error-"));
    try {
      const api = service([]);
      await assert.rejects(collectOutputHistory({ repository: "octo/example", until, outputDirectory: directory },
        (endpoint, query) => endpoint === "graphql" ? response : api.get(endpoint, query), clock), /Invalid|Malformed/);
      assert.equal(read(path.join(directory, "history.json.gz")).complete, false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});
