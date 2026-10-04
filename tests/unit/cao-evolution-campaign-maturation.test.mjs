import assert from "node:assert/strict";
import test from "node:test";
import {
  campaignMaturationTaskIdentity,
  decideCampaignMaturation,
  evaluateCampaignMaturation,
  fingerprintCampaignMaturationEvidence,
  planCampaignMaturationCycle,
  selectCampaignMaturationCandidate,
} from "../../.github/workflows/shared/campaign-maturation.mjs";

const revision = "a".repeat(40);
const contractFingerprint = `sha256:${"b".repeat(64)}`;

function gates(overrides = {}) {
  return {
    contractComplete: true,
    evidenceComplete: true,
    materialFingerprintChanged: true,
    maturationElapsed: true,
    observationActive: false,
    stopConditionSatisfied: false,
    humanRejected: false,
    allChildrenTerminal: true,
    postChangeWindowElapsed: true,
    boundedImprovement: false,
    matchingOpenChild: false,
    blockingFailure: false,
    operationalValueAccepted: true,
    budgetAccepted: true,
    humanApproved: true,
    ...overrides,
  };
}

function candidate(campaign, overrides = {}) {
  return {
    campaign,
    mode: "review",
    enabled: true,
    contractComplete: true,
    existingOpenCycle: false,
    materialFingerprintChanged: true,
    actionableEvidence: true,
    contractQuality: 5,
    evidencePriority: 5,
    ...overrides,
  };
}

function evidence(overrides = {}) {
  return {
    campaign: "dependabot",
    policyRevision: revision,
    contractFingerprint,
    windowStart: "2026-09-01T00:00:00Z",
    windowEnd: "2026-10-01T00:00:00Z",
    budgetDisposition: "within",
    observations: [
      { identity: "run:2", quality: "complete", status: "success" },
      { identity: "run:1", quality: "complete", status: "failure" },
    ],
    operationalValues: [{
      definition: "merged-update-share",
      observedAt: "2026-10-01T00:00:00Z",
      value: 0.8,
      unit: "ratio",
      direction: "increase",
    }],
    cycleIssues: [{ identity: "issue:42", state: "open", stateReason: null }],
    ...overrides,
  };
}

test("shared core selects one eligible campaign deterministically", () => {
  assert.equal(selectCampaignMaturationCandidate([
    candidate("optimization", { evidencePriority: 9 }),
    candidate("dependabot", { existingOpenCycle: true, actionableEvidence: false }),
    candidate("dashboard", { existingOpenCycle: true, evidencePriority: 99 }),
    candidate("repo-assist", { mode: "live", evidencePriority: 99 }),
  ]), "dependabot");
  assert.equal(selectCampaignMaturationCandidate([
    candidate("repo-assist", { evidencePriority: 7 }),
    candidate("dependabot", { evidencePriority: 7 }),
  ]), "dependabot");
  assert.equal(selectCampaignMaturationCandidate([
    candidate("dependabot", { materialFingerprintChanged: false }),
  ]), null);
});

test("shared core fingerprints only bounded canonical evidence", () => {
  const first = fingerprintCampaignMaturationEvidence(evidence());
  const reordered = fingerprintCampaignMaturationEvidence(evidence({
    observations: [...evidence().observations].reverse(),
  }));
  assert.equal(first, reordered);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.throws(
    () => fingerprintCampaignMaturationEvidence({ ...evidence(), rawTrace: "secret" }),
    /unexpected keys: rawTrace/,
  );
  assert.notEqual(first, fingerprintCampaignMaturationEvidence(evidence({
    budgetDisposition: "exceeded",
  })));
});

