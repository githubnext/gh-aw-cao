import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  deliveredInPeriod, lifecycle, loadInputs, verifyContribution, verifyParent, verifyPullRequest,
} from "../../scripts/native-cleanup-outcomes.mjs";

const repositoryId = 1036865607;
const prefix = "https://api.github.com/repos/github/gh-aw/issues/";
const entity = (number, closed = "2026-10-10T12:00:00Z") => ({
  id: number * 100, number, url: `${prefix}${number}`,
  created_at: "2026-01-01T00:00:00Z", state: closed ? "closed" : "open",
  closed_at: closed, state_reason: closed ? "completed" : null,
});
const event = (id, type, time, extra = {}) => ({ id, event: type, created_at: time, ...extra });
function parentFixture() {
  const parent = entity(1);
  const child = entity(2, "2026-10-09T12:00:00Z");
  return {
    parent,
    events: [
      event(1, "sub_issue_added", "2026-10-08T12:00:00Z", { sub_issue: {
        number: 2, repository: { id: repositoryId, full_name: "github/gh-aw", private: false },
      } }),
      event(2, "closed", parent.closed_at),
    ],
    children: [child],
    histories: { 2: { entity: child, events: [event(3, "closed", child.closed_at)] } },
  };
}

test("parent acceptance needs independent graph and every historical child closed", () => {
  const input = parentFixture();
  const result = verifyParent(input);
  assert.equal(result.status, "accepted");
  assert.equal(result.childCount, 1);
  assert.equal(verifyParent({ ...input, histories: {} }).status, "unknown");
  const open = entity(2, null);
  assert.equal(verifyParent({ ...input, children: [open],
    histories: { 2: { entity: open, events: [] } } }).status, "unknown");
  assert.equal(verifyParent({ ...input, children: [] }).status, "unknown");
  assert.equal(verifyParent({ ...input, events: input.events.slice(1), children: [] }).status, "unknown");
});

test("current closed children cannot backdate future completion; same-second ordering is unknown", () => {
  for (const time of ["2026-10-11T00:00:00Z", "2026-10-10T12:00:00Z"]) {
    const input = parentFixture();
    input.children[0].closed_at = time;
    input.histories[2].events[0].created_at = time;
    assert.equal(verifyParent(input).status, "unknown");
  }
});

test("graph removals, reopens, foreign identities and terminal contradictions fail closed", () => {
  const original = parentFixture();
  const mutate = fn => {
    const input = structuredClone(original);
    fn(input);
    assert.equal(verifyParent(input).status, "unknown");
  };
  mutate(input => { input.events[0].sub_issue.repository.private = true; });
  mutate(input => { input.events[0].sub_issue.repository.id = 7; });
  mutate(input => { input.events[0].event = "sub_issue_removed"; });
  mutate(input => { input.events[0].created_at = input.parent.closed_at; });
  mutate(input => { input.parent.closed_at = "2026-10-11T00:00:00Z"; });
  mutate(input => {
    input.histories[2].events.push(event(4, "reopened", "2026-10-09T13:00:00Z"));
    input.histories[2].events.push(event(5, "closed", "2026-10-11T00:00:00Z"));
    input.children[0].closed_at = "2026-10-11T00:00:00Z";
  });
  const removed = parentFixture();
  removed.events.unshift(event(9, "sub_issue_removed", "2026-10-01T12:00:00Z",
    { sub_issue: removed.events[0].sub_issue }));
  assert.equal(verifyParent(removed).status, "unknown");
});

test("duplicate acquisition does not duplicate delivery; intervals are disjoint and end-exclusive", () => {
  const input = parentFixture();
  input.events.push(structuredClone(input.events[1]));
  const result = verifyParent(input);
  assert.equal(result.status, "accepted");
  assert.equal(deliveredInPeriod([result, result], "2026-10-01T00:00:00Z", result.deliveredAt).length, 0);
  assert.equal(deliveredInPeriod([result, result], result.deliveredAt, "2026-10-11T00:00:00Z").length, 1);
  const later = { ...result, eventId: 55, deliveredAt: "2026-10-12T00:00:00Z" };
  assert.equal(deliveredInPeriod([result, later], "2026-10-11T00:00:00Z", "2026-10-13T00:00:00Z").length, 0);
});

