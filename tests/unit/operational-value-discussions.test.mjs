import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectDiscussionHistory, readDiscussionHistory } from "../../scripts/collect-workflow-discussions.mjs";
import { readJsonArchive, writeJsonArchive } from "../../.github/skills/add-operational-value/scripts/json-archive.mjs";

const repository = "octo/example", until = "2026-10-18T00:00:00Z";
const clock = () => "2026-10-19T00:00:00Z";
const metadata = JSON.stringify({ full_name: repository, id: 7 });
const row = (number, createdAt = "2026-10-17T00:00:00Z") => ({
  id: `D_${number}`, number, title: `Discussion ${number}`, body: "Original public report.\n",
  url: `https://github.com/${repository}/discussions/${number}`, createdAt, updatedAt: createdAt,
});
const page = (nodes, cursor, more = false) => JSON.stringify({
  data: { repository: { databaseId: 7, discussions: {
    nodes, pageInfo: { endCursor: cursor, hasNextPage: more },
  } } },
});
function setup(t) {
  const outputDirectory = mkdtempSync(path.join(os.tmpdir(), "cao-discussions-"));
  t.after(() => rmSync(outputDirectory, { recursive: true }));
  return { repository, until, outputDirectory };
}
function transport(pages) {
  let calls = 0;
  const request = async (endpoint, query) => {
    calls++;
    if (!query) {
      assert.equal(endpoint, `repos/${repository}`);
      return metadata;
    }
    assert.equal(endpoint, "graphql");
    const after = query.match(/after:([^,]+),orderBy/)[1];
    const value = pages[JSON.parse(after) ?? "initial"];
    assert.notEqual(value, undefined);
    return value;
  };
  return { request, calls: () => calls };
}

test("Discussion acquisition preserves exact response bytes, scope, cutoff and independent inventory", async t => {
  const options = setup(t);
  const original = page([row(3, "2026-10-19T00:00:00Z"), row(2)], "second", true);
  const api = transport({ initial: original, second: page([row(1)], "last") });
  const result = await collectDiscussionHistory(options, api.request, clock);
  assert.equal(result.complete, true);
  assert.equal(result.scanned, 3);
  assert.equal(result.retained, 2);
  assert.equal(result.excludedAfterCutoff, 1);
  assert.equal(api.calls(), 3);
  const restored = readDiscussionHistory(options.outputDirectory);
  assert.deepEqual(restored.discussions.map(value => value.number), [2, 1]);
  assert.equal(restored.discussions[0].body, row(2).body);
  assert.equal(readJsonArchive(path.join(options.outputDirectory, result.pages[0].file)).body, original);
  assert.match(result.limitation, /not historical originals/);
  await assert.rejects(collectDiscussionHistory(options, api.request, clock), /explicitly --resume/);
});

test("bounded interruption checkpoints and resumes without reacquiring completed pages", async t => {
  const options = setup(t);
  const api = transport({ initial: page([row(2)], "second", true), second: page([row(1)], "last") });
  await assert.rejects(collectDiscussionHistory({ ...options, requestBudget: 2 }, api.request, clock), /budget exhausted/);
  assert.equal(api.calls(), 2);
  assert.equal(readDiscussionHistory(options.outputDirectory).index.complete, false);
  const resumed = transport({ second: page([row(1)], "last") });
  const index = await collectDiscussionHistory({ ...options, resume: true }, resumed.request, clock);
  assert.equal(resumed.calls(), 2);
  assert.equal(index.complete, true);
  assert.equal(index.retained, 2);
  await assert.rejects(collectDiscussionHistory({ ...options, resume: true, repository: "octo/other" },
    resumed.request, clock), /scope mismatch/);
});

test("duplicate post-cutoff identities and non-advancing cursors fail closed", async t => {
  for (const second of [
    page([row(2, "2026-10-19T00:00:00Z")], "last"),
    page([row(1)], "second", true),
  ]) {
    const options = setup(t);
    const api = transport({ initial: page([row(2, "2026-10-19T00:00:00Z")], "second", true), second });
    await assert.rejects(collectDiscussionHistory(options, api.request, clock), /repeated|Non-advancing/);
    assert.equal(readDiscussionHistory(options.outputDirectory).index.complete, false);
  }
});

test("original corruption, wrong repository and GraphQL errors cannot become missing or successful reports", async t => {
  const options = setup(t);
  const api = transport({ initial: page([row(1)], "last") });
  await collectDiscussionHistory(options, api.request, clock);
  const file = path.join(options.outputDirectory, "page-00001.json.gz");
  const original = readJsonArchive(file);
  writeJsonArchive(file, { ...original, body: original.body + " " });
  assert.throws(() => readDiscussionHistory(options.outputDirectory), /digest/);
  for (const body of [
    page([{ ...row(1), url: "https://github.com/other/repo/discussions/1" }], "last"),
    JSON.stringify({ errors: [{ message: "Forbidden" }] }),
    page([{ ...row(1), body: null }], "last"),
  ]) {
    const target = setup(t), bad = transport({ initial: body });
    await assert.rejects(collectDiscussionHistory(target, bad.request, clock), /Invalid|Malformed/);
    assert.equal(readDiscussionHistory(target.outputDirectory).index.retained, 0);
  }
  assert.ok(readFileSync(path.join(options.outputDirectory, "repository.json.gz")).length);
});
