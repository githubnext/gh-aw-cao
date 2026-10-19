import {
  nativeScore, periodEvidence, policyDefinition, replayNetwork, transition,
} from "../../../../scripts/native-policy-outcomes.mjs";

function outcomes() {
  const record = transition(67811);
  const result = replayNetwork(record);
  return { accepted: result.accepted.map(domain => ({
    id: domain.id, domains: [domain], commit: record.commit, parent: record.parent,
    committedAt: record.committedAt, pr: record.pr,
    facet: "Explicit Claude transport opt-in versus retained infrastructure opt-ins; not unconditional engine access.",
  })) };
}

const expected = outcomes().accepted;
const example = events => ({
  valid: true, scope: "weekly-network-domains-audit", events, coverageStatus: "complete",
});
export const definition = policyDefinition("weekly-network-domains-audit", {
  goal: "Keep named engine transport domain sets minimal and separate from explicitly selected infrastructure ecosystems.",
  acceptance: "Distinct concrete infrastructure hosts formerly covered by Claude transport but no longer covered after a landed source transition, with unchanged explicit ecosystem access and verified native loader. This is a partial source-defined named-set condition, not runtime egress or complete audit acceptance.",
  unit: "concrete infrastructure domain grants removed from Claude transport",
  cadenceDays: 7,
  examples: {
    targetAttained: example(expected), targetMissed: example([]),
    missing: { valid: false }, malformed: example([{ id: "fabricated-domain-removal" }]),
  },
});
export async function collectBatch(requests, context = {}) {
  if (Object.keys(context).some(key => key !== "database")) throw new Error("Unverified context is not native evidence authority");
  return periodEvidence(requests, definition.slug, outcomes(), 7);
}
export function scoreMetric(id, evidence) {
  return nativeScore(id, evidence, definition.slug, expected);
}
