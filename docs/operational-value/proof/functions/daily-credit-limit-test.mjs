import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readJson } from "../../../../.github/skills/add-operational-value/scripts/common.mjs";

const repository = "github/gh-aw";
const slug = "daily-credit-limit-test";
const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
const workflowBlob = "950ad1930ee32372cb8f254b36eee121cbc94254";
const compiledBlob = "11aa7a405433b0dff64461a4b4f5b26f637c351d";
const checkerBlob = "63160a3c91d4b5a472bdcea120878dfd2c5852a4";
const activatedAt = "2026-10-18T15:00:12Z";
const cap = 1;
const day = 86_400_000;
const evidenceRoot = new URL("../daily-credit-limit-test/", import.meta.url);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const nonnegative = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const instant = value => typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === new Date(Date.parse(value)).toISOString()
  && new Date(value).toISOString().replace(".000Z", "Z") === value;

const metric = (id, name, role, formula, unit, legendLabel) => ({
  id, name, role, formula, direction: "increase", unit,
  presentation: { name, legendLabel, transform: "identity" },
});
const example = accepted => ({
  contractKey: `${slug}:daily-activation:v1`, assessed: true, inventoryComplete: true,
  eligibleCount: 1, observedEligibleCount: 1, unresolvedEligibilityCount: 0, unassessedAcceptanceCount: 0,
  acceptedCount: accepted, denialCount: accepted, inferenceFreeCount: accepted,
  notificationCount: accepted, contributionCount: accepted,
  contributionComplete: true, coverageStatus: "complete", synthetic: true,
});

