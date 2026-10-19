import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";

export function scoreLedgerProjection(id, evidence) {
  if (!["verified-rows", "unmatched-rows"].includes(id) || evidence?.valid !== true
    || evidence.readOnly !== true || !Number.isSafeInteger(evidence.eligible) || evidence.eligible <= 0
    || !Number.isSafeInteger(evidence.matched) || evidence.matched < 0 || evidence.matched > evidence.eligible) return null;
  return id === "verified-rows" ? evidence.matched : evidence.eligible - evidence.matched;
}

export function ledgerProjectionModule(contract) {
  if (contract.interpreterSha256 !== createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex")) {
    throw new Error("Frozen ledger projection interpreter changed");
  }
  const example = matched => ({ valid: true, readOnly: true, eligible: 2, matched });
  const definition = {
    schemaVersion: 3, slug: contract.workflowId, repository: contract.repository,
    workflowName: contract.name, sourcePath: `.github/workflows/${contract.workflowId}.md`,
    intent: { goal: contract.goal, acceptance: contract.acceptance, temporalAnchor: "workflow-adoption" },
    adoption: contract.adoption, evaluation: { mode: "attainment-only" },
    evidence: { key: "native-durable-ledger-projection-v1", repositories: [contract.repository],
      interpreterSha256: contract.interpreterSha256, oracleSha256: contract.oracleSha256,
      nativeSourcesSha256: censusDigest(contract.nativeSources), configuration: contract.config,
      opportunity: "Persisted source-defined run fixtures in the retained canonical ledger branch lineage.",
      filters: ["The pinned production ledger reconstruction, reducer and SQLite materializer must restore the actual immutable records.",
        "An independent expected-fixture oracle compares actual read-only SQLite rows, not an agent's passed flag.",
        "Snapshots are maintained repository condition, not fresh delivery each week or proof an agent inspected its projection.",
        "Branch recreation, unsupported historical formats, other ledger types, note truth, workflow causation and costs remain separate.",
        contract.limitation],
      collection: "Bounded immutable ledger commits and safe fixture blobs, reconstructed once outside offline scoring.",
      measurementKind: "snapshot", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Production canonical ledger-to-SQLite replay checked against the source-defined native fixture.",
      recommendation: "Read retained native rows alongside missingness and scope; do not infer overall engine quality from a growing fixture cohort.",
      presentation: { label: "Replay-verified durable rows", betterLabel: "More native fixture rows preserved correctly" } },
    summary: { nativeLabel: "Replay-verified durable rows" },
    metrics: [
      { id: "verified-rows", role: "primary", name: "Replay-verified durable rows", unit: "rows",
        direction: "increase", formula: "Count distinct eligible persisted fixtures restored exactly by production replay into read-only SQLite.",
        presentation: { name: "Replay-verified durable rows", legendLabel: "Verified durable rows", transform: "identity" } },
      { id: "unmatched-rows", role: "diagnostic", name: "Unmatched durable fixture rows", unit: "rows",
        direction: "decrease", formula: "Eligible persisted fixtures minus exactly restored native rows.",
        presentation: { name: "Unmatched durable fixture rows", legendLabel: "Unmatched rows", transform: "identity" } },
    ],
    validationExamples: { targetAttained: example(2), targetMissed: example(1),
      missing: { valid: false }, malformed: { ...example(2), matched: 3 } },
  };
  return { definition, scoreMetric: scoreLedgerProjection, collectBatch(requests) {
    const directory = "docs/operational-value/proof/ledger-projections";
    const index = readCensusJson(`${directory}/${contract.workflowId}-index.json`);
    if (!index.complete || index.contractSha256 !== censusDigest(contract)
      || !/^[a-z0-9-]+-states\.json\.gz$/.test(index.statesFile)) throw new Error("Ledger projection acquisition scope changed");
    const states = readCensusJson(`${directory}/${index.statesFile}`);
    if (censusDigest(states) !== index.statesSha256) throw new Error("Ledger projection facts changed");
    return requests.map(request => {
      if (request.repository && request.repository !== contract.repository) throw new Error("Ledger projection repository mismatch");
      const state = states.filter(state => state.at <= request.windowEnd).at(-1);
      const valid = Boolean(state?.result.status === "available" && request.windowEnd <= contract.until);
      return { evidence: { valid, readOnly: valid && state.result.readOnly,
        eligible: valid ? state.result.eligible : null, matched: valid ? state.result.matched : null,
        sourceCommit: state?.commit ?? null, sourceAt: state?.at ?? null,
        missingReason: valid ? null : state?.result.reason ?? "No retained immutable ledger state exists at this endpoint.",
        fullGoalAcceptance: "not-measured", workflowCausation: "not-measured", costs: "not-measured",
        limitation: contract.limitation },
      provenance: [{ repository: contract.repository, kind: "immutable-workflow-source", ref: contract.sourceGitBlob },
        { repository: contract.repository, kind: "native-ledger-projection-index", ref: censusDigest(index) }],
      commit: state?.commit ?? contract.sourceRevision };
    });
  } };
}
