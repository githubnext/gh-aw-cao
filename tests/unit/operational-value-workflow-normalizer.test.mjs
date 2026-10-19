import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readJsonArchive } from "../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { collectBatch, definition, scoreMetric } from "../../docs/operational-value/proof/functions/workflow-normalizer.mjs";
import { assessNativeRepairs, fixtureIssue, gitBlob, inspectReportRepair, sha256 } from "../../docs/operational-value/proof/workflow-normalizer/native.mjs";

const metric = definition.metrics[0].id;
const { targetAttained, targetMissed } = definition.validationExamples;
const repaired = targetAttained.records[0];
const check = (before, after) => inspectReportRepair(fixtureIssue(before), fixtureIssue(after));
const window = {
  windowStart: "2026-10-19T10:31:43Z",
  windowEnd: "2026-10-20T10:31:43Z",
  observedAt: "2026-10-20T10:31:43Z",
};

test("schema3 examples are explicit native syntax fixtures, never production receipts", () => {
  assert.equal(definition.schemaVersion, 3);
  assert.equal(scoreMetric(metric, targetAttained), 1);
  assert.equal(scoreMetric(metric, targetMissed), 0);
  assert.equal(scoreMetric(metric, definition.validationExamples.missing), null);
  assert.equal(scoreMetric(metric, definition.validationExamples.malformed), null);
  assert.equal(scoreMetric("not-a-metric", targetAttained), null);
  assert.equal(targetAttained.kind, "validation-fixture-only");
  assert.equal(definition.intent.temporalAnchor, "contract-activation");
});

test("native partial style repairs survive unknown full readability", () => {
  const result = inspectReportRepair(repaired.before, repaired.after);
  assert.equal(result.status, "partial-style-repair");
  assert.equal(result.contentPreserved, true);
  assert.deepEqual(result.facets, ["headingHierarchy", "boldSummary", "runReference"]);
  assert.equal(result.fullAcceptance, null);
});

test("each native facet has its own defining byte evidence", () => {
  assert.equal(check("# Summary\n", "### Summary\n").status, "partial-style-repair");
  assert.equal(check("<details>\n<summary>Evidence</summary>\n\nLogs\n</details>\n",
    "<details>\n<summary><b>Evidence</b></summary>\n\nLogs\n</details>\n").status, "partial-style-repair");
  assert.equal(check("[123](https://github.com/github/gh-aw/actions/runs/123)\n",
    "[§123](https://github.com/github/gh-aw/actions/runs/123)\n").status, "partial-style-repair");
});

test("h3 presence, fewer headings and suggestions alone do not prove repair", () => {
  assert.equal(check("### Summary\n\nDelete user data.\n", "### Summary\n\nDelete user data.\n").status, "not-established");
  assert.equal(check("# Summary\n\nCritical warning.\n", "### Summary\n").status, "not-established");
  assert.equal(check("# Summary\n", "### A clearer report with more suggestions.\n").status, "not-established");
});

test("relative heading hierarchy cannot be flattened as a style repair", () => {
  assert.equal(check("# Summary\n## Detail\n", "### Summary\n### Detail\n").status, "not-established");
  assert.equal(check("# Summary\n## Detail\n", "### Summary\n#### Detail\n").status, "partial-style-repair");
});

test("a regressed native facet prevents acceptance of the joint edit", () => {
  const before = "# Summary\n\n[§123](https://github.com/github/gh-aw/actions/runs/123)\n";
  const after = "### Summary\n\n[123](https://github.com/github/gh-aw/actions/runs/123)\n";
  const result = check(before, after);
  assert.equal(result.status, "not-established");
  assert.deepEqual(result.regressions, ["runReference"]);
});

test("run labels must bind exactly the same canonical repository and numeric run", () => {
  for (const after of [
    "[§124](https://github.com/github/gh-aw/actions/runs/124)\n",
    "[§124](https://github.com/github/gh-aw/actions/runs/123)\n",
    "[§123](https://github.com/other/repo/actions/runs/123)\n",
    "[§123](https://github.com/github/gh-aw/actions/runs/123?token=not-a-real-token)\n",
  ]) {
    assert.notEqual(check("[123](https://github.com/github/gh-aw/actions/runs/123)\n", after).status, "partial-style-repair");
  }
});

test("fenced examples are preserved literally and never counted as report headers", () => {
  assert.equal(check("```markdown\n# Example\n```\n", "```markdown\n### Example\n```\n").status, "not-established");
  assert.equal(check("```markdown\n# Example\n```\n\n# Summary\n",
    "```markdown\n# Example\n```\n\n### Summary\n").status, "partial-style-repair");
});

test("unsupported, unbalanced or malformed markup is unknown rather than clean", () => {
  for (const body of [
    "Summary\n=======\n", "    # Indented code\n", "<details>\n<summary>x</summary>\n",
    "```\n# incomplete fence\n", "<script>alert(1)</script>\n",
    "<details>\n<summary>outer</summary>\n<details>\n<summary>inner</summary>\n</details>\n</details>\n",
    "# Summary\r\n", "# Summary\0\n", "# Summary\n<!-- hidden -->\n",
  ]) assert.equal(check(body, body).status, "unknown");
});

