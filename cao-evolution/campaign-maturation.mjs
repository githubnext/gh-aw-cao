#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const BOOLEAN_FIELDS = [
  'contractComplete',
  'evidenceComplete',
  'materialFingerprintChanged',
  'maturationElapsed',
  'observationActive',
  'stopConditionSatisfied',
  'humanRejected',
  'allChildrenTerminal',
  'postChangeWindowElapsed',
  'boundedImprovement',
  'matchingOpenChild',
  'blockingFailure',
  'operationalValueAccepted',
  'budgetAccepted',
  'humanApproved'
];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function decideCampaignMaturation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Campaign maturation input must be an object');
  }
  for (const field of BOOLEAN_FIELDS) {
    if (typeof input[field] !== 'boolean') {
      throw new TypeError(`Campaign maturation input.${field} must be boolean`);
    }
  }
  const normalized = Object.fromEntries(BOOLEAN_FIELDS.map((field) => [field, input[field]]));
  let decision;
  if (!normalized.contractComplete
      || !normalized.evidenceComplete
      || !normalized.materialFingerprintChanged
      || !normalized.maturationElapsed
      || normalized.observationActive) {
    decision = 'continue-observing';
  } else if (normalized.stopConditionSatisfied || normalized.humanRejected) {
    decision = 'retire';
  } else if (normalized.allChildrenTerminal && !normalized.postChangeWindowElapsed) {
    decision = 'validating';
  } else if (normalized.boundedImprovement && !normalized.matchingOpenChild) {
    decision = 'improvement-ready';
  } else if (normalized.allChildrenTerminal
      && !normalized.blockingFailure
      && normalized.operationalValueAccepted
      && normalized.budgetAccepted
      && normalized.humanApproved) {
    decision = 'ready-for-live-decision';
  } else {
    decision = 'continue-observing';
  }
  const inputFingerprint = `sha256:${createHash('sha256')
    .update(JSON.stringify(canonical(normalized)))
    .digest('hex')}`;
  return { decision, inputFingerprint, gates: normalized };
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  process.stdout.write(`${JSON.stringify(decideCampaignMaturation(input))}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
