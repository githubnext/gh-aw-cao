import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const modelCatalogPaths = ["pkg/cli/data/models.json", "actions/setup/js/models.json"];
export function scanModelFormatting(evidence) {
  if (evidence?.valid !== true || !Array.isArray(evidence.files) || evidence.files.length !== modelCatalogPaths.length
    || new Set(evidence.files.map(file => file?.path)).size !== modelCatalogPaths.length
    || evidence.files.some(file => !modelCatalogPaths.includes(file?.path) || typeof file.formatted !== "boolean")) return null;
  return { "unformatted-model-catalogs": evidence.files.filter(file => !file.formatted).length, eligible: evidence.files.length };
}
export function scoreModelFormatting(id, evidence) {
  if (id !== "unformatted-model-catalogs") throw new Error("Unknown native model-format metric");
  return scanModelFormatting(evidence)?.[id] ?? null;
}
export function nativeModelFormatModule(contract) {
  if (contract.interpreterSha256 !== hash(readFileSync(import.meta.filename))
    || censusDigest(contract.paths) !== censusDigest(modelCatalogPaths)) throw new Error("Frozen model-format predicate changed");
  const example = formatted => ({ valid: true, files: modelCatalogPaths.map(path => ({ path, formatted })) });
  return { definition: { schemaVersion: 3, slug: contract.workflowId, repository: contract.repository,
    workflowName: "CI Cleaner", sourcePath: contract.sourcePath,
    intent: { goal: "Keep the two model catalogs targeted by the source's fmt-json recipe natively formatted.",
      acceptance: "Both source-declared model catalog files are unignored, parseable JSON and byte-identical to pinned native Prettier output under the frozen JSON configuration. This is the model-formatting facet, not full CI recovery.",
      temporalAnchor: "workflow-adoption" },
    adoption: contract.adoption, evaluation: { mode: "attainment-only" },
    evidence: { key: "native-model-catalog-format-v1", repositories: [contract.repository],
      sourcePolicySha256: censusDigest(contract), opportunity: "The two explicit model-catalog paths in the frozen fmt-json recipe.",
      filters: ["Use pinned native Prettier, not JSON.stringify or a successful formatting job as a substitute.",
        "Never execute repository configuration code, scripts, plugins or Makefile recipes.",
        "Retain native output hashes, original immutable inputs, effective ignore results and configuration/recipe identities.",
        "Missing catalogs, invalid JSON, ignored targets or unsupported configuration profiles remain unknown.",
        "Historic reference-tool quantities are not proof that older formatting policies failed.",
        "Only stable source-declared recipe and JSON configuration intervals are comparable; keep other intent eras visible.",
        "Formatting conformance is a repository snapshot, not fresh workflow delivery or proof of CI repair.",
        "Go/JavaScript formatting, lint, tests, model correctness, attribution, regressions and costs remain unmeasured."],
      collection: "Immutable adoption/weekly/cutoff input blobs and source policies, native formatter identity and positive/negative probes.",
      measurementKind: "snapshot", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Native JSON formatting fixed-point checks against a source-bound two-file scope.",
      recommendation: "Inspect model-catalog formatting separately from CI status and other cleanup goals.",
      presentation: { label: "Model-catalog formatting", betterLabel: "Fewer model catalogs needing formatting" } },
    summary: { nativeLabel: "Model catalogs needing native formatting" },
    metrics: [{ id: "unformatted-model-catalogs", role: "primary", name: "Model catalogs needing formatting",
      formula: "Count the two source-declared catalogs whose original bytes differ from pinned native Prettier output.",
      unit: "catalogs", direction: "decrease",
      presentation: { name: "Model catalogs needing formatting", legendLabel: "Unformatted catalogs", transform: "identity" } }],
    validationExamples: { targetAttained: example(true), targetMissed: example(false),
      missing: { valid: false }, malformed: { valid: true, files: [{ path: modelCatalogPaths[0], formatted: "yes" }] } } },
  scoreMetric: scoreModelFormatting, collectBatch(requests) {
    const index = readCensusJson(`${contract.directory}/index.json`), facts = readCensusJson(`${contract.directory}/facts.json.gz`);
    if (!index.complete || index.contractSha256 !== censusDigest(contract) || index.factsSha256 !== censusDigest(facts)
      || index.sourceRevision !== contract.sourceRevision || index.until !== contract.until) throw new Error("Native model-format evidence changed");
    return requests.map(request => {
      if (request.repository && request.repository !== contract.repository) throw new Error("Model-format repository mismatch");
      const state = facts.states.find(item => item.windowEnd === request.windowEnd);
      const evidence = { valid: state?.known === true, files: state?.files ?? null }, scan = scanModelFormatting(evidence);
      const prior = facts.policies.filter(item => item.at <= request.windowStart).at(-1);
      const changes = facts.policies.filter(item => item.at > request.windowStart && item.at <= request.windowEnd);
      const comparable = scan !== null && state.supported && prior?.supported && changes.every(item => item.supported);
      return { evidence: { ...evidence, coverageStatus: comparable ? "complete" : scan ? "partial" : "unknown",
        maturityStatus: "matured", eligibleCount: scan?.eligible ?? null,
        missingReason: comparable ? null : state?.reason ?? "Source recipe/configuration continuity is not established.",
        ciRecovery: "not-measured", modelCorrectness: "not-measured", otherFormatting: "not-measured",
        regressionSafety: "not-measured", workflowCausation: "not-measured", costs: "not-measured", fullGoalAcceptance: "not-measured" },
      provenance: [{ repository: contract.repository, kind: "native-model-format-index", ref: censusDigest(index) }],
      commit: state?.commit ?? contract.sourceRevision };
    });
  } };
}
