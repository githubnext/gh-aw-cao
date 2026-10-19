import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { collectTemporaryId, hashTemporaryId, readTemporaryId, scoreTemporaryId, temporaryIdDirectory } from "../../scripts/native-temporary-id-value.mjs";

const interpreterSha256 = "7911ff0c28e076b2c9c80b32fd56a2143ddae0688c3baba1faa752a33227e4ae";
if (createHash("sha256").update(readFileSync(new URL("../../scripts/native-temporary-id-value.mjs", import.meta.url))).digest("hex")
  !== interpreterSha256) throw new Error("Temporary-ID native interpreter differs from the frozen function implementation");
const contract = readTemporaryId(`${temporaryIdDirectory}/contract.json`);
const contractSha256 = "f88d0a3955e8f6c0844f1a30a06bd72e52703f25f4d6f953f62613477c6bad6e";
if (hashTemporaryId(contract) !== contractSha256) throw new Error("Temporary-ID semantic contract differs from the frozen goal and acceptance");
const example = count => ({ valid: true, assessments: Array.from({ length: count }, (_, i) => ({
  id: String(i), references: Array(6).fill(true), hierarchy: Array(2).fill(true), complete: true,
})) });
export const definition = {
  schemaVersion: 3, slug: "smoke-temporary-id", repository: "github/gh-aw", workflowName: "Smoke Temporary ID",
  sourcePath: ".github/workflows/smoke-temporary-id.md",
  intent: { goal: contract.goal, acceptance: contract.acceptance, temporalAnchor: "workflow-adoption" },
  adoption: contract.adoption, evaluation: { mode: "attainment-only" },
  evidence: { key: "protected-temporary-id-native-join-v1", repositories: ["github/gh-aw"], contractSha256, interpreterSha256,
    opportunity: "The six directed body references and two parent-child relationships per initial smoke execution; reruns do not create new work. Confirmed and unknown execution eligibility are separate; the eligible denominator is null wherever job history cannot establish it.",
    filters: contract.filters, collection: contract.collection, measurementKind: "interval",
    window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
  model: { architecture: "Independent GitHub body and graph state joined through protected host temporary-ID receipts.",
    recommendation: "Report known native resolutions separately from unknown relationships and full acceptance; do not infer trend through evidence gaps.",
    presentation: { label: "Verified temporary-ID body references", betterLabel: "More independently verified resolved references" } },
  summary: { nativeLabel: "Verified temporary-ID body references" },
  metrics: [
    { id: "resolved-references", name: "Verified resolved body references", role: "primary",
      formula: "Count independently verified directed body-reference slots whose actual issue target equals the protected temporary-ID mapping.",
      direction: "increase", unit: "resolved references",
      presentation: { name: "Verified resolved body references", legendLabel: "Resolved references", transform: "identity" } },
    { id: "linked-children", name: "Verified child-parent graph links", role: "diagnostic",
      formula: "Count source-required child-parent edges reconstructed at the observation cutoff from complete independent GitHub graph history and protected issue mapping.",
      direction: "increase", unit: "parent-child links",
      presentation: { name: "Verified child-parent graph links", legendLabel: "Parent-child links", transform: "identity" } },
    { id: "accepted-triplets", name: "Fully accepted temporary-ID triplets", role: "diagnostic",
      formula: "Count triplets with all six reference slots, both graph edges and a protected summary comment receipt targeting the mapped parent.",
      direction: "increase", unit: "accepted triplets",
      presentation: { name: "Fully accepted temporary-ID triplets", legendLabel: "Accepted triplets", transform: "identity" } },
  ],
  validationExamples: { targetAttained: example(2), targetMissed: example(1),
    missing: { valid: false }, malformed: { valid: true, assessments: [{ id: "bad", references: ["success"] }] } },
};
export const scoreMetric = scoreTemporaryId;
export const collectBatch = requests => collectTemporaryId(requests, contract);
