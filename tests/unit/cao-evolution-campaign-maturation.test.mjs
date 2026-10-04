import assert from 'node:assert/strict';
import test from 'node:test';
import { decideCampaignMaturation } from '../../cao-evolution/campaign-maturation.mjs';

function snapshot(overrides = {}) {
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
    ...overrides
  };
}

test('campaign maturation gates readiness on complete evidence, value, budget, failures, and approval', () => {
  assert.equal(decideCampaignMaturation(snapshot()).decision, 'ready-for-live-decision');
  for (const override of [
    { contractComplete: false },
    { evidenceComplete: false },
    { maturationElapsed: false },
    { blockingFailure: true },
    { operationalValueAccepted: false },
    { budgetAccepted: false },
    { humanApproved: false }
  ]) {
    assert.notEqual(decideCampaignMaturation(snapshot(override)).decision, 'ready-for-live-decision');
  }
});

test('campaign maturation decisions follow the cycle lifecycle', () => {
  assert.equal(decideCampaignMaturation(snapshot({
    allChildrenTerminal: false,
    boundedImprovement: true
  })).decision, 'improvement-ready');
  assert.equal(decideCampaignMaturation(snapshot({
    postChangeWindowElapsed: false
  })).decision, 'validating');
  assert.equal(decideCampaignMaturation(snapshot({
    stopConditionSatisfied: true
  })).decision, 'retire');
  assert.equal(decideCampaignMaturation(snapshot({
    materialFingerprintChanged: false
  })).decision, 'continue-observing');
  assert.equal(decideCampaignMaturation(snapshot({
    allChildrenTerminal: false,
    boundedImprovement: true,
    matchingOpenChild: true
  })).decision, 'continue-observing');
});

test('campaign maturation fingerprints are deterministic and malformed evidence fails closed', () => {
  assert.deepEqual(decideCampaignMaturation(snapshot()), decideCampaignMaturation(snapshot()));
  assert.match(decideCampaignMaturation(snapshot()).inputFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.throws(
    () => decideCampaignMaturation({ ...snapshot(), evidenceComplete: 'yes' }),
    /evidenceComplete must be boolean/
  );
});
