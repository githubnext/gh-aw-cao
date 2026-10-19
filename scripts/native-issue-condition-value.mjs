import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readIssueConditionHistory } from "./collect-issue-condition-history.mjs";
import { censusDigest } from "./operational-value-census-io.mjs";

export function replayIssueCondition(issue, requireUnassigned = false) {
  const missing = reason => ({ id: issue.id, createdAt: issue.createdAt, known: false, reason });
  if (!issue.available) return missing(issue.reason);
  if (issue.events.some(event => event.type === "TransferredEvent")) return missing("Transferred issue membership is not reconstructed");
  const state = { state: "OPEN", labels: 0, assignees: 0 };
  const changes = [{ at: issue.createdAt, ...state }], events = [];
  const eligible = () => state.state === "OPEN" && (!requireUnassigned || state.assignees === 0);
  let previous = Date.parse(issue.createdAt);
  const ids = new Set();
  for (const event of issue.events) {
    if (typeof event.id !== "string" || !event.id || ids.has(event.id)
      || !Number.isFinite(Date.parse(event.at)) || Date.parse(event.at) < previous) {
      throw new Error("Malformed native issue history");
    }
    ids.add(event.id);
    previous = Date.parse(event.at);
    const before = state.labels, wasEligible = eligible();
    switch (event.type) {
      case "LabeledEvent": state.labels += 1; break;
      case "UnlabeledEvent": state.labels -= 1; break;
      case "AssignedEvent": state.assignees += 1; break;
      case "UnassignedEvent": state.assignees -= 1; break;
      case "ClosedEvent":
        if (state.state !== "OPEN") return missing("Repeated closure without a retained reopening");
        state.state = "CLOSED"; break;
      case "ReopenedEvent":
        if (state.state !== "CLOSED") return missing("Reopening without a retained closure");
        state.state = "OPEN"; break;
      default: throw new Error("Unsupported native issue condition event");
    }
    if (state.labels < 0 || state.assignees < 0) return missing("Issue condition events do not reconstruct a nonnegative state");
    if (wasEligible && ["LabeledEvent", "UnlabeledEvent"].includes(event.type)) {
      const value = Number(before === 0 && state.labels > 0) - Number(before > 0 && state.labels === 0);
      if (value) events.push({ id: event.id, at: event.at, issueId: issue.id, value });
    }
    changes.push({ at: event.at, ...state });
  }
  if (!issue.terminal || Object.keys(state).some(key => state[key] !== issue.terminal[key])) {
    return missing("Retained events do not reconcile with the observed terminal issue state");
  }
  return { id: issue.id, createdAt: issue.createdAt, known: true, events, changes };
}

