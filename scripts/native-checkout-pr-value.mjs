import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";

const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const repository = "github/gh-aw";
const repositoryId = 1036865607;
const directory = "docs/operational-value/proof/checkout-pr-dispatch";

export function checkoutOpportunity(event, profile = { strictPrNumber: true }) {
  if (!event || event.repository?.id !== repositoryId || event.repository?.full_name !== repository) {
    return { eligible: null, reason: "No original same-repository event payload." };
  }
  if (event.eventName === "schedule") return { eligible: false, triggerClass: "schedule-control" };
  if (event.eventName === "workflow_dispatch") {
    let aw;
    try { aw = JSON.parse(event.inputs?.aw_context || "{}"); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return { eligible: false, triggerClass: "dispatch-no-pr-control", reason: "Malformed dispatch context." };
    }
    if (!aw || typeof aw !== "object" || aw.item_type !== "pull_request") {
      return { eligible: false, triggerClass: "dispatch-no-pr-control" };
    }
    const number = profile.strictPrNumber === false ? Number(aw.item_number) : typeof aw.item_number === "number" ? aw.item_number
      : typeof aw.item_number === "string" && /^[1-9]\d*$/.test(aw.item_number) ? Number(aw.item_number) : null;
    if (!positive(number) || aw.repo && aw.repo !== repository) {
      return { eligible: false, triggerClass: "dispatch-no-pr-control", reason: "Invalid or cross-repository dispatch." };
    }
    return { eligible: true, number, triggerClass: aw.command_name ? "centralized-slash-pr-dispatch" : "dispatch-pr" };
  }
  if (["pull_request", "pull_request_target", "pull_request_review", "pull_request_review_comment"].includes(event.eventName)
    && positive(event.pull_request?.number)) {
    return { eligible: true, number: event.pull_request.number,
      triggerClass: event.eventName.startsWith("pull_request_review") ? "direct-pr-comment" : "direct-pr" };
  }
  if (event.eventName === "issue_comment" && event.issue?.pull_request && positive(event.issue.number)) {
    return { eligible: true, number: event.issue.number, triggerClass: "direct-pr-comment" };
  }
  if (["issues", "issue_comment"].includes(event.eventName)) return { eligible: false, triggerClass: "issue-slash-control" };
  return { eligible: null, reason: "No supported original PR/control event." };
}

export function assessCheckoutReceipt(receipt, contract) {
  const unknown = reason => ({ eligible: null, headMatches: null, attained: null, reason });
  if (!receipt || !positive(receipt.runId) || receipt.attempt !== 1 || !digest(receipt.eventSha256)
    || censusDigest(receipt.event) !== receipt.eventSha256) return unknown("No immutable original event receipt.");
  const profile = contract.sourceProfiles.find(row => row.lockGitBlob === receipt.lockGitBlob
    && row.checkerGitBlob === receipt.checkerGitBlob);
  if (!profile || receipt.sourceVerified !== true) return unknown("Unbound historical source policy.");
  if (receipt.policyAdmitted !== true) return unknown("No independent source-policy admission receipt.");
  const opportunity = checkoutOpportunity(receipt.event, profile);
  if (opportunity.eligible !== true) return { ...opportunity, headMatches: null, attained: null };
  const state = receipt.actual, expected = receipt.expected;
  const bound = state?.producer === "protected-pre-agent-git-readback" && positive(state.jobId)
    && state.runId === receipt.runId && state.attempt === 1 && digest(state.receiptSha256)
    && digest(expected?.receiptSha256) && expected.runId === receipt.runId && expected.attempt === 1
    && expected.prNumber === opportunity.number && expected.repositoryId === repositoryId
    && ["original-pr-event-head", "protected-fetch-ref-resolution"].includes(expected.kind)
    && (expected.kind !== "original-pr-event-head" || receipt.event.eventName === "pull_request"
      && expected.headSha === receipt.event.pull_request?.head?.sha
      && expected.headRef === receipt.event.pull_request?.head?.ref)
    && sha(expected.headSha) && typeof expected.headRef === "string" && expected.headRef.length > 0
    && typeof state.at === "string" && Number.isFinite(Date.parse(state.at))
    && Number.isFinite(Date.parse(receipt.agentStartedAt)) && Date.parse(state.at) <= Date.parse(receipt.agentStartedAt)
    && Date.parse(state.at) < Date.parse(contract.until) && sha(state.headSha) && typeof state.branch === "string";
  if (!bound) return { ...opportunity, headMatches: null, attained: null,
    reason: "Missing bound expected head/ref or protected pre-agent actual Git readback." };
  const headMatches = state.headSha === expected.headSha && state.branch === expected.headRef;
  const knownConjunction = typeof state.clean === "boolean" && typeof state.initialized === "boolean"
    && typeof state.originPresent === "boolean" && Number.isSafeInteger(state.visibleCommits) && state.visibleCommits >= 0;
  return { ...opportunity, headMatches,
    attained: !headMatches ? false : knownConjunction
      ? state.clean && state.initialized && state.originPresent && state.visibleCommits > 0 && state.branch !== "main" : null,
    reason: knownConjunction ? null : "Head match known; complete clean/initialized/origin/history conjunction unknown." };
}

