import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { fileDietEvents, readFileDietProof } from "../../.github/skills/add-operational-value/examples/daily-file-diet.mjs";
import { eventPulse } from "../../.github/skills/add-operational-value/scripts/pulse-model.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha = digit => digit.repeat(40);
const file = (name, lines, blob) => ({ path: name, lines, bytes: lines * 2, blob: sha(blob) });
const adopted = sha("1"), parent = sha("2"), merged = sha("3");

function example() {
  const inventories = new Map([
    [adopted, [file("pkg/a.go", 1129, "a")]],
    [parent, [file("pkg/a.go", 1129, "a"), file("pkg/unrelated.go", 900, "b")]],
    [merged, [file("pkg/a.go", 248, "c"), file("pkg/replacement.go", 850, "d")]],
  ]);
  const issue = { id: "I_1", number: 1, targetPath: "pkg/a.go", createdAt: "2026-01-02T00:00:00Z",
    reference: { runId: "99" }, run: { validation: { headSha: adopted } },
    receipt: { status: "missing" },
    timeline: { complete: true, events: [{ type: "connected", at: "2026-01-04T00:00:00Z",
      target: { kind: "pull-request", number: 2 } }] } };
  const pull = { id: "PR_2", number: 2, createdAt: "2026-01-03T00:00:00Z",
    mergedAt: "2026-01-05T00:00:00Z", preMergeSha: parent, mergeSha: merged,
    baseSha: adopted,
    graph: { id: "PR_2", state: "MERGED", mergedAt: "2026-01-05T00:00:00Z",
      mergeCommit: merged, closingLinksComplete: true, edges: [] },
    files: [{ path: "pkg/replacement.go", status: "added" }] };
  const proof = {
    schemaVersion: 1, repository: "github/gh-aw", sourcePath: ".github/workflows/daily-file-diet.md",
    aliases: ["github/gh-aw", "githubnext/gh-aw"],
    adoption: { commit: adopted, baselineCommit: sha("0"), at: "2026-01-01T00:00:00Z" },
    until: "2026-05-01T00:00:00Z", observedAt: "2026-05-01T01:00:00Z",
    discovery: [{ complete: true }], issues: [issue], pulls: [pull],
    snapshots: [{ at: "2026-01-01T00:00:00Z", commit: adopted },
      { at: "2026-05-01T00:00:00Z", commit: merged }],
  };
  return { proof, inventories };
}

function receipt(input) {
  const issue = input.proof.issues[0];
  const content = JSON.stringify({ type: "create_issue", number: issue.number,
    repo: "github/gh-aw", url: `https://github.com/github/gh-aw/issues/${issue.number}`,
    metadata: { node_id: issue.id } });
  issue.receipt = { status: "available", runId: 99, headSha: adopted, content,
    entrySha256: createHash("sha256").update(content).digest("hex"),
    archiveSha256: "a".repeat(64), digest: `sha256:${"a".repeat(64)}` };
}

function preserve(input, directory) {
  const proof = structuredClone(input.proof);
  proof.inventoryPartitions = [...input.inventories].map(([commit, files]) => {
    const inventory = { commit, files, inventoryDigest: digest(files) };
    const filename = `inventory-${commit}.json.gz`;
    writeFileSync(path.join(directory, filename), gzipSync(JSON.stringify(inventory)));
    return { file: filename, commit, sha256: digest(inventory) };
  });
  proof.uniqueBlobs = new Set([...input.inventories.values()].flatMap(files => files.map(file => file.blob))).size;
  writeFileSync(path.join(directory, "proof.json.gz"), gzipSync(JSON.stringify(proof)));
  return proof;
}

