import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, renameSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { assessTemporaryId, collectTemporaryId, readTemporaryId, temporaryIdDirectory,
  scoreTemporaryId, hashTemporaryId, referenceEdges, hierarchyEdges } from "../../scripts/native-temporary-id-value.mjs";

const hash = hashTemporaryId({});
const at = "2026-10-10T00:00:00Z";
test("temporary-ID retained archives respect the repository file limit and preserve exact predecessor/runtime content", () => {
  for (const name of readdirSync(temporaryIdDirectory)) {
    assert.ok(statSync(`${temporaryIdDirectory}/${name}`).size <= 256 * 1024, `${name} exceeds 256 KiB`);
  }
  for (const [name, digest] of [
    ["predecessor-before-full-join", "5532fd532bcfee709fe1b061966eb71fdc0c52661bf386f7a34b9dea89d9455d"],
    ["runtime-source-review", "8bec511845046c9da13c3d5e86041f49d4bc9e2b4205c1531a009df9fa59fe11"],
  ]) {
    const decoded = readTemporaryId(`${temporaryIdDirectory}/${name}.json.gz`);
    assert.equal(createHash("sha256").update(JSON.stringify(decoded)).digest("hex"), digest);
  }
});
function fixture() {
  const mapping = [1, 2, 3].map((number, i) => ({ temporaryId: `aw_test0${i + 1}`, number,
    nodeId: `I_${number}`, repository: "github/gh-aw" }));
  return { id: "1:1", sourceBound: true, receiptDigest: hash, at, mapping,
    bodies: mapping.map(({ number, nodeId }, from) => ({ number, nodeId, observedAt: at, lastEditedAt: at,
      responseDigest: hash, body: referenceEdges.filter(([a]) => a === from).map(([, to]) =>
        from === 0 ? `- #${to + 1}` : `${to === 0 ? "Parent" : "Related"}: #${to + 1}`).join("\n") })),
    graph: hierarchyEdges.map(([child, parent]) => ({ childId: mapping[child].nodeId, parentId: mapping[parent].nodeId,
      responseDigest: hash, events: [], historyComplete: true, currentLinked: true, observedAt: at })),
    comment: { targetNodeId: mapping[0].nodeId, receiptDigest: hash, responseDigest: hash,
      createdAt: at, lastEditedAt: at, observedAt: at } };
}
const score = (row, metric = "resolved-references") => scoreTemporaryId(metric,
  { valid: true, assessments: [{ id: row.id, ...assessTemporaryId(row) }] });

