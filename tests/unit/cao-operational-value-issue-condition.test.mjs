import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectIssueConditionHistory, normalizeIssueCondition, readIssueConditionHistory } from "../../scripts/collect-issue-condition-history.mjs";
import { issueConditionEvidence, nativeIssueConditionModule, replayIssueCondition, scoreIssueConditionMetric } from "../../scripts/native-issue-condition-value.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "../../scripts/operational-value-census-io.mjs";

const at = day => `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`;
const event = (day, type) => ({ id: `event-${day}`, type, at: at(day) });
const issue = (events, terminal = { state: "OPEN", labels: 0, assignees: 0 }) => ({
  id: "I_issue", number: 1, createdAt: at(1), available: true, events, terminal,
});
const window = (start, end) => ({ windowStart: at(start), windowEnd: at(end) });

test("native issue credit is a first-label coverage gain, not every label action", () => {
  const history = replayIssueCondition(issue([event(2, "LabeledEvent"), event(3, "LabeledEvent"),
    event(4, "UnlabeledEvent"), event(5, "UnlabeledEvent")]));
  assert.equal(history.known, true);
  assert.deepEqual(history.events.map(row => row.value), [1, -1]);
  const beforeWithdrawal = issueConditionEvidence([history], window(1, 5));
  assert.equal(scoreIssueConditionMetric("native-net", beforeWithdrawal), 1);
  assert.equal(scoreIssueConditionMetric("native-net", issueConditionEvidence([history], window(5, 6))), -1);
  assert.equal(scoreIssueConditionMetric("native-net", issueConditionEvidence([history], window(1, 6))), 0);
  assert.equal(beforeWithdrawal.observedUnlabeledOpen, 0);
});

test("historical state and assignment, not current labels, determine eligibility", () => {
  const row = issue([event(2, "AssignedEvent"), event(3, "LabeledEvent"), event(4, "UnassignedEvent"),
    event(5, "UnlabeledEvent"), event(6, "ClosedEvent"), event(7, "LabeledEvent"),
    event(8, "ReopenedEvent")], { state: "OPEN", labels: 1, assignees: 0 });
  assert.deepEqual(replayIssueCondition(row, false).events.map(event => event.value), [1, -1]);
  assert.deepEqual(replayIssueCondition(row, true).events.map(event => event.value), [-1]);
  const beforeFirstLabel = issueConditionEvidence([replayIssueCondition(row)], window(1, 3));
  assert.equal(beforeFirstLabel.observedUnlabeledPercent, 100);
  assert.equal(beforeFirstLabel.eventCount, 0);
  assert.equal(issueConditionEvidence([replayIssueCondition(row)], window(6, 8)).observedEligibleOpen, 0);
});

test("missing and unreconciled histories cannot create zero native totals", () => {
  const good = replayIssueCondition(issue([event(2, "LabeledEvent")], { state: "OPEN", labels: 1, assignees: 0 }));
  const unknown = replayIssueCondition(issue([], { state: "OPEN", labels: 1, assignees: 0 }));
  assert.equal(unknown.known, false);
  assert.equal(replayIssueCondition(issue([event(2, "TransferredEvent")])).known, false);
  const evidence = issueConditionEvidence([good, unknown], window(1, 4));
  assert.equal(scoreIssueConditionMetric("native-net", evidence), null);
  assert.equal(scoreIssueConditionMetric("observed-native-net", evidence), 1);
  assert.equal(scoreIssueConditionMetric("observed-native-net", issueConditionEvidence([unknown], window(1, 4))), null);
  assert.equal(scoreIssueConditionMetric("observed-native-net", { ...evidence, eventCount: 99 }), null);
  assert.equal(scoreIssueConditionMetric("observed-native-net", { ...evidence, eventLedgerSha256: "" }), null);
  assert.throws(() => replayIssueCondition(issue([event(2, "LabeledEvent"), event(2, "LabeledEvent")])), /Malformed/);
});

test("issue normalization retains only condition facts and rejects missing timeline pages", () => {
  const identity = { id: "I_issue", number: 1, createdAt: at(1) };
  const node = { ...identity, updatedAt: at(3), repository: { databaseId: 7 }, state: "OPEN",
    labels: { totalCount: 1 }, assignees: { totalCount: 0 }, timelineItems: { totalCount: 1 } };
  const events = [{ id: "E_one", __typename: "LabeledEvent", createdAt: at(2), actor: { login: "must-not-retain" } }];
  const normalized = normalizeIssueCondition(identity, node, events, at(4), 7);
  assert.ok(!JSON.stringify(normalized).includes("must-not-retain"));
  assert.equal(replayIssueCondition(normalized).known, true);
  assert.throws(() => normalizeIssueCondition(identity, node, [], at(4), 7), /completeness/);
  assert.equal(normalizeIssueCondition(identity, node, events, at(4), 8).available, false);
});