export const definition = {
  schemaVersion: 3,
  slug, repository, workflowName: "Daily credit activation guardrail",
  sourcePath: ".github/workflows/daily-credit-limit-test.md",
  intent: {
    goal: "Protect the daily workflow budget by denying eligible activations before agent inference and publishing the required limit-exceeded message.",
    acceptance: "Independent complete preceding-24-hour recorded AIC establishes eligibility; a source-bound daily guardrail denial, complete no-inference audit and immutable conclusion-job message jointly establish protection.",
    temporalAnchor: "contract-activation",
  },
  adoption: { commit: revision, adoptedAt: activatedAt, baselineCommit: null, baselineAt: null },
  evaluation: {
    mode: "attainment-only",
    scope: "Prospective frozen-current-source contract, not a claim of historical adoption readiness.",
    historicalReadiness: "unknown-not-exhausted",
    actualSourceAddition: "0fb669049b80755074f3891de4a85c848acdd167",
    actualSourceParent: "29e09fa8f846b7e86bdecb541405f39238a06e07",
    limitation: "Addition and parent trees are known; addition bodies, current compiled workflow and checker bodies are missing. Historical predicates and a pre-adoption baseline remain unverified.",
  },
  evidence: {
    key: `${slug}:daily-activation:v1`,
    repositories: [repository],
    opportunity: "One source-profile-matching guardrail activation identified by repository ID, workflow blob, run ID and run attempt, timestamped at its guardrail scan start. Non-bypassed activations whose complete independent recorded 24-hour AIC total is at least 1 are eligible.",
    filters: [
      "Public repository ID 1036865607; selected workflow only; exact frozen source, compiled and checker blob identities.",
      "Schedule activations and non-command routed workflow_dispatch only; direct/manual, malformed-context and command-driven dispatch bypasses are excluded under specification section 9.8.",
      "Artifact-backend membership: complete same-workflow latest-completed-run inventory; createdAt >= scanStartAt minus 24 hours; exclude current run; count each run once, not each rerun.",
      "Equality is exceeded under normative specification section 9.14, despite source prose saying more than 1.",
      "Only independent recorded AIC establishes the recorded-usage threshold; it does not certify external billing. Estimated fallback, incomplete coverage, guardrail self-reported totals and missing pricing remain unassessed.",
      "A failed job, intentional nonexistent-tool failure, per-run budget exhaustion or absent log is not a daily guardrail denial.",
      "No acceptance before terminal opportunity disposition; inference audit covers all agent requests from activation through terminal disposition, including accepted requests lacking a response.",
    ],
    collection: "Read one bounded digest-checked local native archive once per batch. Validate source, producer receipts, complete inventory, latest-attempt usage and outcome facets. Retained issue/PR lineage is discovery only. No network, checkout execution, dashboard query or campaign is required.",
    measurementKind: "interval",
    window: { durationDays: 1, cadenceDays: 1, maturationDays: 0 },
    timeSemantics: "Inclusive activation start, exclusive end; receipt and terminal timestamps must be <= observedAt. Completion, not elapsed time, matures an opportunity. Explicit caller windows may have any positive duration. Reports use disjoint daily periods. No observation is backdated before contract activation.",
    acceptedEvidence: {
      denial: "Trusted activation-control-plane receipt: daily-ai-credits-workflow-guardrail, exceeded, configured cap 1, before any agent inference; not transient_error or structural_error.",
      inference: "Independent complete provider/agent request inventory bound to the activation, not an empty/missing agent log. No agent inference requests from activation through terminal disposition.",
      notification: "Immutable conclusion-job publication receipt containing Daily Workflow AIC Guardrail Exceeded; same repository/run/attempt and published after denial and by terminal disposition.",
      attribution: "Separately authenticated selected-workflow execution producer receipt; editable issue footer is insufficient. Accepted actor-independent work survives missing attribution.",
    },
    zeroVersusMissing: "No eligible population means primary null, never zero percent. Complete assessed eligible failures establish zero percent. Missing facets make the primary null; independently verified positive facet counts remain visible lower bounds, never an all-clear.",
    sourceReadiness: "Incomplete: all available source/import/spec bodies retained losslessly, missing compiled/checker bodies enumerated in acquisition-review.json. No native producer or authenticated native observations acquired.",
    nativeArchive: "daily-credit-limit-test-native-v1; receipt digests bind payloads, not authenticity. A trusted producer must independently authenticate immutable origins before issuing receipt authentication=verified. No such producer has been implemented or released here.",
    antecedent: "Budget enforcement can exist without this workflow. Reconstructability of the exact historical measure is unknown, not exhausted; the current profile is never applied to an unverified historical era.",
  },
  model: {
    architecture: "Native opportunity-normalized protective outcome with independently retained acceptance facets and workflow contribution.",
    recommendation: "Not rated: no goal-derived keep bar or cost evidence exists. Do not interpret missing observations as failed protection or savings.",
    presentation: { label: "Daily activation protection", betterLabel: "More verified protection" },
  },
  summary: { nativeLabel: "Protected eligible activations (%)" },
  metrics: [
    metric("protected-share", "Eligible activations fully protected", "primary",
      "100 * acceptedCount / eligibleCount; only complete eligibility and acceptance cohorts", "percent", "Protected activations"),
    metric("verified-protected", "Independently verified protected activations", "diagnostic",
      "acceptedCount; positive lower bound survives incomplete inventory or other unresolved opportunities", "activations", "Verified protection"),
    metric("daily-denials", "Verified daily guardrail denials", "diagnostic",
      "denialCount for independently eligible activations; not full acceptance", "activations", "Daily denials"),
    metric("inference-free", "Verified inference-free eligible activations", "diagnostic",
      "inferenceFreeCount for independently eligible activations with complete audit", "activations", "No agent inference"),
    metric("limit-messages", "Verified required limit messages", "diagnostic",
      "notificationCount for independently eligible activations; publication alone is not full acceptance", "activations", "Limit messages"),
    metric("workflow-contribution", "Verified workflow-linked protected activations", "diagnostic",
      "contributionCount; subset of acceptedCount with authenticated producer linkage, not exclusive causation", "activations", "Workflow contribution"),
  ],
  rejectedMetrics: [
    "Intentional tool failure and generic run success/failure: not guardrail outcome evidence.",
    "Per-run max-ai-credits: a different cap and mechanism.",
    "Issue creation, closure and editable run markers: discovery/engagement, not acceptance.",
    "Estimated daily AIC: conservative policy assumption, not measured actual consumption.",
    "Dollars, hours or credits saved: no counterfactual cost evidence.",
    "Composite utility, keep thresholds and normalized scores: no source-derived authority.",
  ],
  validationExamples: {
    targetAttained: example(1), targetMissed: example(0),
    missing: { missingReason: "No authenticated native export" }, malformed: { eligibleCount: -1 },
  },
};