export function issueConditionEvidence(histories, request, requireUnassigned = false) {
  const start = Date.parse(request.windowStart), end = Date.parse(request.windowEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error("Invalid issue observation interval");
  const cohort = histories.filter(row => Date.parse(row.createdAt) < end);
  const known = cohort.filter(row => row.known), unknown = cohort.filter(row => !row.known);
  let eligibleOpen = 0, unlabeledOpen = 0, opportunities = 0;
  for (const issue of known) {
    let state = null, opportunity = false;
    const eligible = row => row?.state === "OPEN" && (!requireUnassigned || row.assignees === 0);
    for (const change of issue.changes) {
      const at = Date.parse(change.at);
      if (at >= end) break;
      if (at >= start && eligible(state) && state.labels === 0) opportunity = true;
      state = change;
      if (at >= start && eligible(state) && state.labels === 0) opportunity = true;
    }
    if (eligible(state)) {
      eligibleOpen += 1;
      if (state.labels === 0) { unlabeledOpen += 1; opportunity = true; }
    }
    if (opportunity) opportunities += 1;
  }
  const events = known.flatMap(row => row.events.filter(event => Date.parse(event.at) >= start && Date.parse(event.at) < end));
  return { valid: true, assessedIssues: known.length, unknownIssues: unknown.length,
    coverageStatus: unknown.length ? "partial" : "complete-surviving-cohort",
    eligibleCount: opportunities, observedEligibleOpen: eligibleOpen, observedUnlabeledOpen: unlabeledOpen,
    observedUnlabeledPercent: eligibleOpen ? 100 * unlabeledOpen / eligibleOpen : null,
    nativeGains: events.filter(event => event.value === 1).length,
    nativeWithdrawals: events.filter(event => event.value === -1).length,
    eventCount: events.length, eventLedgerSha256: censusDigest(events),
    unknownReasons: Object.fromEntries([...new Set(unknown.map(row => row.reason))]
      .map(reason => [reason, unknown.filter(row => row.reason === reason).length])),
    workflowContribution: "not-measured", classificationCorrectness: "not-measured", costs: "not-measured" };
}

export function scoreIssueConditionMetric(id, evidence) {
  if (!["native-net", "observed-native-net"].includes(id) || evidence?.valid !== true
    || ![evidence.assessedIssues, evidence.unknownIssues, evidence.nativeGains, evidence.nativeWithdrawals, evidence.eventCount]
      .every(value => Number.isSafeInteger(value) && value >= 0)
    || evidence.nativeGains + evidence.nativeWithdrawals !== evidence.eventCount
    || typeof evidence.eventLedgerSha256 !== "string" || !/^[a-f0-9]{64}$/.test(evidence.eventLedgerSha256)
    || id === "native-net" && evidence.unknownIssues > 0
    || id === "observed-native-net" && evidence.assessedIssues === 0 && evidence.unknownIssues > 0) return null;
  return evidence.nativeGains - evidence.nativeWithdrawals;
}

export function nativeIssueConditionModule(contract) {
  if (contract.nativeModelSha256 !== createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex")
    || typeof contract.requireUnassigned !== "boolean") throw new Error("Frozen native issue condition interpreter changed");
  const sample = value => ({ valid: true, assessedIssues: 1, unknownIssues: 0,
    nativeGains: value, nativeWithdrawals: 0, eventCount: value, eventLedgerSha256: censusDigest(["example", value]) });
  const definition = {
    schemaVersion: 3, slug: contract.workflowId, repository: contract.repository,
    workflowName: contract.workflowName, sourcePath: `.github/workflows/${contract.workflowId}.md`,
    intent: { goal: contract.goal, acceptance: contract.acceptance, temporalAnchor: "workflow-adoption" },
    adoption: contract.adoption, evaluation: { mode: "attainment-only" },
    evidence: { key: "native-issue-label-coverage-v1", repositories: [contract.repository],
      nativeModelSha256: contract.nativeModelSha256,
      opportunity: `Open ${contract.requireUnassigned ? "unassigned " : ""}unlabeled issues in the frozen surviving-identity cohort.`,
      filters: ["Replay all retained label, assignment, closure and reopening events from creation; reconcile terminal state.",
        "Exclude no unknown issue as if clean: complete totals become null; retain explicitly observed native subtotals.",
        "Transfers, deleted identities and unreconciled histories remain unknown.",
        "Any-label coverage is a partial discoverability facet, not proof of correct classification or full triage.",
        "Repository condition changes are not attributed to either workflow; comments, run success and label counts do not establish classification correctness.",
        "The surviving cohort omits deleted/transferred-away issues; do not apply the whole-repository 5% goal to its observed subset."],
      collection: "Replay one shared, digest-checked, resumable issue condition archive offline. Retain period counts and native-event ledger digests instead of duplicating the event archive in every plot.",
      measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Version-pinned GitHub issue condition replay.",
      recommendation: "Review native label-coverage progress separately from workflow attribution, classification correctness and costs.",
      presentation: { label: "Issue label-coverage delivery", betterLabel: "More covered issues, fewer coverage withdrawals" } },
    summary: { nativeLabel: "Native label-coverage deliveries" },
    metrics: [
      { id: "native-net", name: "Complete surviving-cohort net label-coverage deliveries", role: "primary",
        direction: "increase", unit: "issues", formula: "eligible open issues gaining their first label minus losing their last label",
        presentation: { name: "Cohort net label coverage", legendLabel: "Complete cohort coverage", transform: "identity" } },
      { id: "observed-native-net", name: "Observed net label-coverage deliveries", role: "diagnostic",
        direction: "increase", unit: "issues", formula: "the same signed effects within completely reconstructed issue histories; unknown histories are not zero",
        presentation: { name: "Observed native label coverage", legendLabel: "Observed label coverage", transform: "identity" } },
    ],
    signal: { metricId: "observed-native-net", basis: "repository-outcome" },
    validationExamples: { targetAttained: sample(1), targetMissed: sample(0),
      missing: { valid: false }, malformed: { ...sample(1), nativeGains: "one" } },
  };
  return { definition, scoreMetric: scoreIssueConditionMetric, collectBatch(requests) {
    const { index, issues } = readIssueConditionHistory("docs/operational-value/proof/issue-condition-history");
    if (index.repository !== contract.repository || index.sourceRevision !== contract.sourceRevision
      || index.until !== contract.until) throw new Error("Native issue history scope changed");
    const histories = issues.map(issue => replayIssueCondition(issue, contract.requireUnassigned));
    return requests.map(request => {
      if (request.repository && request.repository !== contract.repository
        || !Number.isFinite(Date.parse(request.observedAt))
        || Date.parse(request.windowStart) < Date.parse(contract.adoption.adoptedAt)
        || Date.parse(request.windowEnd) > Date.parse(index.until)) throw new Error("Out-of-scope native issue request");
      return { evidence: issueConditionEvidence(histories, request, contract.requireUnassigned),
        provenance: [{ repository: contract.repository, kind: "issue-condition-history-sha256", ref: censusDigest(index) }],
        commit: index.sourceRevision };
    });
  } };
}