function temporary(t) {
  mkdirSync(path.join(root, ".tmp"), { recursive: true });
  const directory = mkdtempSync(path.join(root, ".tmp", "file-diet-replay-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("File Diet measures actual merge-parent inventories and replacement files, not output volume", () => {
  const input = example();
  const ledger = fileDietEvents(input);
  assert.equal(ledger.events.length, 1);
  assert.equal(ledger.events[0].value, 1);
  assert.equal(ledger.events[0].at, input.proof.pulls[0].mergedAt);
  assert.equal(ledger.events[0].acceptance.ref, merged);
  assert.match(ledger.events[0].evidence[1].url, new RegExp(`${parent}$`));
  assert.equal(eventPulse(ledger).metrics[0].receiptTotal, 0);
  assert.match(ledger.intent.acceptance, /full behavior-preserving acceptance remains unknown/);
  delete input.proof.pulls[0].preMergeSha;
  assert.throws(() => fileDietEvents(input), /Missing immutable inventory/);
});

test("unmerged proposals, later connections and disconnected links do not become deliveries", () => {
  for (const change of [
    input => { input.proof.pulls[0].mergedAt = null; },
    input => { input.proof.issues[0].timeline.events[0].at = "2026-01-06T00:00:00Z"; },
    input => { input.proof.issues[0].timeline.events.push({
      ...input.proof.issues[0].timeline.events[0], type: "disconnected", at: "2026-01-04T12:00:00Z",
    }); },
  ]) {
    const input = example();
    change(input);
    assert.equal(fileDietEvents(input).events.length, 0);
  }
});

test("retained undated closing declarations are explicit corroboration, not invented dated proof", () => {
  const input = example();
  input.proof.issues[0].timeline.events = [];
  input.proof.pulls[0].graph.edges = [{ relation: "declares-closing", target: { id: "I_1" } }];
  const ledger = fileDietEvents(input);
  assert.equal(ledger.events[0].attribution, "corroborated");
  assert.match(ledger.limitations[1], /1 retained closing links lack a dated connection or closed-by event/);
});

test("keyword-linked issues retain dated closer evidence even without connected events", () => {
  const input = example();
  const issue = input.proof.issues[0];
  issue.timeline.events = [];
  issue.graph = { edges: [
    { relation: "referenced-by", at: "2026-01-04T00:00:00Z", target: { id: "PR_2" } },
    { relation: "closed-by", at: "2026-01-05T00:00:01Z", target: { id: "PR_2" } },
  ] };
  input.proof.pulls[0].graph.edges = [{ relation: "declares-closing", target: { id: "I_1" } }];
  const ledger = fileDietEvents(input);
  assert.equal(ledger.events.length, 1);
  assert.equal(ledger.events[0].at, "2026-01-05T00:00:00Z");
  assert.deepEqual(ledger.events[0].lineage.map(edge => [edge.relation, edge.at]), [
    ["referenced-by", "2026-01-04T00:00:00Z"], ["closed-by", "2026-01-05T00:00:01Z"],
  ]);
  assert.ok(!ledger.limitations.some(note => note.includes("lack a dated")));
  assert.equal(eventPulse(ledger).metrics[0].observedTotal, 1);
  for (const change of [
    edge => { edge.at = "2026-05-02T00:00:00Z"; },
    edge => { edge.target.id = "another-PR"; },
  ]) {
    const altered = structuredClone(input);
    change(altered.proof.issues[0].graph.edges[1]);
    assert.ok(fileDietEvents(altered).limitations.some(note => note.includes("lack a dated")));
  }
});

test("missing discovery or relationship coverage cannot produce a complete-period zero", () => {
  for (const change of [
    input => { input.proof.discovery = []; },
    input => { input.proof.discovery[0].complete = false; },
    input => { input.proof.issues[0].timeline.complete = false; },
    input => { input.proof.pulls[0].graph.closingLinksComplete = false; },
  ]) {
    const input = example();
    change(input);
    const model = eventPulse(fileDietEvents(input));
    assert.equal(model.metrics[0].observedTotal, 1);
    assert.equal(model.metrics[0].completeTotal, null);
    assert.equal(model.signal.status, "insufficient-evidence");
  }
});

test("creation receipts strengthen attribution without changing measured value or delivery time", () => {
  const input = example();
  const before = fileDietEvents(input);
  receipt(input);
  const after = fileDietEvents(input);
  assert.equal(after.events[0].value, before.events[0].value);
  assert.equal(after.events[0].at, before.events[0].at);
  assert.equal(eventPulse(after).metrics[0].receiptTotal, 1);
  input.proof.issues[0].receipt.runId = 100;
  assert.throws(() => fileDietEvents(input), /99/);
});

test("merged identities and acceptance revisions must agree", () => {
  for (const key of ["id", "state", "mergeCommit", "mergedAt"]) {
    const input = example();
    input.proof.pulls[0].graph[key] = "not-the-accepted-value";
    assert.throws(() => fileDietEvents(input), /mismatch|not merged/);
  }
});

test("preserved File Diet replay is self-contained and fails closed on altered input", t => {
  const directory = temporary(t);
  const input = example();
  receipt(input);
  const proof = preserve(input, directory);
  const restored = readFileDietProof(directory);
  assert.equal(fileDietEvents(restored).events[0].value, 1);
  const report = path.join(directory, "output", "pulse.html");
  execFileSync(process.execPath, [
    path.join(root, ".github/skills/add-operational-value/examples/daily-file-diet.mjs"), directory, report,
  ], { env: { ...process.env, PATH: "", GH_TOKEN: "", GITHUB_TOKEN: "" } });
  assert.match(readFileSync(report, "utf8"), /<!doctype html>/);
  const pulse = JSON.parse(readFileSync(report.replace(".html", ".json"), "utf8"));
  assert.equal(pulse.metrics[0].observedTotal, 1);
  assert.equal(pulse.metrics[0].receiptTotal, 1);
  assert.ok(JSON.parse(readFileSync(report.replace(".html", "-events.json"), "utf8")).intent);
  proof.inventoryPartitions[0].sha256 = "0".repeat(64);
  writeFileSync(path.join(directory, "proof.json.gz"), gzipSync(JSON.stringify(proof)));
  assert.throws(() => readFileDietProof(directory), /partition digest mismatch/);
});

test("inventory paths, native blob facts and repository identities cannot be substituted", t => {
  const directory = temporary(t);
  for (const change of [
    input => { input.proof.repository = "somewhere/else"; },
    input => { input.inventories.get(parent)[0].path = "pkg/a_test.go"; },
    input => { input.inventories.get(parent)[0].lines = 900; },
  ]) {
    const input = example();
    change(input);
    preserve(input, directory);
    assert.throws(() => readFileDietProof(directory), /AssertionError|Conflicting|Invalid/);
  }
});
