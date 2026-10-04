#!/usr/bin/env node

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const BOOLEAN_GATES = [
  "contractComplete",
  "evidenceComplete",
  "materialFingerprintChanged",
  "maturationElapsed",
  "observationActive",
  "stopConditionSatisfied",
  "humanRejected",
  "allChildrenTerminal",
  "postChangeWindowElapsed",
  "boundedImprovement",
  "matchingOpenChild",
  "blockingFailure",
  "operationalValueAccepted",
  "budgetAccepted",
  "humanApproved",
];
const DECISIONS = new Set([
  "continue-observing",
  "improvement-ready",
  "validating",
  "ready-for-live-decision",
  "retire",
]);
const INTERNAL_CAMPAIGNS = new Set(["activity", "cao-evolution", "dashboard"]);
const BUDGET_DISPOSITIONS = new Set(["unknown", "within", "exceeded", "not-applicable"]);
const EVIDENCE_QUALITIES = new Set(["complete", "incomplete", "unknown", "stale", "contradictory"]);
const ISSUE_STATES = new Set(["open", "closed"]);
const MAX_FINGERPRINT_BYTES = 128 * 1024;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STABLE_KEY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const REVISION_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64}|sha256:[a-f0-9]{64})$/;

function assertRecord(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function assertKeys(value, allowed, name) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new TypeError(`${name} has unexpected keys: ${unexpected.join(", ")}`);
}

function assertBoolean(value, name) {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean`);
}

function assertString(value, name, pattern) {
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) {
    throw new TypeError(`${name} must be a valid string`);
  }
}

function assertInteger(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}`);
  }
}

function canonical(value, path = "input") {
  if (value === undefined) throw new TypeError(`${path} must not contain undefined`);
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError(`${path} must contain only finite numbers`);
  }
  if (Array.isArray(value)) return value.map((entry, index) => canonical(entry, `${path}[${index}]`));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key], `${path}.${key}`)]),
  );
}