test("report identity is native, while actors have no influence on the facet", () => {
  const left = { ...repaired.before, user: { type: "User", login: "fixture-author" } };
  const right = { ...repaired.after, user: { type: "Bot", login: "fixture-automation" } };
  assert.equal(inspectReportRepair(left, right).status, "partial-style-repair");
  assert.throws(() => inspectReportRepair(left, { ...right, id: 2 }), /identity/);
  assert.throws(() => inspectReportRepair(left, { ...right, html_url: "https://github.com/other/repo/issues/1" }), /subject/);
  assert.throws(() => inspectReportRepair(left, { ...right, pull_request: {} }), /subject/);
});

test("booleans, native counts, copied example claims and agent receipts are not protected producer evidence", () => {
  const claims = {
    key: definition.evidence.key, eligibleCount: 1, accepted: true, verified: true,
    protectedProducer: true, contentPreserved: true, repairCount: 1, readable: true,
    before: repaired.before, after: repaired.after,
  };
  assert.equal(scoreMetric(metric, claims), null);
  assert.equal(scoreMetric(metric, { ...targetAttained, accepted: true }), null);
  assert.equal(scoreMetric(metric, { ...targetAttained, kind: "production" }), null);
});

test("delivery counts distinct native subjects at inclusive/exclusive disjoint boundaries", () => {
  const first = { ...repaired, editedAt: "2026-10-19T10:31:43Z" };
  const second = { ...repaired, editedAt: "2026-10-20T10:31:43Z" };
  const left = assessNativeRepairs([first, second], window.windowStart, window.windowEnd);
  const right = assessNativeRepairs([first, second], window.windowEnd, "2026-10-21T10:31:43Z");
  assert.equal(left.demonstratedReports, 1);
  assert.equal(right.demonstratedReports, 1);
  assert.equal(left.facts.length, 1);
  assert.equal(right.facts.length, 1);
  assert.equal(assessNativeRepairs([first, { ...first, editedAt: "2026-10-19T12:00:00Z" }],
    window.windowStart, window.windowEnd).demonstratedReports, 1);
  assert.throws(() => assessNativeRepairs([first, first], window.windowStart, window.windowEnd), /Repeated/);
});

test("collector retains production unknowns instead of discovery-derived zeros", () => {
  const [collected] = collectBatch([window], { database: "not-read-without-authoritative-report-facts" });
  assert.equal(scoreMetric(metric, collected.evidence), null);
  assert.equal(collected.evidence.eligibleCount, null);
  assert.equal(collected.evidence.populationDigest, null);
  assert.equal(collected.evidence.partialStyleRepairs, null);
  assert.equal(collected.evidence.contribution.value, null);
  assert.equal(collected.evidence.fullAcceptance.value, null);
  assert.equal(collected.evidence.coverageStatus, "unknown");
  assert.match(collected.evidence.missingReason, /unacquired/);
  assert.equal(collected.evidence.discovery.partitions, 346);
  assert.equal(collected.evidence.discovery.totalEntities, 58048);
  assert.equal(collected.evidence.discovery.selectedCandidates, 267);
  assert.equal(collected.provenance.length, 3);
  assert.notEqual(collected.evidence.kind, "validation-fixture-only");
});

test("batched disjoint periods remain unavailable in order, with no fabricated full-period coverage", () => {
  const second = { ...window, windowStart: window.windowEnd,
    windowEnd: "2026-10-21T10:31:43Z", observedAt: "2026-10-21T10:31:43Z" };
  const results = collectBatch([second, window]);
  assert.equal(results[0].evidence.windowStart, second.windowStart);
  assert.equal(results[1].evidence.windowStart, window.windowStart);
  assert.deepEqual(results.map(result => scoreMetric(metric, result.evidence)), [null, null]);
  assert.deepEqual(collectBatch([]), []);
});

test("current-source scope is never backdated or described as exhausted history", () => {
  const [result] = collectBatch([{
    windowStart: "2026-10-17T15:00:12Z", windowEnd: "2026-10-18T15:00:12Z",
    observedAt: "2026-10-18T15:00:12Z",
  }]);
  assert.equal(result.evidence.missingReason, "current-source-profile-not-a-historical-contract");
  assert.equal(scoreMetric(metric, result.evidence), null);
  assert.equal(definition.adoption.baselineCommit, null);
  assert.match(definition.evaluation.reason, /unacquired, not exhausted/);
});

test("invalid repositories and windows fail explicitly", () => {
  for (const request of [
    { ...window, repository: "other/repo" }, { ...window, windowEnd: window.windowStart },
    { ...window, windowStart: "not-a-date" }, { ...window, observedAt: "2026-10-18T00:00:00Z" },
  ]) assert.throws(() => collectBatch([request]), /repository\/window/);
});

test("retained full original native source bytes match both Git and SHA256 identities", () => {
  const file = new URL("../../docs/operational-value/proof/workflow-normalizer/native-scope.json.gz", import.meta.url);
  assert.equal(sha256(readFileSync(file)), definition.nativeContract.scopeSha256);
  const scope = readJsonArchive(fileURLToPath(file));
  assert.equal(scope.sources.length, 6);
  for (const source of scope.sources) {
    const bytes = Buffer.from(source.content, "base64");
    assert.equal(bytes.length, source.bytes);
    assert.equal(sha256(bytes), source.sha256);
    assert.equal(gitBlob(bytes), source.gitBlob);
  }
  assert.equal(scope.sources[0].gitBlob, definition.nativeContract.workflowBlob);
  assert.deepEqual(scope.production.records, []);
});
