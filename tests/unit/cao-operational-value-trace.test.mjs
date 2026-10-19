import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectOutcomeTrace, graphQuery, normalizeGraphEntity, parseWorkflowReference, readTraceArchive,
  summarizeTrace, validateRunReference, writeTraceArchive,
} from "../../scripts/trace-operational-outcomes.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "../../scripts/operational-value-census-io.mjs";

const repository = "example/project";
const since = "2026-09-01T00:00:00Z";
const until = "2026-10-01T00:00:00Z";
const observedAt = "2026-10-18T05:00:00Z";
const runUrl = `https://github.com/${repository}/actions/runs/123`;
const marker = overrides => `<!-- gh-aw-execution: ${JSON.stringify({
  version: 1, repository, aw_workflow_id: "fix-bugs", run_id: "123", run_attempt: "1", run_url: runUrl,
  ...overrides,
})} -->`;
const legacy = `<!-- gh-aw-agentic-workflow: Fix bugs, id: 123, workflow_id: fix-bugs, run: ${runUrl} -->`;
const manifest = { repository, revision: "a".repeat(40), workflows: [
  { id: "fix-bugs", path: ".github/workflows/fix-bugs.md" },
  { id: "other-goal", path: ".github/workflows/other-goal.yml" },
] };
const options = { since, until, limit: 200, requestBudget: 50 };
const reference = (number, kind = "Issue") => ({
  __typename: kind, id: `${kind}:${number}`, number,
  repository: { nameWithOwner: repository }, url: `https://github.com/${repository}/${kind === "Issue" ? "issues" : "pull"}/${number}`,
});
const entity = (number, kind = "Issue", overrides = {}) => ({
  ...reference(number, kind), body: marker(), state: "OPEN", stateReason: null,
  createdAt: "2026-09-10T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z", closedAt: null,
  timelineItems: { nodes: [], pageInfo: { hasNextPage: false } },
  ...(kind === "PullRequest" ? {
    mergedAt: null, mergeCommit: null, headRefOid: "c".repeat(40),
    closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
    commits: { nodes: [{ commit: { oid: "c".repeat(40), statusCheckRollup: { state: "SUCCESS" } } }] },
  } : {}),
  ...overrides,
});
const run = overrides => ({
  id: 123, path: ".github/workflows/fix-bugs.lock.yml", head_sha: "b".repeat(40),
  run_attempt: 1, repository: { full_name: repository }, created_at: "2026-09-10T00:00:00Z",
  html_url: runUrl, ...overrides,
});

function fixture({ reopened = false, truncated = false, closedByOther = false } = {}) {
  const pr = entity(1, "PullRequest", {
    state: "MERGED", mergedAt: "2026-09-11T00:00:00Z", mergeCommit: { oid: "d".repeat(40) },
    closingIssuesReferences: { nodes: [reference(3)], pageInfo: { hasNextPage: false } },
  });
  const issue = entity(3, "Issue", {
    state: reopened ? "OPEN" : "CLOSED", stateReason: reopened ? "REOPENED" : "COMPLETED", body: "",
    timelineItems: {
      nodes: [
        { __typename: "ClosedEvent", createdAt: "2026-09-11T00:00:01Z", closer: reference(closedByOther ? 99 : 1, "PullRequest") },
        ...(reopened ? [{ __typename: "ReopenedEvent", createdAt: "2026-09-12T00:00:00Z" }] : []),
      ],
      pageInfo: { hasNextPage: truncated },
    },
  });
  const nodes = new Map([[1, pr], [3, issue]]);
  const calls = [];
  const getJson = async (endpoint, query) => {
    calls.push({ endpoint, query });
    if (endpoint.startsWith("search/")) return {
      items: [{ number: 1, created_at: pr.createdAt }], total_count: 1, incomplete_results: false,
    };
    if (endpoint.startsWith("repos/")) return run();
    const requested = [...query.matchAll(/n(\d+): issueOrPullRequest/g)].map(match => Number(match[1]));
    return { data: { repository: Object.fromEntries(requested.map(number => [`n${number}`, nodes.get(number) ?? null])) } };
  };
  return { getJson, calls, nodes };
}

