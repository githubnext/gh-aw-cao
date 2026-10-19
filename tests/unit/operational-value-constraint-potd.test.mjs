import assert from "node:assert/strict";
import test from "node:test";
import { inspectLesson, verifyInstance } from "../../scripts/native-constraint-potd-value.mjs";
import { collectBatch, definition, scoreMetric } from "../../docs/operational-value/proof/functions/constraint-solving-potd.mjs";

const metric = "verified-worked-instances";
const request = { windowStart: "2026-08-16T00:00:00Z", windowEnd: "2026-10-18T15:00:12Z",
  observedAt: "2026-10-18T15:00:12Z" };

test("real original lesson witnesses establish three mathematical partials, not four completed lessons", async () => {
  const [{ evidence }] = await collectBatch([request]);
  assert.equal(scoreMetric(metric, evidence), 3);
  assert.deepEqual(evidence.records.map(row => [row.number, row.inspection.status]),
    [[58462, "verified"], [64465, "missing"], [54778, "verified"], [57139, "verified"]]);
  assert.equal(evidence.fullAcceptance, null);
  assert.equal(evidence.contribution, null);
  assert.equal(evidence.costs, null);
  assert.ok(evidence.records.every(row => row.observedAt > request.windowEnd));
  assert.match(definition.limitations.join(" "), /not original publication-time/);
});

test("N-Queens checks board bounds, permutation and both diagonal directions", () => {
  assert.equal(verifyInstance("n-queens", { size: 4 }, [2, 4, 1, 3]), true);
  for (const witness of [[1, 2, 3, 4], [4, 3, 2, 1], [2, 4, 1, 1], [2, 4, 1, 5], [2, 4, 1]]) {
    assert.equal(verifyInstance("n-queens", { size: 4 }, witness), false);
  }
});

test("Latin-square row compliance cannot substitute for column compliance", () => {
  assert.equal(verifyInstance("latin-square", { size: 2 }, [[1, 2], [2, 1]]), true);
  assert.equal(verifyInstance("latin-square", { size: 2 }, [[1, 2], [1, 2]]), false);
  assert.equal(verifyInstance("latin-square", { size: 2, givens: [[1, 0], [0, 1]] }, [[2, 1], [1, 2]]), false);
});

test("Sudoku requires box constraints and preserved givens in addition to Latin compliance", () => {
  const solution = [[1, 2, 3, 4], [3, 4, 1, 2], [2, 1, 4, 3], [4, 3, 2, 1]];
  assert.equal(verifyInstance("sudoku", { size: 4 }, solution), true);
  const cyclic = [[1, 2, 3, 4], [2, 3, 4, 1], [3, 4, 1, 2], [4, 1, 2, 3]];
  assert.equal(verifyInstance("latin-square", { size: 4 }, cyclic), true);
  assert.equal(verifyInstance("sudoku", { size: 4 }, cyclic), false);
  assert.equal(verifyInstance("sudoku", { size: 4, givens: [[2, 0, 0, 0], ...solution.slice(1)] }, solution), false);
});

test("graph coloring binds every listed vertex, edge and declared color bound", () => {
  const instance = { vertices: ["A", "B", "C"], edges: [["A", "B"], ["B", "C"], ["C", "A"]], colors: 3 };
  assert.equal(verifyInstance("graph-coloring", instance, { A: 1, B: 2, C: 3 }), true);
  for (const witness of [{ A: 1, B: 1, C: 2 }, { A: 1, B: 2 }, { A: 1, B: 2, C: 4 },
    { A: 1, B: 2, C: 3, D: 1 }]) assert.equal(verifyInstance("graph-coloring", instance, witness), false);
});

test("explicit invalid witnesses are rejected, but claims and unsupported syntax remain missing", () => {
  const board = "For a 4×4 board, one valid solution is:\n\n```\nQ . . .\n. Q . .\n. . Q .\n. . . Q\n```";
  assert.equal(inspectLesson("n-queens", board).status, "rejected");
  assert.equal(inspectLesson("n-queens", "The agent solved N-Queens successfully.").status, "missing");
  assert.equal(inspectLesson("n-queens", `${board}\n${board}`).status, "missing");
  assert.equal(inspectLesson("unimplemented", board).status, "missing");
  assert.throws(() => inspectLesson("n-queens", null), /original lesson body/);
});

test("scoring rejects forged records and duplicate identities without erasing unknown safeguards", async () => {
  const [{ evidence }] = await collectBatch([request]);
  const duplicate = structuredClone(evidence);
  duplicate.records.push(duplicate.records[0]);
  assert.equal(scoreMetric(metric, duplicate), null);
  const altered = structuredClone(evidence);
  altered.records[0].inspection.witness[0] = 1;
  assert.equal(scoreMetric(metric, altered), null);
  assert.equal(scoreMetric("reports-created", evidence), null);
  assert.equal(scoreMetric(metric, { valid: true, records: [] }), null);
  assert.equal(scoreMetric(metric, { valid: true, records: [null] }), null);
});

test("disjoint periods allocate each worked instance once and preserve Sudoku-only and empty gaps", async () => {
  const windows = [
    ["2026-08-16T00:00:00Z", "2026-08-23T00:00:00Z"],
    ["2026-08-23T00:00:00Z", "2026-08-30T00:00:00Z"],
    ["2026-08-30T00:00:00Z", "2026-09-06T00:00:00Z"],
    ["2026-09-27T00:00:00Z", "2026-10-04T00:00:00Z"],
  ];
  const rows = await collectBatch(windows.map(([windowStart, windowEnd]) => ({ ...request, windowStart, windowEnd })));
  assert.deepEqual(rows.map(row => scoreMetric(metric, row.evidence)), [1, null, 2, null]);
  assert.equal(rows[3].evidence.records[0].inspection.kind, "sudoku");
  assert.match(rows[3].evidence.missingReason, /complete supported witness/);
  await assert.rejects(collectBatch([request], { records: [] }), /authority/);
  await assert.rejects(collectBatch([{ ...request, repository: "private/target" }]), /period/);
});
