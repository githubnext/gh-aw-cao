import { createHash } from "node:crypto";
import {
  modelGap, periodEvidence, policyDefinition,
} from "../../../../scripts/native-policy-outcomes.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const receipt = (stdout, exitCode) => ({ stdout, sha256: digest(stdout), exitCode });
const fixture = accepted => ({
  valid: true, scope: "daily-workflow-security-model", completeBoundaryPopulation: true,
  boundaries: accepted ? [{
    id: "synthetic-only-security-boundary", invariant: "SyntheticInvariant",
    sourceRef: "synthetic-validation-not-real-coverage", originalModelSha256: "a".repeat(64),
    refinedModelSha256: "b".repeat(64), configSha256: "c".repeat(64), toolSha256: "d".repeat(64),
    priorControlIds: ["old-control"], preservedControlIds: ["old-control"],
    secure: receipt("Model checking completed. No error has been found.\n17 states generated, 11 distinct states found, 0 states left on queue.\n", 0),
    mutation: receipt("Error: Invariant SyntheticInvariant is violated.\n9 states generated, 7 distinct states found, 0 states left on queue.\n", 12),
  }] : [],
});

export const definition = policyDefinition("daily-workflow-security-model", {
  goal: "Detect and refine source-traceable workflow security boundaries using complete model exploration and preserved negative controls.",
  acceptance: "Additional independently replayed model boundary with correct intended mutation invariant, complete secure exploration, retained source/config/tool identity and preserved prior controls. Missing runtime and unfinished checker results are unavailable evidence.",
  unit: "independently replayed additional model boundaries",
  cadenceDays: 1,
  examples: {
    targetAttained: fixture(true), targetMissed: fixture(false),
    missing: { valid: false },
    malformed: { ...fixture(true), boundaries: [{ ...fixture(true).boundaries[0], mutation: receipt("Parser failed", 1) }] },
  },
});
definition.authoring = "V1 source-history-informed retrospective acceptance retained unchanged; synthetic scorer examples do not establish native coverage.";
definition.contractVersion = "1.0.0";

export function scoreMetric(id, evidence) {
  if (id !== "native-deliveries" || evidence?.valid !== true || evidence.scope !== definition.slug
    || evidence.completeBoundaryPopulation !== true || !Array.isArray(evidence.boundaries)) return null;
  const ids = new Set();
  for (const row of evidence.boundaries) {
    if (!row || typeof row.id !== "string" || !row.id || ids.has(row.id)
      || typeof row.invariant !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(row.invariant)
      || typeof row.sourceRef !== "string" || !row.sourceRef
      || ![row.originalModelSha256, row.refinedModelSha256, row.configSha256, row.toolSha256]
        .every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
      || row.originalModelSha256 === row.refinedModelSha256
      || !Array.isArray(row.priorControlIds) || !Array.isArray(row.preservedControlIds)
      || !row.priorControlIds.every(control => row.preservedControlIds.includes(control))) return null;
    for (const packet of [row.secure, row.mutation]) {
      if (typeof packet?.stdout !== "string" || digest(packet.stdout) !== packet.sha256
        || !/\b[1-9]\d* states generated, [1-9]\d* distinct states found, 0 states left on queue\./.test(packet.stdout)) return null;
    }
    if (row.secure.exitCode !== 0 || !row.secure.stdout.includes("Model checking completed. No error has been found.")
      || row.secure.stdout.includes("Error:")
      || row.mutation.exitCode !== 12
      || !row.mutation.stdout.includes(`Error: Invariant ${row.invariant} is violated.`)) return null;
    ids.add(row.id);
  }
  return ids.size;
}
export async function collectBatch(requests, context = {}) {
  if (Object.keys(context).some(key => key !== "database")) throw new Error("Unverified context is not model-checking authority");
  return periodEvidence(requests, definition.slug, modelGap(), 1, "1.0.0");
}