test("tracking identifies a producer and run without treating standalone tracker strings as proof", () => {
  const ref = parseWorkflowReference(`${legacy}\n${marker()}\n<!-- gh-aw-workflow-id: fix-bugs -->`, repository);
  assert.equal(ref.runId, "123");
  assert.equal(ref.attempt, 1);
  assert.equal(ref.workflowId, "fix-bugs");
  assert.equal(parseWorkflowReference(legacy, repository).attempt, null);
  assert.equal(parseWorkflowReference("<!-- gh-aw-tracker-id: fix-bugs -->", repository), null);
  assert.equal(parseWorkflowReference(`Quoted link ${runUrl}`, repository), null);
  const contributions = parseWorkflowReference(`${legacy}
<!-- gh-aw-workflow-id: fix-bugs -->
<!-- gh-aw-agentic-workflow: Review helper, id: 456, workflow_id: review-helper, run: ${runUrl.replace("123", "456")} -->`, repository);
  assert.equal(contributions.workflowId, "fix-bugs");
  assert.equal(contributions.additionalRunReferences[0].workflowId, "review-helper");
  for (const body of [
    marker({ repository: "other/repository" }), marker({ run_id: "999" }), marker({ run_attempt: "0" }),
    marker({ aw_workflow_id: undefined }), marker({ run_url: `${runUrl}/attempts/2` }),
    `${marker()}\n${marker({ run_id: "456", run_url: runUrl.replace("123", "456") })}`,
    `${marker()}\n<!-- gh-aw-workflow-id: different -->`,
    "<!-- gh-aw-execution: malformed -->",
  ]) assert.throws(() => parseWorkflowReference(body, repository));
});

test("a run reference must match the actual execution source, repository and exact known attempt", () => {
  const ref = parseWorkflowReference(marker(), repository);
  const validation = validateRunReference(ref, run(), manifest.workflows[0].path, repository);
  assert.equal(validation.status, "verified-run-reference");
  assert.match(validation.limitation, /not a safe-output creation receipt/);
  for (const invalid of [
    { id: 456 }, { path: ".github/workflows/unrelated.lock.yml" }, { run_attempt: 2 },
    { repository: { full_name: "other/repo" } }, { head_sha: "not-a-commit" },
  ]) assert.throws(() => validateRunReference(ref, run(invalid), manifest.workflows[0].path, repository));
});

test("GitHub facts preserve observation time, incomplete connections and the check revision", () => {
  const raw = entity(1, "PullRequest", {
    closingIssuesReferences: { nodes: [reference(3)], pageInfo: { hasNextPage: true } },
    timelineItems: { nodes: [], pageInfo: { hasNextPage: true } },
    commits: { nodes: [{ commit: { oid: "e".repeat(40), statusCheckRollup: { state: "SUCCESS" } } }] },
  });
  const normalized = normalizeGraphEntity(raw, observedAt);
  assert.equal(normalized.observedAt, observedAt);
  assert.equal(normalized.historyComplete, false);
  assert.equal(normalized.closingLinksComplete, false);
  assert.equal(normalized.headChecks.matchesCurrentHead, false);
  assert.match(normalized.headChecks.scope, /not-required-regression-proof/);
  assert.equal(Object.hasOwn(normalized, "body"), false);
  assert.throws(() => graphQuery('repo/unsafe"mutation', [1]), /Invalid bounded/);
  assert.throws(() => graphQuery(repository, Array.from({ length: 11 }, (_, i) => i + 1)), /Invalid bounded/);
  const query = graphQuery(repository, [1]);
  const issueFragment = query.slice(query.indexOf("... on Issue"), query.indexOf("... on PullRequest { id number url repository", query.indexOf("... on Issue") + 20));
  assert.doesNotMatch(issueFragment, /MERGED_EVENT|on MergedEvent/);
});

test("downstream reconstruction follows explicit closing links but does not manufacture operational value", async () => {
  const source = fixture();
  const trace = await collectOutcomeTrace(manifest, options, source.getJson, () => observedAt);
  assert.equal(trace.entities.length, 2);
  assert.equal(trace.summary.totals.verifiedRunReferences, 1);
  assert.equal(trace.summary.totals.mergedPullRequests, 1);
  assert.equal(trace.summary.totals.mergedAndExplicitlyClosedCompletedIssueLinks, 1);
  assert.equal(trace.summary.workflows[0].outcomeValue, null);
  assert.equal(trace.summary.workflows[1].observedStates, null, "unobserved must not mean zero value");
  assert.equal(source.calls.filter(call => call.endpoint.startsWith("repos/")).length, 1);
  assert.equal(source.calls.filter(call => call.endpoint === "graphql").length, 2);
  for (const variant of [{ reopened: true }, { truncated: true }, { closedByOther: true }]) {
    const changed = fixture(variant);
    const result = await collectOutcomeTrace(manifest, options, changed.getJson, () => observedAt);
    assert.equal(result.summary.totals.mergedAndExplicitlyClosedCompletedIssueLinks, 0);
  }
});