test("shared core gates readiness on complete evidence, value, budget, failures, and approval", () => {
  const fingerprint = fingerprintCampaignMaturationEvidence(evidence());
  assert.equal(decideCampaignMaturation(gates(), fingerprint).decision, "ready-for-live-decision");
  for (const override of [
    { contractComplete: false },
    { evidenceComplete: false },
    { maturationElapsed: false },
    { blockingFailure: true },
    { operationalValueAccepted: false },
    { budgetAccepted: false },
    { humanApproved: false },
  ]) {
    assert.notEqual(
      decideCampaignMaturation(gates(override), fingerprint).decision,
      "ready-for-live-decision",
    );
  }
});

test("shared core owns maturation decisions and cycle transitions", () => {
  const fingerprint = fingerprintCampaignMaturationEvidence(evidence());
  assert.equal(decideCampaignMaturation(gates({
    allChildrenTerminal: false,
    boundedImprovement: true,
  }), fingerprint).decision, "improvement-ready");
  assert.equal(decideCampaignMaturation(gates({
    postChangeWindowElapsed: false,
  }), fingerprint).decision, "validating");
  assert.equal(decideCampaignMaturation(gates({
    stopConditionSatisfied: true,
  }), fingerprint).decision, "retire");
  assert.equal(planCampaignMaturationCycle({
    decision: "retire",
    parentOpen: true,
    allChildrenTerminal: true,
    postChangeVerified: false,
    humanApproved: false,
    blockerCount: 0,
  }).parent, "close-not-planned");
  assert.equal(planCampaignMaturationCycle({
    decision: "continue-observing",
    parentOpen: true,
    allChildrenTerminal: false,
    postChangeVerified: false,
    humanApproved: false,
    blockerCount: 1,
  }).parent, "keep-open");
});

test("shared core returns selection, identity, decision, and transition as one result", () => {
  const result = evaluateCampaignMaturation({
    candidates: [candidate("dependabot")],
    evidence: evidence(),
    gates: gates(),
    cycle: {
      parentOpen: true,
      allChildrenTerminal: true,
      postChangeVerified: false,
      humanApproved: true,
      blockerCount: 0,
    },
    tasks: [],
  });
  assert.equal(result.selectedCampaign, "dependabot");
  assert.equal(result.decision, "ready-for-live-decision");
  assert.equal(result.transition.parent, "close-completed");
  assert.equal(result.cycleIdentity.subject, `Campaign maturation cycle for dependabot: ${result.inputFingerprint.slice(7, 19)}`);
  assert.match(result.cycleIdentity.marker, /decision=ready-for-live-decision;budget=within;blockers=0/);
  assert.deepEqual(result.taskIdentities, []);
  assert.deepEqual(evaluateCampaignMaturation({
    candidates: [candidate("dependabot", { materialFingerprintChanged: false })],
  }), { selectedCampaign: null, outcome: "noop" });
});

test("shared core formats bounded child identities and fails closed on malformed input", () => {
  const identity = campaignMaturationTaskIdentity({
    campaign: "dependabot",
    parentFingerprint: fingerprintCampaignMaturationEvidence(evidence()),
    key: "update-cadence",
    boundary: "adjust update cadence",
  });
  assert.equal(identity.subject, "Campaign maturation task for dependabot: adjust update cadence");
  assert.match(identity.marker, /key=update-cadence -->$/);
  const evaluated = evaluateCampaignMaturation({
    candidates: [candidate("dependabot")],
    evidence: evidence(),
    gates: gates({ allChildrenTerminal: false, boundedImprovement: true }),
    cycle: {
      parentOpen: true,
      allChildrenTerminal: false,
      postChangeVerified: false,
      humanApproved: false,
      blockerCount: 1,
    },
    tasks: [{ key: "update-cadence", boundary: "adjust update cadence" }],
  });
  assert.equal(evaluated.decision, "improvement-ready");
  assert.deepEqual(evaluated.taskIdentities, [identity]);
  assert.throws(
    () => decideCampaignMaturation({ ...gates(), evidenceComplete: "yes" }, "sha256:bad"),
    /inputFingerprint must be a valid string/,
  );
});