test("shared acquisition follows issue cursors, resumes digest-checked batches and never repeats completed requests", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "issue-condition-"));
  try {
    const identity = { id: "I_issue", number: 1, repository: "github/gh-aw", kind: "Issue", createdAt: at(1) };
    const partition = { file: "entities-00001.json.gz", count: 1, sha256: censusDigest([identity]) };
    writeCensusJson(path.join(root, partition.file), [identity]);
    writeCensusJson(path.join(root, "history.json.gz"), { schemaVersion: 1, kind: "workflow-output-history",
      repository: "github/gh-aw", repositoryId: 7, sourceRevision: "a".repeat(40), complete: true,
      until: "2026-10-18T15:00:12Z", partitions: [partition], workflows: [], totalEntities: 1, knownRunReferences: 0 });
    const output = path.join(root, "conditions");
    let requests = 0;
    const getJson = async query => {
      requests += 1;
      const node = { id: identity.id, number: 1, createdAt: at(1), updatedAt: at(3), state: "OPEN",
        repository: { databaseId: 7 }, labels: { totalCount: 2 }, assignees: { totalCount: 0 },
        timelineItems: { totalCount: 2, nodes: [{ id: "E_one", __typename: "LabeledEvent", createdAt: at(2) }],
          pageInfo: { hasNextPage: true, endCursor: "second-page" } } };
      if (query.includes("second-page")) return { data: { node: { id: identity.id, timelineItems: {
        totalCount: 2, nodes: [{ id: "E_two", __typename: "LabeledEvent", createdAt: at(3) }],
        pageInfo: { hasNextPage: false, endCursor: "done" } } } } };
      return { data: { nodes: [node] } };
    };
    await collectIssueConditionHistory(root, output, getJson);
    assert.equal(requests, 2);
    const archive = readIssueConditionHistory(output);
    assert.equal(archive.issues.length, 1);
    assert.equal(archive.issues[0].events.length, 2);
    assert.equal(replayIssueCondition(archive.issues[0]).known, true);
    await collectIssueConditionHistory(root, output, async () => { throw new Error("Completed history must not be fetched again"); });
    assert.equal(censusDigest(readIssueConditionHistory(output).issues), censusDigest(archive.issues));
    assert.deepEqual(readIssueConditionHistory(output).index, archive.index);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("both real issue evaluations replay native transitions and preserve the published unknowns", () => {
  const { index, issues } = readIssueConditionHistory("docs/operational-value/proof/issue-condition-history");
  assert.equal(index.issues, 34592);
  const expected = { "auto-triage-issues": 29269, "issue-triage-agent": 30048 };
  for (const contract of readCensusJson("docs/operational-value/proof/issue-condition-history/contracts.json")) {
    const module = nativeIssueConditionModule(contract);
    const request = { repository: contract.repository, windowStart: contract.adoption.adoptedAt,
      windowEnd: contract.until, observedAt: contract.until };
    const [{ evidence }] = module.collectBatch([request]);
    let nativeNet = 0;
    for (const issue of issues) {
      if (!replayIssueCondition(issue, contract.requireUnassigned).known) continue;
      let labels = 0, assignees = 0, open = true;
      for (const event of issue.events) {
        const active = open && (!contract.requireUnassigned || assignees === 0)
          && event.at >= request.windowStart && event.at < request.windowEnd;
        if (event.type === "LabeledEvent") { if (active && labels === 0) nativeNet += 1; labels += 1; }
        if (event.type === "UnlabeledEvent") { if (active && labels === 1) nativeNet -= 1; labels -= 1; }
        if (event.type === "AssignedEvent") assignees += 1;
        if (event.type === "UnassignedEvent") assignees -= 1;
        if (event.type === "ClosedEvent") open = false;
        if (event.type === "ReopenedEvent") open = true;
      }
    }
    assert.equal(nativeNet, expected[contract.workflowId]);
    assert.equal(module.scoreMetric("observed-native-net", evidence), nativeNet);
    assert.equal(module.scoreMetric("native-net", evidence), null);
    assert.equal(evidence.unknownIssues, 156);
    const timeline = JSON.parse(readFileSync(
      `docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`, "utf8"));
    for (const snapshot of timeline.snapshots.slice(-2)) {
      const [{ evidence: replayed }] = module.collectBatch([{ repository: contract.repository,
        windowStart: snapshot.window.startAt, windowEnd: snapshot.window.endAt, observedAt: snapshot.observedAt }]);
      assert.deepEqual(replayed, snapshot.evidence);
      assert.equal(module.scoreMetric("observed-native-net", replayed), snapshot.metrics["observed-native-net"]);
    }
  }
});