test("a retained inventory seeds exact identities without another search or fabricated previous trace", async () => {
  const source = fixture();
  const raw = source.nodes.get(1);
  const inventory = { index: { complete: true, repository, until, sourceRevision: manifest.revision },
    entities: [{ id: raw.id, number: 1, repository, createdAt: raw.createdAt,
      workflowReference: parseWorkflowReference(raw.body, repository),
      bodySha256: createHash("sha256").update(raw.body).digest("hex") }] };
  const getJson = async (endpoint, query) => {
    if (endpoint.startsWith("repos/")) throw new Error("Historical run expired");
    return source.getJson(endpoint, query);
  };
  const trace = await collectOutcomeTrace(manifest, { ...options, inventory }, getJson, () => observedAt);
  assert.equal(trace.discovery.mode, "retained-inventory-identities");
  assert.equal(trace.discovery.complete, true);
  assert.equal(source.calls.some(call => call.endpoint.startsWith("search/")), false);
  assert.equal(trace.entities[0].runValidation.status, "unverified");
  assert.equal(trace.entities.length, 2, "explicit graph evidence survives an expired run receipt");
  assert.equal(trace.entities[0].provenanceFromPreviousSnapshot, true);
  assert.equal(trace.summary.workflows[0].outcomeValue, null);
  await assert.rejects(collectOutcomeTrace(manifest,
    { ...options, inventory: { ...inventory, index: { ...inventory.index, sourceRevision: "b".repeat(40) } } }, getJson), /scope mismatch/);
  await assert.rejects(collectOutcomeTrace(manifest,
    { ...options, inventory: { ...inventory, entities: [...inventory.entities, ...inventory.entities] } }, getJson), /root identity/);
});

test("old footers without workflow IDs resolve through the actual run path, never a display-name guess", async () => {
  const source = fixture();
  source.nodes.get(1).body = `<!-- gh-aw-agentic-workflow: Arbitrary display name, id: 123, run: ${runUrl} -->`;
  const trace = await collectOutcomeTrace(manifest, options, source.getJson, () => observedAt);
  assert.equal(trace.entities[0].workflowReference.workflowId, "fix-bugs");
  assert.equal(trace.entities[0].workflowReference.identityResolvedFromRunPath, true);
  assert.equal(trace.summary.totals.verifiedRunReferences, 1);
  const later = await collectOutcomeTrace(manifest, { ...options, previous: trace }, source.getJson, () => observedAt);
  assert.equal(later.summary.totals.verifiedRunReferences, 1);
});

test("later follow-up reuses stable identities even when a footer disappears and preserves reopening", async () => {
  const first = fixture();
  const previous = await collectOutcomeTrace(manifest, options, first.getJson, () => observedAt);
  const later = fixture({ reopened: true });
  later.nodes.get(1).body = "";
  const trace = await collectOutcomeTrace(manifest, { ...options, previous }, later.getJson, () => "2026-10-19T05:00:00Z");
  assert.equal(later.calls.some(call => call.endpoint.startsWith("search/")), false);
  assert.equal(trace.entities[0].provenanceFromPreviousSnapshot, true);
  assert.equal(trace.summary.totals.mergedAndExplicitlyClosedCompletedIssueLinks, 0);
  assert.equal(previous.summary.totals.mergedAndExplicitlyClosedCompletedIssueLinks, 1);
  assert.equal(trace.entities.find(node => node.number === 3).events.at(-1).type, "reopened");
  await assert.rejects(collectOutcomeTrace(manifest, { ...options, until: observedAt, previous }, later.getJson), /scope mismatch/);
  later.nodes.get(1).body = marker({ run_id: "456", run_url: runUrl.replace("123", "456") });
  const conflict = await collectOutcomeTrace(manifest, { ...options, previous }, later.getJson);
  assert.match(conflict.entities[0].error, /conflicts with preserved/);
  assert.equal(conflict.summary.totals.verifiedRunReferences, 0);
});

