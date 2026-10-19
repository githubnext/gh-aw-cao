import assert from "node:assert/strict";
import { test } from "node:test";
import { base, json, workflowCounts, extensionCounts, mappingCounts, checkNumbers,
  extractWorkflowClaims, extractExtensionClaims, cohortFacts, newIssueMembership, mainlinePrefix,
  readOriginals } from "../../scripts/native-monitoring-accuracy.mjs";
import { inspectMonitoringReport, scoreMonitoringMetric } from "../../scripts/native-monitoring-value.mjs";
import { readOutputHistory } from "../../.github/skills/add-operational-value/scripts/collect-output-history.mjs";

test("workflow scope is direct regular Markdown/lock basenames, not counts alone", () => {
  const files = ["a.md", "b.lock.yml", "shared/nested.md"].map(file => ({ path: `.github/workflows/${file}`, mode: "100644" }));
  files.push({ path: ".github/workflows/link.md", mode: "120000" });
  assert.deepEqual(workflowCounts(files), { total_workflows: 1, lockfile_count: 1, missingLocks: ["a"], extraLocks: ["b"] });
  assert.equal(extractWorkflowClaims("| **Total Workflows** | 2,314 |\n| **Lockfiles** | 2,314 |").length, 2);
  assert.equal(extractWorkflowClaims("There are 2314 workflows").length, 0);
});

test("extension counts exclude dependency directories and symlinks, not similarly named directories", () => {
  const files = ["pkg/x.test.go", "node_modules/y.go", "a/vendor/z.go", "vendorish/a.go", ".github/test.md"]
    .map(file => ({ path: file, mode: "100644" }));
  files.push({ path: "link.go", mode: "120000" });
  assert.deepEqual(extensionCounts(files), { ".go": 2, ".md": 1 });
  assert.deepEqual(extractExtensionClaims("| .go | 2,314 |\n| .md | 3 |").map(row => row.value), [2314, 3]);
});

test("mapping registrations differ from unique tools and preserve duplicate toolsets", () => {
  assert.deepEqual(mappingCounts(JSON.stringify({ toolsets: { a: { tools: ["read", "get_label"] },
    b: { tools: ["get_label"] } } })), { toolsets: 2, entries: 3, unique: 2 });
  assert.throws(() => mappingCounts('{"toolsets":{"a":{"tools":[17]}}}'), /Malformed/);
});

test("literal numeric claim correctness is exact, including boundary values", () => {
  assert.equal(checkNumbers([{ key: "a", value: 0 }], { a: 0 })[0].accepted, true);
  assert.equal(checkNumbers([{ key: "a", value: 1 }], { a: 0 })[0].accepted, false);
  assert.throws(() => checkNumbers([{ key: "a", value: -1 }], { a: 0 }), /Invalid/);
});

test("new issue listing checks actual kind and exact inclusive/exclusive UTC window", () => {
  const start = "2026-10-05T15:04:00Z", end = "2026-10-12T15:04:00Z";
  const rows = [
    { id: "a", number: 1, kind: "Issue", createdAt: start },
    { id: "b", number: 2, kind: "Issue", createdAt: end },
    { id: "c", number: 3, kind: "PullRequest", createdAt: start },
  ];
  assert.deepEqual(newIssueMembership([1, 2, 3, 4].map(number => ({ number })), rows, start, end)
    .map(row => row.accepted), [true, false, false, null]);
});

test("captured cohort requires independent timestamps, source cap and unique issue IDs", () => {
  const at = "2026-10-08T00:00:00Z", url = number => `https://github.com/github/gh-aw/issues/${number}`;
  const cohort = [{ number: 1, url: url(1), createdAt: "2026-10-01T00:00:00Z" },
    { number: 2, url: url(2), createdAt: "2026-10-01T00:00:01Z" }];
  const independent = cohort.map(row => ({ ...row, kind: "Issue" }));
  assert.deepEqual(cohortFacts(cohort, independent, at), { issues_analyzed: 2, issues_opened_7d: 1, issues_opened_30d: 2 });
  assert.throws(() => cohortFacts([cohort[0], cohort[0]], independent, at), /Malformed/);
  assert.throws(() => cohortFacts(cohort, [{ ...independent[0], createdAt: "2026-09-30T00:00:00Z" }], at), /corroboration/);
  assert.throws(() => cohortFacts(Array(1001).fill(cohort[0]), independent, at), /Invalid/);
});

test("mainline citation reference is a bounded contiguous prefix, not invented full graph", () => {
  const start = "2026-10-07T00:00:00Z", end = "2026-10-08T00:00:00Z";
  const commits = { a: { at: start, parents: ["b"] }, b: { at: "2026-10-06T23:59:59Z", parents: ["c"] } };
  assert.deepEqual(mainlinePrefix({ commit: oid => commits[oid] }, "a", start, end).rows, [{ oid: "a", at: start }]);
  assert.equal(mainlinePrefix({ commit: oid => commits[oid] }, "a", start, end).boundary, "b");
});

test("scoring does not turn missing opportunities or unknown facts into successful zero", () => {
  assert.equal(scoreMonitoringMetric("native-fact-accuracy", {}), null);
  assert.equal(scoreMonitoringMetric("native-fact-accuracy", { valid: true, eligible: 0, assessed: 0, accepted: 0 }), null);
  assert.equal(scoreMonitoringMetric("native-fact-accuracy", { valid: true, eligible: 2, assessed: 1, accepted: 1 }), 100);
  assert.equal(scoreMonitoringMetric("native-fact-coverage", { valid: true, eligible: 2, assessed: 1, accepted: 1 }), 50);
  assert.equal(scoreMonitoringMetric("native-fact-accuracy", { valid: true, eligible: 2, assessed: 1, accepted: 2 }), null);
});

test("six real original-backed reports have independently assessed native facts, not fixtures", () => {
  const originals = readOriginals(), discovery = json(`${base}discovery.json`);
  const { entities } = readOutputHistory(`${base}issue-history`);
  const measured = discovery.records.map(record => ({ slug: record.slug,
    evidence: inspectMonitoringReport(record, originals, entities) }));
  assert.equal(measured.length, 6);
  for (const row of measured) {
    assert.ok(row.evidence.assessed > 0, `${row.slug} must not qualify through all-null evidence`);
    assert.equal(row.evidence.fullAcceptance, null);
    assert.equal(row.evidence.contribution, null);
  }
  assert.equal(measured.find(row => row.slug === "daily-code-metrics").evidence.assessed, 2);
  assert.equal(measured.find(row => row.slug === "repo-tree-map").evidence.assessed, 10);
  assert.equal(measured.find(row => row.slug === "github-mcp-tools-report").evidence.assessed, 3);
  assert.equal(measured.find(row => row.slug === "daily-issues-report").evidence.assessed, 2);
  assert.equal(measured.find(row => row.slug === "daily-repo-chronicle").evidence.detail.sourceDurationConformance, false);
  assert.ok(measured.find(row => row.slug === "weekly-issue-summary").evidence.openingUndercountFloor > 0);
});