export function scoreCheckoutMetric(id, evidence) {
  if (!["verified-checkouts", "verified-heads"].includes(id) || evidence?.valid !== true
    || !Array.isArray(evidence.assessments) || !evidence.assessments.length
    || new Set(evidence.assessments.map(row => row?.id)).size !== evidence.assessments.length
    || evidence.assessments.some(row => typeof row?.id !== "string" || !row.id
      || ![true, false, null].includes(row.eligible)
      || ![true, false, null].includes(row.attained) || ![true, false, null].includes(row.headMatches)
      || row.attained === true && row.headMatches !== true
      || row.eligible !== true && (row.attained !== null || row.headMatches !== null))) return null;
  const field = id === "verified-checkouts" ? "attained" : "headMatches";
  const eligible = evidence.assessments.filter(row => row.eligible === true);
  if (!eligible.some(row => typeof row[field] === "boolean")) return null;
  return eligible.filter(row => row[field] === true).length;
}

export function checkoutValueModule() {
  const contract = readCensusJson(`${directory}/contract.json`);
  if (contract.interpreterSha256 !== createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex")) {
    throw new Error("Frozen checkout interpreter changed");
  }
  const examples = count => ({ valid: true, assessments: Array.from({ length: count }, (_, index) =>
    ({ id: String(index), eligible: true, attained: true, headMatches: true })) });
  const definition = {
    schemaVersion: 3, slug: contract.workflowId, repository, workflowName: "Smoke Checkout PR Dispatch",
    sourcePath: `.github/workflows/${contract.workflowId}.md`,
    intent: { goal: contract.goal, acceptance: contract.acceptance, temporalAnchor: "workflow-adoption" },
    adoption: contract.adoption, evaluation: { mode: "attainment-only" },
    evidence: { key: "protected-pr-checkout-conjunction-v1", repositories: [repository],
      contractSha256: censusDigest(contract), sourceGitBlob: contract.sourceGitBlob,
      sourceRevision: contract.sourceRevision, interpreterSha256: contract.interpreterSha256,
      sourceProfiles: contract.sourceProfiles, antecedent: contract.antecedent,
      opportunity: "Every policy-admitted initial PR-context invocation, including dispatch, centralized slash dispatch and direct PR/comment triggers; no-PR controls are separate.",
      filters: [...contract.rejectedProxies.map(proxy => `Not proof: ${proxy}`), ...contract.limitations],
      collection: "Offline replay of digest-checked all-run inventory, original event, immutable source policy, expected PR-head and protected pre-agent Git state; absent receipts remain null.",
      measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Independent source-bound event/head/Git-state conjunction.",
      recommendation: "Do not rate value until authentic checkout receipts exist; preserve partial head-match evidence independently.",
      presentation: { label: "Verified PR checkout outcomes", betterLabel: "More independently verified checkout outcomes" } },
    summary: { nativeLabel: "Verified PR checkout outcomes" },
    metrics: [
      { id: "verified-checkouts", name: "Verified PR checkouts", role: "primary", unit: "checkout proofs",
        formula: contract.formula, direction: "increase",
        presentation: { name: "Verified PR checkouts", legendLabel: "Verified PR checkouts", transform: "identity" } },
      { id: "verified-heads", name: "Verified intended PR heads", role: "diagnostic", unit: "head-match proofs",
        formula: "Count independent intended PR head/ref matches; does not assert a clean workspace.",
        direction: "increase", presentation: { name: "Verified intended PR heads", legendLabel: "Verified intended heads", transform: "identity" } },
    ],
    validationExamples: { targetAttained: examples(2), targetMissed: examples(1), missing: { valid: false },
      malformed: { valid: true, assessments: [{ id: "invalid", eligible: true, attained: "PASS", headMatches: "PASS" }] } },
  };
  const collectBatch = requests => {
    const index = readCensusJson(`${directory}/index.json`);
    const rows = readCensusJson(`${directory}/observations.json.gz`);
    const sources = readCensusJson(`${directory}/sources.json.gz`);
    let sourceCount = 0;
    for (const part of sources.parts) {
      if (!/^sources-\d{3}\.json\.gz$/.test(part.file)) throw new Error("Unsafe checkout source partition");
      const blobs = readCensusJson(`${directory}/${part.file}`);
      if (censusDigest(blobs) !== part.sha256 || blobs.length !== part.count) throw new Error("Checkout source partition changed");
      sourceCount += blobs.length;
    }
    if (index.contractSha256 !== censusDigest(contract) || index.observationsSha256 !== censusDigest(rows)
      || rows.length !== index.inventoryRuns || contract.sourcesSha256 !== censusDigest(sources)
      || sourceCount !== sources.sourceCount || index.inventoryComplete !== true) throw new Error("Checkout evidence inventory or frozen source integrity mismatch");
    return requests.map(request => {
      const start = Date.parse(request.windowStart), end = Date.parse(request.windowEnd);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !Number.isFinite(Date.parse(request.observedAt))
        || request.repository && request.repository !== repository) throw new Error("Invalid checkout observation request");
      const selected = rows.filter(row => Date.parse(row.createdAt) >= start && Date.parse(row.createdAt) < end);
      const assessments = selected.map(row => ({ id: `${row.runId}:1`,
        ...(row.event === "schedule" ? { eligible: false, triggerClass: "schedule-control", headMatches: null, attained: null }
          : assessCheckoutReceipt(row.receipt, { ...contract, sourceProfiles: definition.evidence.sourceProfiles })) }));
      const known = assessments.some(row => row.attained !== null || row.headMatches !== null);
      const covered = request.windowStart >= contract.adoption.adoptedAt && request.windowEnd <= contract.until;
      return { evidence: { valid: covered && known, assessments, inventoryInitialAttempts: selected.length,
        eligibleCount: assessments.every(row => row.eligible !== null) ? assessments.filter(row => row.eligible).length : null,
        unassessedEligibility: assessments.filter(row => row.eligible === null).length,
        coverageStatus: covered && assessments.length && assessments.every(row => row.eligible !== null
          && (row.eligible === false || row.attained !== null)) ? "complete" : "missing",
        missingReason: known ? null : "Original event/head and protected clean-checkout receipts were not preserved; Actions activity is not checkout proof.",
        costs: "not-measured", attribution: "not-measured", sourceCoverage: covered, limitations: contract.limitations },
      provenance: [{ repository, kind: "immutable-workflow-source", ref: contract.sourceGitBlob },
        { repository, kind: "protected-pr-checkout-inventory", ref: censusDigest(index) }],
      commit: contract.sourceRevision };
    });
  };
  return { definition, collectBatch, scoreMetric: scoreCheckoutMetric };
}