test("search truncation, missing nodes and budget exhaustion remain explicit", async () => {
  const source = fixture();
  const limited = await collectOutcomeTrace(manifest, { ...options, limit: 1 }, async (endpoint, query) => {
    const result = await source.getJson(endpoint, query);
    return endpoint.startsWith("search/") ? { ...result, total_count: 5139 } : result;
  });
  assert.equal(limited.discovery.complete, false);
  assert.equal(limited.discovery.totalCount, 5139);
  const incompleteIndex = await collectOutcomeTrace(manifest, { ...options, limit: 1 }, async (endpoint, query) => {
    const result = await source.getJson(endpoint, query);
    return endpoint.startsWith("search/") ? { ...result, incomplete_results: true } : result;
  });
  assert.equal(incompleteIndex.discovery.complete, false);
  const partialPage = await collectOutcomeTrace(manifest, { ...options, limit: 1 }, async (endpoint, query) => {
    const result = await source.getJson(endpoint, query);
    return endpoint.startsWith("search/") ? { ...result, total_count: 2,
      items: [...result.items, { number: 2, created_at: "2026-09-11T00:00:00Z" }] } : result;
  });
  assert.equal(partialPage.discovery.complete, false);
  assert.equal(partialPage.discovery.limitExcluded, 1);
  const boundary = await collectOutcomeTrace(manifest, options, async (endpoint, query) => {
    const result = await source.getJson(endpoint, query);
    if (!endpoint.startsWith("search/")) return result;
    assert.match(decodeURIComponent(endpoint), /created:2026-09-01T00:00:00Z\.\.2026-10-01T00:00:00Z/);
    return { ...result, total_count: 2, items: [...result.items, { number: 2, created_at: until }] };
  });
  assert.equal(boundary.discovery.complete, true);
  assert.equal(boundary.discovery.boundaryExcluded, 1);
  assert.equal(boundary.summary.totals.roots, 1);
  const exhausted = await collectOutcomeTrace(manifest, { ...options, requestBudget: 1 }, source.getJson);
  assert.equal(exhausted.requestsUsed, 1);
  assert.equal(exhausted.summary.totals.entityErrors, 1);
  assert.match(exhausted.entities[0].error, /budget exhausted/);
  const unavailable = await collectOutcomeTrace(manifest, options, async (endpoint, query) =>
    endpoint === "graphql" ? { data: { repository: {} } } : source.getJson(endpoint, query));
  assert.match(unavailable.entities[0].error, /entity unavailable/);
  const denied = await collectOutcomeTrace(manifest, options, async () => { throw new Error("Permission denied"); });
  assert.deepEqual(denied.discovery.errors, ["Permission denied"]);
  assert.equal(denied.discovery.complete, false);
  const foreign = fixture();
  foreign.nodes.get(1).body = `<!-- gh-aw-agentic-workflow: Foreign control, id: 123, workflow_id: fix-bugs, run: https://github.com/other/control/actions/runs/123 -->`;
  const excluded = await collectOutcomeTrace(manifest, options, foreign.getJson);
  assert.equal(excluded.summary.totals.entityErrors, 0);
  assert.match(excluded.discovery.rejected[0].reason, /outside the explicit/);
  assert.equal(foreign.calls.some(call => call.endpoint.startsWith("repos/")), false);
});

test("archives are immutable, digest checked and replay summaries without network calls", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "operational-outcome-trace-"));
  try {
    const trace = await collectOutcomeTrace(manifest, options, fixture().getJson, () => observedAt);
    const file = path.join(directory, "observation.json.gz");
    writeTraceArchive(file, trace);
    const replay = readTraceArchive(file);
    assert.deepEqual(replay.summary, summarizeTrace(trace));
    const before = readFileSync(file);
    assert.throws(() => writeTraceArchive(file, trace), /overwrite/);
    assert.deepEqual(readFileSync(file), before);
    const index = readCensusJson(file);
    const partition = path.join(directory, index.partitions[0].file);
    const rows = readCensusJson(partition);
    rows[0].state = "OPEN";
    writeCensusJson(partition, rows);
    assert.throws(() => readTraceArchive(file), /digest/);
    index.partitions[0].file = "../escaping.json.gz";
    writeCensusJson(file, index);
    assert.throws(() => readTraceArchive(file), /Unsafe/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the frozen real follow-up replays later merge and closure facts without upgrading them to primary value", () => {
  const directory = path.resolve(import.meta.dirname, "../../docs/operational-value/gh-aw-census");
  const first = readTraceArchive(path.join(directory, "downstream-2026-10-18.json.gz"));
  const second = readTraceArchive(path.join(directory, "downstream-followup-2026-10-18.json.gz"));
  const final = readTraceArchive(path.join(directory, "downstream-final-2026-10-18.json.gz"));
  assert.equal(second.previousDigest, censusDigest(first));
  assert.equal(final.previousDigest, censusDigest(second));
  assert.equal(first.discovery.totalCount, 5605);
  assert.equal(first.discovery.complete, false);
  assert.equal(final.summary.totals.workflows, 385);
  assert.equal(final.summary.totals.workflowsWithVerifiedReferences, 108);
  assert.equal(final.summary.totals.verifiedRunReferences, 184);
  assert.equal(final.summary.totals.mergedPullRequests, 3);
  assert.equal(final.summary.totals.closedUnmergedPullRequests, 2);
  assert.equal(final.summary.totals.entityErrors, 0);
  assert.equal(final.entities.filter(row => row.kind === "Issue" && row.stateReason === "NOT_PLANNED").length, 179);
  assert.equal(final.entities.find(row => row.number === 62163).timeToMergeSeconds, 102262);
  assert.ok(final.entities.every(row => Date.parse(row.observedAt) > Date.parse(final.createdWindow.until)));
  assert.ok(final.summary.workflows.every(row => row.outcomeValue === null));
});
