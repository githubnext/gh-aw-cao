import {
  nativeScore, periodEvidence, policyDefinition, replaySetup,
} from "../../../../scripts/native-policy-outcomes.mjs";

const measured = replaySetup();
const expected = measured.accepted;
const example = events => ({
  valid: true, scope: "daily-action-setup-security-audit", events, coverageStatus: "complete",
});
export const definition = policyDefinition("daily-action-setup-security-audit", {
  goal: "Improve actual setup-action security conditions through actionable, independently corroborated repairs.",
  acceptance: "Independently reproduce removal of dummy credential persistence in a local Git origin and removal of group/world-readable dummy-credential wrapper files using the original bounded source statements and actual filesystem postconditions. Count distinct repaired conditions, not cases or merges.",
  unit: "credential-at-rest conditions repaired",
  cadenceDays: 7,
  examples: {
    targetAttained: example(expected), targetMissed: example([]),
    missing: { valid: false }, malformed: example([{ id: "fabricated-security-fix" }]),
  },
});
export async function collectBatch(requests, context = {}) {
  if (Object.keys(context).some(key => key !== "database")) throw new Error("Unverified context is not native evidence authority");
  return periodEvidence(requests, definition.slug, measured, 7);
}
export function scoreMetric(id, evidence) {
  return nativeScore(id, evidence, definition.slug, expected);
}