function hashCanonical(value) {
  const serialized = JSON.stringify(canonical(value));
  if (Buffer.byteLength(serialized) > MAX_FINGERPRINT_BYTES) {
    throw new TypeError(`campaign maturation fingerprint input exceeds ${MAX_FINGERPRINT_BYTES} bytes`);
  }
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function selectCampaignMaturationCandidate(candidates) {
  if (!Array.isArray(candidates)) throw new TypeError("candidates must be an array");
  const eligible = candidates.map((candidate, index) => {
    assertRecord(candidate, `candidates[${index}]`);
    assertKeys(candidate, [
      "campaign",
      "mode",
      "enabled",
      "contractComplete",
      "existingOpenCycle",
      "materialFingerprintChanged",
      "actionableEvidence",
      "contractQuality",
      "evidencePriority",
    ], `candidates[${index}]`);
    assertString(candidate.campaign, `candidates[${index}].campaign`, SLUG_PATTERN);
    for (const field of [
      "enabled",
      "contractComplete",
      "existingOpenCycle",
      "materialFingerprintChanged",
      "actionableEvidence",
    ]) {
      assertBoolean(candidate[field], `candidates[${index}].${field}`);
    }
    if (!["review", "live"].includes(candidate.mode)) {
      throw new TypeError(`candidates[${index}].mode must be review or live`);
    }
    assertInteger(candidate.contractQuality, `candidates[${index}].contractQuality`);
    assertInteger(candidate.evidencePriority, `candidates[${index}].evidencePriority`);
    return {
      campaign: candidate.campaign,
      mode: candidate.mode,
      enabled: candidate.enabled,
      contractComplete: candidate.contractComplete,
      existingOpenCycle: candidate.existingOpenCycle,
      materialFingerprintChanged: candidate.materialFingerprintChanged,
      actionableEvidence: candidate.actionableEvidence,
      contractQuality: candidate.contractQuality,
      evidencePriority: candidate.evidencePriority,
    };
  }).filter((candidate) => (
    candidate.enabled
    && candidate.mode === "review"
    && !INTERNAL_CAMPAIGNS.has(candidate.campaign)
    && candidate.contractComplete
    && candidate.materialFingerprintChanged
    && (candidate.existingOpenCycle || candidate.actionableEvidence)
  ));

  eligible.sort((left, right) => (
    Number(right.existingOpenCycle) - Number(left.existingOpenCycle)
    || right.contractQuality - left.contractQuality
    || right.evidencePriority - left.evidencePriority
    || compareText(left.campaign, right.campaign)
  ));
  return eligible[0]?.campaign ?? null;
}

export function fingerprintCampaignMaturationEvidence(input) {
  assertRecord(input, "evidence");
  assertKeys(input, [
    "campaign",
    "policyRevision",
    "contractFingerprint",
    "windowStart",
    "windowEnd",
    "budgetDisposition",
    "observations",
    "operationalValues",
    "cycleIssues",
  ], "evidence");
  assertString(input.campaign, "evidence.campaign", SLUG_PATTERN);
  assertString(input.policyRevision, "evidence.policyRevision", REVISION_PATTERN);
  assertString(input.contractFingerprint, "evidence.contractFingerprint", REVISION_PATTERN);
  assertString(input.windowStart, "evidence.windowStart");
  assertString(input.windowEnd, "evidence.windowEnd");
  if (!BUDGET_DISPOSITIONS.has(input.budgetDisposition)) {
    throw new TypeError("evidence.budgetDisposition is invalid");
  }
  if (!Array.isArray(input.observations)) throw new TypeError("evidence.observations must be an array");
  if (!Array.isArray(input.operationalValues)) throw new TypeError("evidence.operationalValues must be an array");
  if (!Array.isArray(input.cycleIssues)) throw new TypeError("evidence.cycleIssues must be an array");

  const observations = input.observations.map((observation, index) => {
    assertRecord(observation, `evidence.observations[${index}]`);
    assertKeys(observation, ["identity", "quality", "status"], `evidence.observations[${index}]`);
    assertString(observation.identity, `evidence.observations[${index}].identity`);
    if (!EVIDENCE_QUALITIES.has(observation.quality)) {
      throw new TypeError(`evidence.observations[${index}].quality is invalid`);
    }
    assertString(observation.status, `evidence.observations[${index}].status`);
    return {
      identity: observation.identity,
      quality: observation.quality,
      status: observation.status,
    };
  }).sort((left, right) => compareText(left.identity, right.identity));

  const operationalValues = input.operationalValues.map((value, index) => {
    assertRecord(value, `evidence.operationalValues[${index}]`);
    assertKeys(
      value,
      ["definition", "observedAt", "value", "unit", "direction"],
      `evidence.operationalValues[${index}]`,
    );
    assertString(value.definition, `evidence.operationalValues[${index}].definition`);
    assertString(value.observedAt, `evidence.operationalValues[${index}].observedAt`);
    assertString(value.unit, `evidence.operationalValues[${index}].unit`);
    if (!["increase", "decrease"].includes(value.direction)) {
      throw new TypeError(`evidence.operationalValues[${index}].direction is invalid`);
    }
    if (typeof value.value !== "number" || !Number.isFinite(value.value)) {
      throw new TypeError(`evidence.operationalValues[${index}].value must be a finite number`);
    }
    return {
      definition: value.definition,
      observedAt: value.observedAt,
      value: value.value,
      unit: value.unit,
      direction: value.direction,
    };
  }).sort((left, right) => (
    compareText(left.definition, right.definition)
    || compareText(left.observedAt, right.observedAt)
  ));

  const cycleIssues = input.cycleIssues.map((issue, index) => {
    assertRecord(issue, `evidence.cycleIssues[${index}]`);
    assertKeys(issue, ["identity", "state", "stateReason"], `evidence.cycleIssues[${index}]`);
    assertString(issue.identity, `evidence.cycleIssues[${index}].identity`);
    if (!ISSUE_STATES.has(issue.state)) throw new TypeError(`evidence.cycleIssues[${index}].state is invalid`);
    const stateReason = issue.stateReason ?? null;
    if (stateReason !== null && !["completed", "not_planned"].includes(stateReason)) {
      throw new TypeError(`evidence.cycleIssues[${index}].stateReason is invalid`);
    }
    return { identity: issue.identity, state: issue.state, stateReason };
  }).sort((left, right) => compareText(left.identity, right.identity));

  return hashCanonical({
    campaign: input.campaign,
    policyRevision: input.policyRevision,
    contractFingerprint: input.contractFingerprint,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    budgetDisposition: input.budgetDisposition,
    observations,
    operationalValues,
    cycleIssues,
  });
}

export function decideCampaignMaturation(input, inputFingerprint) {
  assertRecord(input, "gates");
  assertKeys(input, BOOLEAN_GATES, "gates");
  assertString(inputFingerprint, "inputFingerprint", /^sha256:[a-f0-9]{64}$/);
  for (const field of BOOLEAN_GATES) assertBoolean(input[field], `gates.${field}`);
  const gates = Object.fromEntries(BOOLEAN_GATES.map((field) => [field, input[field]]));
  let decision;
  if (!gates.contractComplete
      || !gates.evidenceComplete
      || !gates.materialFingerprintChanged
      || !gates.maturationElapsed
      || gates.observationActive) {
    decision = "continue-observing";
  } else if (gates.stopConditionSatisfied || gates.humanRejected) {
    decision = "retire";
  } else if (gates.allChildrenTerminal && !gates.postChangeWindowElapsed) {
    decision = "validating";
  } else if (gates.boundedImprovement && !gates.matchingOpenChild) {
    decision = "improvement-ready";
  } else if (gates.allChildrenTerminal
      && !gates.blockingFailure
      && gates.operationalValueAccepted
      && gates.budgetAccepted
      && gates.humanApproved) {
    decision = "ready-for-live-decision";
  } else {
    decision = "continue-observing";
  }
  return { decision, inputFingerprint, gates };
}

export function planCampaignMaturationCycle(input) {
  assertRecord(input, "cycle");
  assertKeys(
    input,
    ["decision", "parentOpen", "allChildrenTerminal", "postChangeVerified", "humanApproved", "blockerCount"],
    "cycle",
  );
  if (!DECISIONS.has(input.decision)) throw new TypeError("cycle.decision is invalid");
  for (const field of ["parentOpen", "allChildrenTerminal", "postChangeVerified", "humanApproved"]) {
    assertBoolean(input[field], `cycle.${field}`);
  }
  assertInteger(input.blockerCount, "cycle.blockerCount");
  if (input.decision === "retire") {
    return { parent: input.parentOpen ? "close-not-planned" : "none", children: "close-unjustified" };
  }
  if (input.decision === "improvement-ready") {
    return { parent: input.parentOpen ? "update" : "create", children: "reconcile-bounded" };
  }
  if (input.parentOpen && input.allChildrenTerminal && (
    input.postChangeVerified
    || (input.decision === "ready-for-live-decision" && input.humanApproved)
  )) {
    return { parent: "close-completed", children: "none" };
  }
  return { parent: input.parentOpen ? "keep-open" : "none", children: "none" };
}

export function campaignMaturationCycleIdentity(input) {
  assertRecord(input, "cycleIdentity");
  assertKeys(
    input,
    ["campaign", "fingerprint", "decision", "budgetDisposition", "blockerCount"],
    "cycleIdentity",
  );
  assertString(input.campaign, "cycleIdentity.campaign", SLUG_PATTERN);
  assertString(input.fingerprint, "cycleIdentity.fingerprint", /^sha256:[a-f0-9]{64}$/);
  if (!DECISIONS.has(input.decision)) throw new TypeError("cycleIdentity.decision is invalid");
  if (!BUDGET_DISPOSITIONS.has(input.budgetDisposition)) {
    throw new TypeError("cycleIdentity.budgetDisposition is invalid");
  }
  assertInteger(input.blockerCount, "cycleIdentity.blockerCount");
  return {
    subject: `Campaign maturation cycle for ${input.campaign}: ${input.fingerprint.slice(7, 19)}`,
    marker: `<!-- cao-campaign-maturation:campaign=${input.campaign};fingerprint=${input.fingerprint};decision=${input.decision};budget=${input.budgetDisposition};blockers=${input.blockerCount} -->`,
  };
}

export function campaignMaturationTaskIdentity(input) {
  assertRecord(input, "taskIdentity");
  assertKeys(input, ["campaign", "parentFingerprint", "key", "boundary"], "taskIdentity");
  assertString(input.campaign, "taskIdentity.campaign", SLUG_PATTERN);
  assertString(input.parentFingerprint, "taskIdentity.parentFingerprint", /^sha256:[a-f0-9]{64}$/);
  assertString(input.key, "taskIdentity.key", STABLE_KEY_PATTERN);
  assertString(input.boundary, "taskIdentity.boundary");
  return {
    subject: `Campaign maturation task for ${input.campaign}: ${input.boundary}`,
    marker: `<!-- cao-campaign-maturation-task:campaign=${input.campaign};cycle=${input.parentFingerprint};key=${input.key} -->`,
  };
}

export function evaluateCampaignMaturation(input) {
  assertRecord(input, "input");
  assertKeys(input, ["candidates", "evidence", "gates", "cycle", "tasks"], "input");
  const selectedCampaign = selectCampaignMaturationCandidate(input.candidates);
  if (selectedCampaign === null) {
    return { selectedCampaign: null, outcome: "noop" };
  }
  if (input.evidence?.campaign !== selectedCampaign) {
    throw new TypeError("evidence.campaign must match the selected campaign");
  }
  const inputFingerprint = fingerprintCampaignMaturationEvidence(input.evidence);
  const evaluation = decideCampaignMaturation(input.gates, inputFingerprint);
  const transition = planCampaignMaturationCycle({ ...input.cycle, decision: evaluation.decision });
  if (!Array.isArray(input.tasks) || input.tasks.length > 5) {
    throw new TypeError("tasks must be an array with at most 5 entries");
  }
  const taskIdentities = input.tasks.map((task) => campaignMaturationTaskIdentity({
    campaign: selectedCampaign,
    parentFingerprint: inputFingerprint,
    ...task,
  }));
  if (transition.children !== "reconcile-bounded" && taskIdentities.length > 0) {
    throw new TypeError("tasks are allowed only for a reconcile-bounded transition");
  }
  return {
    selectedCampaign,
    ...evaluation,
    transition,
    cycleIdentity: campaignMaturationCycleIdentity({
      campaign: selectedCampaign,
      fingerprint: inputFingerprint,
      decision: evaluation.decision,
      budgetDisposition: input.evidence.budgetDisposition,
      blockerCount: input.cycle.blockerCount,
    }),
    taskIdentities,
  };
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  process.stdout.write(`${JSON.stringify(evaluateCampaignMaturation(input))}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
