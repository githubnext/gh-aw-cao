const records = (fields, tuples) => tuples.map((tuple, index) => ({
  id: `opportunity-${index}`,
  ...Object.fromEntries(fields.map((field, position) => [field, tuple[position]])),
}));
const evidence = (fields, tuples) => ({ valid: true, records: records(fields, tuples) });
const bugFields = ["closed", "merged", "regressionPassed"];
const bugBefore = evidence(bugFields, [
  [true, true, true], [true, true, true], [true, true, false],
  [false, false, false], [false, false, false],
]);
const bugAfter = evidence(bugFields, [
  [true, true, true], [true, true, true], [true, true, true],
  [true, true, true], [false, false, false],
]);
const alerts = (count) => ({
  valid: true, openSecurityAlertCount: count,
  openHighCriticalAlertCount: 0, openDependabotPullRequestCount: 0,
});
const efficiency = (aic) => ({
  eligibleWorkflowCount: 1, successfulRunCount: 10, successfulRunAicTotal: aic,
  concludedRunCount: 12, failedRunCount: 0, cancelledRunCount: 0,
  failedRunPercentagePointTotal: 0, cancelledRunPercentagePointTotal: 0,
});

export const corpus = [
  {
    id: "security-alert-backlog", source: ".github/workflows/dependabot-update-planner.md",
    grounding: "Dependabot", goal: "Reduce unresolved dependency security risk.",
    disposition: "measurable", kind: "production",
    module: "dependabot/operational-value/dependabot-update-planner.mjs",
    metric: "open-security-alert-count",
    acceptance: "Complete lifecycle evidence establishes the number of alerts still open at the cutoff.",
    before: alerts(8), after: alerts(0), beforeValue: 8, afterValue: 0, gain: 8,
    extra: [
      { name: "complete-zero", evidence: alerts(0), expected: 0 },
      { name: "invalid-count", evidence: alerts(-1), expected: null },
    ],
    expectedValidation: { targetAttained: 0, targetMissed: 8, missing: null, malformed: null },
  },
  {
    id: "native-ai-credit-efficiency", source: ".github/workflows/optimization-token-optimizer.md",
    grounding: "preserving reliability and accepted outcome quality",
    goal: "Reduce native AI Credit per successful run without disguising reliability deterioration.",
    disposition: "measurable", kind: "production",
    module: "optimization/operational-value/optimization-token-optimizer.mjs",
    metric: "aic-per-successful-run",
    acceptance: "Eligible successful runs have complete authoritative AI Credit coverage; reliability stays separate.",
    before: efficiency(100), after: efficiency(40), beforeValue: 10, afterValue: 4, gain: 6,
    extra: [
      { name: "complete-zero", evidence: efficiency(0), expected: 0 },
      { name: "empty-population", evidence: { ...efficiency(40), successfulRunCount: 0 }, expected: null },
    ],
    expectedValidation: { targetAttained: 4, targetMissed: 10, missing: null, malformed: null },
  },
  {
    id: "rendered-accessibility-barriers", source: ".github/workflows/self-care-accessibility-checker.md",
    grounding: "WCAG 2.2 Level AA", goal: "Reduce confirmed accessibility barriers in a declared page cohort.",
    disposition: "measurable", kind: "count", fields: ["barrier"],
    acceptance: "A complete rendered audit establishes whether each declared page has a confirmed barrier.",
    before: evidence(["barrier"], [[true], [true], [false], [false]]),
    after: evidence(["barrier"], [[false], [false], [false], [false]]),
    beforeValue: 2, afterValue: 0, gain: 2,
  },
  {
    id: "documentation-compatibility", source: ".github/workflows/multi-device-docs-tester.md",
    grounding: "responsiveness and rendering across device sizes",
    goal: "Attain working documentation rendering and navigation across the declared compatibility matrix.",
    disposition: "measurable", kind: "share", fields: ["layoutPassed", "navigationPassed"],
    acceptance: "Both layout and navigation checks pass for an eligible page/browser/device cell.",
    before: evidence(["layoutPassed", "navigationPassed"], [[true, true], [true, false], [true, true], [false, true]]),
    after: evidence(["layoutPassed", "navigationPassed"], [[true, true], [true, true], [true, true], [true, true]]),
    beforeValue: 50, afterValue: 100, gain: 50,
  },
  {
    id: "independently-verified-investigations", source: ".github/workflows/bug-bash-investigation.md",
    grounding: "separate verification phase",
    goal: "Produce independently verifiable defect investigations rather than unverified finding volume.",
    disposition: "measurable", kind: "share", fields: ["reproduced", "regressionFailedBefore", "regressionPassedAfter"],
    acceptance: "Independent replay reproduces the defect and the regression test fails before and passes after the proposed fix.",
    before: evidence(["reproduced", "regressionFailedBefore", "regressionPassedAfter"], [[true, true, false], [false, false, true]]),
    after: evidence(["reproduced", "regressionFailedBefore", "regressionPassedAfter"], [[true, true, true], [true, true, true]]),
    beforeValue: 0, afterValue: 100, gain: 100,
  },
  {
    id: "prose-confirmed-bug-resolution",
    goal: "Resolve the fixed cohort of confirmed bugs without introducing regressions.",
    disposition: "measurable", kind: "share", fields: bugFields,
    acceptance: "A cohort defect is closed as completed, its linked fix is merged, and required regression checks pass.",
    before: bugBefore, after: bugAfter, beforeValue: 40, afterValue: 80, gain: 40,
    extra: [
      { name: "reopened-defect", evidence: evidence(bugFields, [
        [true, true, true], [false, true, true], [true, true, true],
        [true, true, true], [false, false, false],
      ]), expected: 60 },
      { name: "closed-without-regression-proof", evidence: evidence(bugFields, [[true, true, false]]), expected: 0 },
    ],
  },
  {
    id: "non-ghaw-api-error-target",
    source: "tests/fixtures/operational-value-benchmark/service-monitor.yaml",
    grounding: "2 percent", goal: "Keep API error rate near the explicitly documented 2 percent reference.",
    disposition: "measurable", kind: "target", target: 2,
    acceptance: "Complete request/error counts establish the native percentage; proximity to the documented reference is better.",
    before: { valid: true, errors: 10, requests: 100 },
    after: { valid: true, errors: 2, requests: 100 },
    beforeValue: 10, afterValue: 2, gain: 8,
  },
  {
    id: "diagram-comprehension-boundary", source: ".github/workflows/docs-explanatory-diagrams.md",
    grounding: "theme-aware", goal: "Improve reader understanding through explanatory diagrams.",
    disposition: "needs-evidence-contract",
    reason: "SVG/theme checks establish artifact validity, not reader understanding; no comprehension instrument is supplied.",
  },
  {
    id: "vague-culture-goal", goal: "Make our engineering culture great.",
    disposition: "needs-clarification",
    reason: "No eligible population, observable accepted outcome, or agreed instrument is supplied.",
  },
  {
    id: "output-volume-proxy", goal: "Create more agent pull requests so we can claim more good work.",
    disposition: "activity-only",
    reason: "PR creation is measurable activity, but no repository-outcome acceptance rule is supplied.",
  },
];