test("merged/closed PR or cleanup prose alone cannot establish native acceptance", () => {
  const pr = { ...entity(10), url: "https://api.github.com/repos/github/gh-aw/pulls/10",
    merged_at: null, base: { ref: "main", repo: { id: repositoryId, private: false } } };
  const events = [event(7, "closed", pr.closed_at)];
  const input = { slug: "draft-pr-cleanup", pr, events };
  assert.equal(verifyPullRequest(input).status, "unknown");
  const snapshot = { repositoryId, number: 10, state: "open", draft: true, labels: [],
    capturedAt: "2026-10-10T11:59:59Z", updatedAt: "2026-09-01T00:00:00Z",
    activityAt: ["2026-09-01T00:00:00Z"] };
  assert.equal(verifyPullRequest({ ...input, snapshot }).status, "accepted");
  assert.equal(verifyPullRequest({ ...input, snapshot: { ...snapshot, labels: ["keep-draft"] } }).status, "unknown");
  assert.equal(verifyPullRequest({ ...input, snapshot: { ...snapshot, draft: false } }).status, "unknown");
  assert.equal(verifyPullRequest({ ...input, snapshot: { ...snapshot, updatedAt: "2026-10-09T00:00:00Z" } }).status, "unknown");
  assert.equal(verifyPullRequest({ ...input, snapshot, pr: { ...pr, merged_at: pr.closed_at } }).status, "unknown");
  assert.equal(verifyPullRequest({ ...input, snapshot, events: [
    event(6, "commented", "2026-10-10T11:59:59.500Z"), ...events,
  ] }).status, "unknown");
  assert.equal(verifyPullRequest({ ...input, snapshot, slug: "stale-pr-cleanup", supersession: true }).status, "unknown");
});

test("originals replay establishes exactly two native parent closures and source/runtime/application joins", () => {
  const sha = createHash("sha256").update(readFileSync(new URL("../../docs/operational-value/proof/native-cleanup-outcomes/inputs.json", import.meta.url))).digest("hex");
  const store = loadInputs(sha);
  for (const number of [69626, 69627]) {
    const parent = store.json(`repos/github/gh-aw/issues/${number}`);
    const children = store.paged(`repos/github/gh-aw/issues/${number}/sub_issues`);
    const result = verifyParent({
      parent, children, events: store.paged(`repos/github/gh-aw/issues/${number}/timeline`),
      histories: Object.fromEntries(children.map(child => [child.number, {
        entity: child, events: store.paged(`repos/github/gh-aw/issues/${child.number}/timeline`),
      }])),
    });
    assert.equal(result.status, "accepted");
    assert.equal(result.childCount, number === 69626 ? 22 : 1);
    assert.equal(verifyContribution(store, "sub-issue-closer", result, 39104430263, 12127649313).status, "verified");
    assert.equal(verifyContribution(store, "draft-pr-cleanup", result, 39104430263, 12127649313).status, "unknown");
    assert.equal(verifyContribution(store, "sub-issue-closer", result, 39104430263, 12127649314).status, "unknown");
    const wrongSource = { ...store, source: () => null };
    assert.equal(verifyContribution(wrongSource, "sub-issue-closer", result, 39104430263, 12127649313).status, "unknown");
  }
});

test("lifecycle starts at creation, reconciles terminal state and rejects incomplete history", () => {
  const item = entity(2);
  assert.equal(lifecycle(item, [], "2026-10-09T00:00:00Z").status, "unknown");
  assert.equal(lifecycle({ ...item, state: "open" }, [event(1, "closed", item.closed_at)], item.closed_at).status, "unknown");
});

test("owned modules distinguish measured native subtotals from unknown periods and safeguards", async () => {
  for (const slug of ["stale-pr-cleanup", "draft-pr-cleanup", "sub-issue-closer"]) {
    const module = await import(`../../docs/operational-value/proof/functions/${slug}.mjs`);
    const requests = [
      { windowStart: "2026-10-11T00:00:00Z", windowEnd: "2026-10-18T00:00:00Z", observedAt: "2026-10-18T15:00:12Z" },
      { windowStart: "2026-10-18T00:00:00Z", windowEnd: "2026-10-18T15:00:12Z", observedAt: "2026-10-18T15:00:12Z" },
    ];
    const results = await module.collectBatch(requests);
    assert.deepEqual(results, await module.collectBatch(requests));
    assert.deepEqual(results.map(item => module.scoreMetric("native", item.evidence)),
      slug === "sub-issue-closer" ? [null, 2] : [null, null]);
    assert.ok(results.every(item => item.evidence.coverageStatus === "partial"
      && module.scoreMetric("full", item.evidence) === null && item.evidence.decision === "not-rated"));
    assert.equal(module.scoreMetric("native", {}), null);
    assert.equal(module.scoreMetric("native", { schemaVersion: 1, slug, native: -1 }), null);
    assert.throws(() => module.collectBatch([{ ...requests[0], repository: "private/other" }]));
    assert.throws(() => module.collectBatch([{ ...requests[0], windowEnd: "2026-10-19T00:00:00Z" }]));
    assert.throws(() => module.collectBatch([{ ...requests[0], observedAt: "2026-10-01T00:00:00Z" }]));
  }
});