function receipt(payload, kind, row, observedAt) {
  if (payload == null) return null;
  if (!payload || typeof payload !== "object" || !payload.payload
    || payload.sha256 !== digest(payload.payload)) throw new Error("Native receipt digest mismatch");
  const value = payload.payload;
  if (value.kind !== kind || value.repositoryId !== 1036865607 || value.runId !== row.runId
    || value.attempt !== row.attempt || value.authentication !== "verified"
    || value.origin !== "independent-native-export"
    || typeof value.immutableRef !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.immutableRef)
    || !instant(value.observedAt)) throw new Error("Unbound or unauthenticated native receipt");
  return Date.parse(value.observedAt) <= Date.parse(observedAt) ? value : null;
}

function validateArchive(archive) {
  if (archive?.schemaVersion !== 1 || archive.kind !== "daily-credit-limit-test-native-v1"
    || archive.repository !== repository || archive.repositoryId !== 1036865607
    || archive.revision !== revision || typeof archive.synthetic !== "boolean"
    || !Array.isArray(archive.opportunities) || !Array.isArray(archive.coverage)
    || typeof archive.producerStatus !== "string") throw new Error("Invalid native archive scope");
  if (!archive.synthetic && (archive.opportunities.length || archive.coverage.length)
    && archive.producerStatus !== "independently-authenticated") {
    throw new Error("Native producer authenticity has not been established");
  }
  const identities = new Set();
  for (const row of archive.opportunities) {
    if (!positive(row.runId) || !positive(row.attempt) || !instant(row.activationAt)
      || !["schedule", "workflow_dispatch"].includes(row.event)
      || row.workflowBlob !== workflowBlob || row.compiledBlob !== compiledBlob || row.checkerBlob !== checkerBlob) {
      throw new Error("Invalid activation identity or incompatible source profile");
    }
    const identity = `${row.runId}:${row.attempt}`;
    if (identities.has(identity)) throw new Error("Repeated activation identity");
    identities.add(identity);
  }
  for (const coverage of archive.coverage) {
    if (!instant(coverage.startAt) || !instant(coverage.endAt) || !instant(coverage.observedAt)
      || Date.parse(coverage.startAt) >= Date.parse(coverage.endAt)
      || coverage.complete !== true || typeof coverage.receiptSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(coverage.receiptSha256)) throw new Error("Invalid inventory coverage");
    if (!coverage.receipt || coverage.receiptSha256 !== digest(coverage.receipt)
      || coverage.receipt.authentication !== "verified"
      || coverage.receipt.origin !== "independent-native-export"
      || coverage.receipt.repositoryId !== 1036865607
      || coverage.receipt.workflowBlob !== workflowBlob
      || coverage.receipt.compiledBlob !== compiledBlob
      || coverage.receipt.checkerBlob !== checkerBlob
      || coverage.receipt.startAt !== coverage.startAt || coverage.receipt.endAt !== coverage.endAt
      || coverage.receipt.observedAt !== coverage.observedAt) throw new Error("Unverified inventory coverage");
  }
}

function bypassed(row) {
  if (row.event === "schedule") return false;
  if (typeof row.awContext !== "string") throw new Error("Missing explicit dispatch routing context");
  if (!row.awContext) return true;
  let context;
  try { context = JSON.parse(row.awContext); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return true;
  }
  const command = context?.aw_context ?? {};
  return ["issue_comment", "pull_request_review_comment", "discussion_comment"].includes(command.event_type)
    || typeof command.trigger_label === "string" && command.trigger_label.length > 0;
}