test("temporary-ID native instrument verifies all exact body and graph edges", () => {
  const row = fixture();
  assert.equal(score(row), 6);
  assert.equal(score(row, "linked-children"), 2);
  assert.equal(score(row, "accepted-triplets"), 1);
});
test("temporary-ID counts independent partial improvement without inventing full acceptance", () => {
  const row = fixture();
  row.graph = [];
  assert.equal(score(row), 6);
  assert.equal(score(row, "linked-children"), null);
  assert.equal(score(row, "accepted-triplets"), null);
  row.bodies[0].body = "- #999\n- #3";
  assert.equal(score(row), 5);
  assert.equal(score(row, "accepted-triplets"), 0);
});
test("temporary-ID missing identities do not erase independently verified surviving pairs", () => {
  const row = fixture();
  row.mapping[2] = null;
  assert.equal(score(row), 2);
  assert.equal(score(row, "linked-children"), 1);
  assert.equal(score(row, "accepted-triplets"), null);
});
test("temporary-ID matching rejects wrong destinations, self assertions and number prefixes", () => {
  const row = fixture();
  row.bodies[0].body = "Cross-references resolved correctly\n- #20\n- #30";
  assert.equal(score(row), 4);
  row.bodies.forEach(body => { body.body = "all temporary IDs resolved correctly"; });
  assert.equal(score(row), 0);
});
test("temporary-ID evidence disappearance and editable footer mappings fail closed", () => {
  for (const mutate of [
    row => { row.sourceBound = false; },
    row => { row.receiptDigest = null; },
    row => { row.mapping = []; },
    row => { row.mapping[0].number = row.mapping[1].number; },
    row => { row.mapping[1].repository = "unrelated/repository"; },
    row => { row.mapping.reverse(); },
  ]) {
    const row = fixture();
    mutate(row);
    assert.equal(score(row), null);
    assert.equal(score(row, "linked-children"), null);
    assert.equal(score(row, "accepted-triplets"), null);
  }
});
test("temporary-ID historical bodies require valid platform timestamps at the observation cutoff", () => {
  const row = fixture();
  row.bodies.forEach(body => { body.lastEditedAt = "2026-10-11T00:00:00Z"; });
  assert.equal(score(row), null);
  row.bodies.forEach(body => { body.lastEditedAt = "invalid"; });
  assert.equal(score(row), null);
});
test("temporary-ID graph state is not backdated without complete independent history", () => {
  const row = fixture();
  row.graph.forEach(edge => { edge.historyComplete = false; });
  assert.equal(score(row, "linked-children"), null);
  row.graph.forEach(edge => {
    edge.historyComplete = true;
    edge.events = [{ action: "added", at: "2026-10-11T00:00:00Z" }];
    edge.observedAt = "2026-10-12T00:00:00Z";
  });
  assert.equal(score(row, "linked-children"), 0);
});
test("temporary-ID missing summary receipt does not erase demonstrated references or graph edges", () => {
  const row = fixture();
  row.comment.lastEditedAt = "2026-10-11T00:00:00Z";
  assert.equal(score(row, "accepted-triplets"), null);
  row.comment = null;
  assert.equal(score(row), 6);
  assert.equal(score(row, "linked-children"), 2);
  assert.equal(score(row, "accepted-triplets"), null);
});
test("temporary-ID unresolved placeholder text cannot establish full acceptance beside correct references", () => {
  const row = fixture();
  row.bodies[0].body += "\nUnresolved extra reference: #aw_test03";
  assert.equal(score(row), 6);
  assert.equal(score(row, "accepted-triplets"), 0);
});
test("temporary-ID score distinguishes unknown, zero and malformed populations", () => {
  assert.equal(scoreTemporaryId("resolved-references", { valid: true, assessments: [] }), null);
  const row = { id: "1", references: Array(6).fill(null) };
  assert.equal(scoreTemporaryId("resolved-references", { valid: true, assessments: [row] }), null);
  row.references = Array(6).fill(false);
  assert.equal(scoreTemporaryId("resolved-references", { valid: true, assessments: [row] }), 0);
  assert.equal(scoreTemporaryId("resolved-references", { valid: true, assessments: [row, row] }), null);
  row.references[0] = "success";
  assert.equal(scoreTemporaryId("resolved-references", { valid: true, assessments: [row] }), null);
});
test("temporary-ID actual retained protected receipt replays six native references, not a fixture-only measurement", () => {
  const contract = readTemporaryId(`${temporaryIdDirectory}/contract.json`);
  const [result] = collectTemporaryId([{ windowStart: "2026-10-17T00:00:00Z",
    windowEnd: "2026-10-18T15:00:12Z", observedAt: "2026-10-19T00:00:00Z" }], contract);
  assert.equal(scoreTemporaryId("resolved-references", result.evidence), 6);
  assert.equal(scoreTemporaryId("linked-children", result.evidence), 2);
  assert.equal(scoreTemporaryId("accepted-triplets", result.evidence), null);
  assert.ok(result.provenance.some(row => row.kind === "protected-receipt-body-graph-join"));
});
test("temporary-ID coordinated native readback establishes all six retained mapped triplets without requiring editable discovery markers", () => {
  const contract = readTemporaryId(`${temporaryIdDirectory}/contract.json`);
  const [result] = collectTemporaryId([{ windowStart: contract.adoption.adoptedAt,
    windowEnd: contract.until, observedAt: "2026-10-19T00:00:00Z" }], contract);
  assert.equal(scoreTemporaryId("resolved-references", result.evidence), 36);
  assert.equal(scoreTemporaryId("linked-children", result.evidence), 12);
  assert.equal(scoreTemporaryId("accepted-triplets", result.evidence), 3);
  assert.equal(result.evidence.coverageStatus, "partial");
  assert.ok(result.evidence.unresolvedCount > 0);
  assert.equal(result.evidence.eligibleCount, null);
  assert.equal(result.evidence.confirmedEligibleCount, 224 * 6);
  assert.equal(result.evidence.unknownEligibilityCount, 712);
});
test("temporary-ID real acquisition disappears fail-closed instead of leaving a success-shaped numeric cache", () => {
  const root = process.cwd();
  mkdirSync(".cache", { recursive: true });
  const scratch = mkdtempSync(path.join(root, ".cache", "temporary-id-test-"));
  const destination = path.join(scratch, temporaryIdDirectory);
  cpSync(temporaryIdDirectory, destination, { recursive: true });
  try {
    process.chdir(scratch);
    const contract = readTemporaryId(`${temporaryIdDirectory}/contract.json`);
    for (const name of ["protected-receipts.json.gz", "supplemental-readback.json.gz", "source-review.json.gz",
      "runtime-source-review.json.gz", "github-graph-008.json.gz"]) {
      const file = `${temporaryIdDirectory}/${name}`;
      renameSync(file, `${file}.absent`);
      assert.throws(() => collectTemporaryId([{ windowStart: "2026-10-17T00:00:00Z",
        windowEnd: "2026-10-18T15:00:12Z" }], contract), /ENOENT/);
      renameSync(`${file}.absent`, file);
    }
  } finally {
    process.chdir(root);
    rmSync(scratch, { recursive: true, force: true });
  }
});
test("temporary-ID retained mapping and graph projections cannot be replaced by self-authored claims", () => {
  const root = process.cwd();
  mkdirSync(".cache", { recursive: true });
  const scratch = mkdtempSync(path.join(root, ".cache", "temporary-id-test-"));
  cpSync(temporaryIdDirectory, path.join(scratch, temporaryIdDirectory), { recursive: true });
  try {
    process.chdir(scratch);
    const contract = readTemporaryId(`${temporaryIdDirectory}/contract.json`);
    const originalIndex = readTemporaryId(`${temporaryIdDirectory}/index.json`);
    const part = originalIndex.partitions.find(part => readTemporaryId(`${temporaryIdDirectory}/${part.file}`)
      .some(row => row.id === "38985626961:1"));
    const originalRows = readTemporaryId(`${temporaryIdDirectory}/${part.file}`);
    for (const [mutate, error] of [
      [row => { row.mapping[0].number++; }, /identity differs from its protected map/],
      [row => { row.graph[0].currentLinked = !row.graph[0].currentLinked; }, /graph projection differs/],
    ]) {
      const index = structuredClone(originalIndex);
      const rows = structuredClone(originalRows);
      mutate(rows.find(row => row.id === "38985626961:1"));
      index.partitions.find(item => item.file === part.file).sha256 = hashTemporaryId(rows);
      writeFileSync(`${temporaryIdDirectory}/${part.file}`, gzipSync(JSON.stringify(rows)));
      writeFileSync(`${temporaryIdDirectory}/index.json`, JSON.stringify(index));
      assert.throws(() => collectTemporaryId([{ windowStart: "2026-10-17T00:00:00Z",
        windowEnd: "2026-10-18T15:00:12Z" }], contract), error);
    }
  } finally {
    process.chdir(root);
    rmSync(scratch, { recursive: true, force: true });
  }
});