function usageTotal(ledger, row) {
  if (!ledger || ledger.complete !== true || ledger.accounting !== "recorded-independent"
    || ledger.workflowBlob !== workflowBlob || ledger.scanStartAt !== row.activationAt
    || !Array.isArray(ledger.runs)) return null;
  const seen = new Map();
  let total = 0;
  for (const run of ledger.runs) {
    if (!positive(run.runId) || !positive(run.attempt) || !instant(run.createdAt) || !instant(run.updatedAt)
      || run.status !== "completed" || !nonnegative(run.aic) || run.estimated !== false
      || run.componentsComplete !== true || run.producerVerified !== true) {
      return null;
    }
    if (run.runId === row.runId || Date.parse(run.createdAt) < Date.parse(row.activationAt) - day) continue;
    if (seen.has(run.runId)) {
      if (seen.get(run.runId) !== digest(run)) throw new Error("Conflicting latest-run accounting");
      continue;
    }
    seen.set(run.runId, digest(run));
    total += run.aic;
    if (!Number.isFinite(total)) throw new Error("AIC sum overflow");
  }
  return total;
}

function coversWindow(coverage, start, end, observedAt) {
  const intervals = coverage.filter(row => Date.parse(row.observedAt) <= Date.parse(observedAt))
    .toSorted((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  let cursor = Date.parse(start);
  for (const row of intervals) {
    if (Date.parse(row.startAt) > cursor) break;
    cursor = Math.max(cursor, Date.parse(row.endAt));
    if (cursor >= Date.parse(end)) return true;
  }
  return false;
}

function evaluateWindow(request, archive) {
  const { windowStart, windowEnd, observedAt } = request;
  if (!instant(windowStart) || !instant(windowEnd) || !instant(observedAt)
    || Date.parse(windowStart) >= Date.parse(windowEnd) || Date.parse(observedAt) < Date.parse(windowEnd)
    || request.repository && request.repository.toLowerCase() !== repository.toLowerCase()) {
    throw new Error("Invalid bounded daily guardrail request");
  }
  const inEra = Date.parse(windowStart) >= Date.parse(activatedAt);
  const inventoryComplete = inEra && coversWindow(archive.coverage, windowStart, windowEnd, observedAt);
  const evidence = {
    contractKey: definition.evidence.key, windowStart, windowEnd, observedAt,
    measurementKind: "interval", inventoryComplete, assessed: inventoryComplete,
    eligibleCount: null, observedEligibleCount: 0, ineligibleCount: 0, bypassedCount: 0,
    unresolvedEligibilityCount: 0, unassessedAcceptanceCount: 0,
    acceptedCount: 0, denialCount: 0, inferenceFreeCount: 0,
    notificationCount: 0, contributionCount: 0, contributionComplete: true,
    synthetic: archive.synthetic, costs: { status: "not-measured" }, opportunities: [],
    nativeProducerStatus: archive.producerStatus,
    coverageStatus: inventoryComplete ? "complete" : "missing",
    maturityStatus: "unavailable", dubious: true,
    missingReason: inEra ? "No complete authenticated native activation inventory, usage ledger, inference audit and publication receipts retained."
      : "Outside frozen current-source contract activation; historical compatibility is unverified.",
    sourceReadiness: definition.evidence.sourceReadiness,
  };
  if (!inEra) return evidence;
  const rows = archive.opportunities.filter(row => Date.parse(row.activationAt) >= Date.parse(windowStart)
    && Date.parse(row.activationAt) < Date.parse(windowEnd));
  for (const row of rows) {
    const fact = { runId: row.runId, attempt: row.attempt, activationAt: row.activationAt,
      eligible: null, denial: null, inferenceFree: null, notification: null, accepted: null,
      contribution: null };
    evidence.opportunities.push(fact);
    const activation = receipt(row.activation, "activation-inventory", row, observedAt);
    if (!activation || activation.activationAt !== row.activationAt || activation.event !== row.event
      || activation.awContext !== row.awContext || activation.workflowBlob !== workflowBlob
      || activation.compiledBlob !== compiledBlob || activation.checkerBlob !== checkerBlob) {
      evidence.unresolvedEligibilityCount++;
      continue;
    }
    evidence.assessed = true;
    if (bypassed(row)) {
      evidence.bypassedCount++;
      fact.eligible = false;
      continue;
    }
    const ledger = receipt(row.ledger, "independent-usage-ledger", row, observedAt);
    const total = usageTotal(ledger, row);
    fact.recordedAic = total;
    if (total === null) {
      evidence.unresolvedEligibilityCount++;
      continue;
    }
    fact.eligible = total >= cap;
    if (!fact.eligible) {
      evidence.ineligibleCount++;
      continue;
    }
    evidence.observedEligibleCount++;
    const terminal = receipt(row.terminal, "terminal-disposition", row, observedAt);
    const matured = terminal && instant(terminal.terminalAt)
      && Date.parse(terminal.terminalAt) >= Date.parse(row.activationAt)
      && Date.parse(terminal.terminalAt) <= Date.parse(terminal.observedAt);
    const decision = receipt(row.decision, "activation-decision", row, observedAt);
    if (decision && (typeof decision.guardrail !== "string" || !decision.guardrail
      || typeof decision.status !== "string" || !decision.status || !nonnegative(decision.threshold)
      || typeof decision.agentAdmitted !== "boolean")) throw new Error("Malformed activation decision");
    if (decision && instant(decision.decidedAt) && Date.parse(decision.decidedAt) >= Date.parse(row.activationAt)
      && Date.parse(decision.decidedAt) <= Date.parse(decision.observedAt)) {
      fact.denial = decision.guardrail === "daily-ai-credits-workflow-guardrail"
        && decision.status === "exceeded" && decision.threshold === cap && decision.agentAdmitted === false;
    }
    const audit = receipt(row.inference, "agent-inference-audit", row, observedAt);
    if (matured && audit?.complete === true && audit.startAt === row.activationAt
      && audit.endAt === terminal.terminalAt && Date.parse(audit.endAt) <= Date.parse(audit.observedAt)
      && Array.isArray(audit.requests)) {
      if (!audit.requests.every(item => typeof item.id === "string" && item.id
        && instant(item.requestedAt) && Date.parse(item.requestedAt) >= Date.parse(audit.startAt)
        && Date.parse(item.requestedAt) <= Date.parse(audit.endAt))) {
        throw new Error("Invalid inference audit request");
      }
      fact.inferenceFree = audit.requests.length === 0;
    }
    const publication = receipt(row.notification, "conclusion-message", row, observedAt);
    if (matured && publication?.complete === true && typeof publication.published === "boolean") {
      if (publication.published && (typeof publication.publisherJob !== "string"
        || typeof publication.text !== "string" || !instant(publication.publishedAt))) {
        throw new Error("Malformed published conclusion message");
      }
      fact.notification = publication.published && publication.publisherJob === "conclusion"
        && typeof publication.text === "string"
        && publication.text.includes("Daily Workflow AIC Guardrail Exceeded")
        && instant(publication.publishedAt)
        && Date.parse(publication.publishedAt) >= Date.parse(decision?.decidedAt ?? row.activationAt)
        && Date.parse(publication.publishedAt) <= Date.parse(terminal.terminalAt)
        && Date.parse(publication.publishedAt) <= Date.parse(publication.observedAt);
    }
    if (fact.denial === true) evidence.denialCount++;
    if (fact.inferenceFree === true) evidence.inferenceFreeCount++;
    if (fact.notification === true) evidence.notificationCount++;
    if (matured && [fact.denial, fact.inferenceFree, fact.notification].every(value => typeof value === "boolean")) {
      fact.accepted = fact.denial && fact.inferenceFree && fact.notification;
    } else {
      evidence.unassessedAcceptanceCount++;
    }
    if (fact.accepted) {
      evidence.acceptedCount++;
      const producer = receipt(row.producer, "workflow-producer", row, observedAt);
      if (producer && typeof producer.linked === "boolean" && producer.workflowBlob === workflowBlob) {
        fact.contribution = producer.linked;
        if (producer.linked) evidence.contributionCount++;
      } else evidence.contributionComplete = false;
    }
  }
  evidence.populationDigest = digest(evidence.opportunities.map(row => [row.runId, row.attempt, row.eligible]));
  const cohortComplete = inventoryComplete && evidence.unresolvedEligibilityCount === 0;
  evidence.eligibleCount = cohortComplete ? evidence.observedEligibleCount : null;
  evidence.populationDigestKind = cohortComplete ? "complete-cohort" : "observed-subset";
  const complete = inventoryComplete && evidence.unresolvedEligibilityCount === 0
    && evidence.unassessedAcceptanceCount === 0;
  evidence.coverageStatus = complete ? "complete" : rows.length ? "partial" : "missing";
  evidence.maturityStatus = complete
    ? Date.parse(windowEnd) - Date.parse(windowStart) < day ? "interim" : "matured"
    : rows.length ? "interim" : "unavailable";
  evidence.dubious = evidence.maturityStatus !== "matured" || archive.synthetic;
  if (complete) evidence.missingReason = evidence.eligibleCount ? null : "Complete inventory contains no eligible activations; share is undefined.";
  evidence.evidenceDigest = digest(evidence);
  return evidence;
}

export async function collectBatch(requests, context = {}) {
  if (!Array.isArray(requests)) throw new Error("Requests must be a batch array");
  const archive = context.nativeArchive ?? readJson(fileURLToPath(new URL("native.json.gz", evidenceRoot)));
  validateArchive(archive);
  return requests.map(request => {
    const evidence = evaluateWindow(request, archive);
    return {
      evidence,
      provenance: [
        { repository, kind: "immutable-intent-source", ref: `git:${revision}:${definition.sourcePath}#${workflowBlob}` },
        { repository, kind: archive.synthetic ? "synthetic-fixture-not-native"
          : archive.opportunities.length ? "retained-native-archive" : "retained-native-availability-manifest",
          ref: `sha256:${digest(archive)}` },
      ],
      commit: revision,
    };
  });
}

function validEvidence(evidence) {
  if (evidence?.contractKey !== definition.evidence.key || evidence.assessed !== true
    || typeof evidence.inventoryComplete !== "boolean" || typeof evidence.contributionComplete !== "boolean"
    || !["complete", "partial", "missing"].includes(evidence.coverageStatus)) return false;
  const fields = ["observedEligibleCount", "unresolvedEligibilityCount", "unassessedAcceptanceCount",
    "acceptedCount", "denialCount", "inferenceFreeCount", "notificationCount", "contributionCount"];
  return fields.every(key => count(evidence[key]))
    && (evidence.inventoryComplete && evidence.unresolvedEligibilityCount === 0
      ? evidence.eligibleCount === evidence.observedEligibleCount : evidence.eligibleCount === null)
    && evidence.unassessedAcceptanceCount <= evidence.observedEligibleCount
    && evidence.acceptedCount <= evidence.observedEligibleCount - evidence.unassessedAcceptanceCount
    && ["denialCount", "inferenceFreeCount", "notificationCount"].every(key =>
      evidence[key] <= evidence.observedEligibleCount && evidence[key] >= evidence.acceptedCount)
    && evidence.contributionCount <= evidence.acceptedCount;
}

export function scoreMetric(id, evidence) {
  if (!validEvidence(evidence)) return null;
  const cohortComplete = evidence.inventoryComplete && evidence.unresolvedEligibilityCount === 0;
  const acceptanceComplete = cohortComplete && evidence.unassessedAcceptanceCount === 0;
  if (id === "protected-share") {
    return acceptanceComplete && evidence.coverageStatus === "complete" && evidence.eligibleCount > 0
      ? 100 * evidence.acceptedCount / evidence.eligibleCount : null;
  }
  const fields = {
    "verified-protected": ["acceptedCount", acceptanceComplete],
    "daily-denials": ["denialCount", acceptanceComplete],
    "inference-free": ["inferenceFreeCount", acceptanceComplete],
    "limit-messages": ["notificationCount", acceptanceComplete],
    "workflow-contribution": ["contributionCount", acceptanceComplete && evidence.contributionComplete],
  };
  if (!Object.hasOwn(fields, id)) return null;
  const [field, complete] = fields[id];
  return evidence[field] > 0 || complete ? evidence[field] : null;
}
