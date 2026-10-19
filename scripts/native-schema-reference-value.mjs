import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const uniqueStrings = rows => Array.isArray(rows) && rows.every(row => typeof row === "string")
  && new Set(rows).size === rows.length;
export function scanSchemaReferences(evidence) {
  const native = evidence?.native;
  if (evidence?.valid !== true || native?.known !== true
    || !uniqueStrings(native.definitions) || !uniqueStrings(native.usedDefinitions) || !uniqueStrings(native.unusedDefinitions)
    || native.usedDefinitions.some(name => !native.definitions.includes(name))
    || native.unusedDefinitions.some(name => !native.definitions.includes(name) || native.usedDefinitions.includes(name))
    || native.usedDefinitions.length + native.unusedDefinitions.length !== native.definitions.length
    || !Number.isSafeInteger(native.referenceCount) || native.referenceCount < 0
    || !Number.isSafeInteger(native.schemaNodes) || native.schemaNodes < 1
    || !Array.isArray(native.unresolvedReferences) || native.unresolvedReferences.length > native.referenceCount
    || native.unresolvedReferences.some(row => typeof row?.at !== "string" || !row.at.startsWith("#")
      || typeof row?.reference !== "string" || !row.reference.startsWith("#"))
    || new Set(native.unresolvedReferences.map(row => row.at)).size !== native.unresolvedReferences.length) return null;
  return { "unused-root-definitions": native.unusedDefinitions.length,
    "unresolved-local-references": native.unresolvedReferences.length,
    definitions: native.definitions.length, references: native.referenceCount };
}

export function scoreSchemaReferences(id, evidence) {
  if (!["unused-root-definitions", "unresolved-local-references"].includes(id)) throw new Error("Unknown schema reference metric");
  return scanSchemaReferences(evidence)?.[id] ?? null;
}

export function nativeSchemaReferenceModule(contract) {
  if (!["unused-root-definitions", "unresolved-local-references"].includes(contract.primaryMetric)
    || contract.interpreterSha256 !== hash(readFileSync(import.meta.filename))) throw new Error("Frozen schema reference predicate changed");
  const unused = contract.primaryMetric === "unused-root-definitions";
  const sample = failed => ({ valid: true, native: { known: true, definitions: ["example"],
    usedDefinitions: failed ? [] : ["example"], unusedDefinitions: failed ? ["example"] : [],
    referenceCount: 1, unresolvedReferences: failed ? [{ at: "#/properties/example", reference: "#/$defs/missing" }] : [],
    schemaNodes: 3 } });
  const metric = (id, name, label, unit, formula) => ({ id, role: id === contract.primaryMetric ? "primary" : "diagnostic",
    name, unit, direction: "decrease", formula, presentation: { name, legendLabel: label, transform: "identity" } });
  return { definition: { schemaVersion: 3, slug: contract.workflowId, repository: contract.repository,
    workflowName: contract.workflowName, sourcePath: contract.sourcePath,
    intent: { goal: unused ? "Keep the main workflow schema's root definitions connected to its actual evaluation structure."
      : "Keep declared local references in the main workflow schema resolvable to schema values.",
      acceptance: "Independent pinned Draft-7/JSON Pointer replay checks immutable main schemas. Definition reachability follows applicable schema children and local references, not literal name occurrence. These are static schema facets, not proof of correctly required fields, implementation/docs agreement or workflow causation.",
      temporalAnchor: "workflow-adoption" },
    adoption: contract.adoption, evaluation: { mode: "attainment-only" },
    evidence: { key: "native-schema-reference-graph-v1", repositories: [contract.repository],
      sourcePolicySha256: censusDigest(contract),
      opportunity: unused ? "Every root $defs entry in the immutable main workflow schema at each endpoint."
        : "Every declared local $ref occurrence at schema locations in the immutable main workflow schema.",
      filters: ["Use the native referencing resolver and Draft-7 metaschema validation; never retrieve remote schemas.",
        "Resolve escaped/percent-encoded JSON Pointer tokens through the native resolver.",
        "Traverse schema keywords, not annotation examples, defaults or arbitrary JSON strings.",
        "A definition cycle without a path from the evaluation root is unused; do not count its internal self-references as usage.",
        "Draft-7 $ref siblings do not create evaluation reachability. Definition containers store schemas but do not execute them.",
        "External/anchor references and nested resource/dialect changes stay unknown under this closed local-pointer profile.",
        "Keep unresolved references separate from unreachable definitions; unresolved links make definition reachability partial.",
        "An absent required array is not a proven defect: optional properties can be intentional.",
        "Changing definition/reference populations are explicit; snapshots are not new weekly delivery."],
      collection: "Bounded immutable source archives and native offline schema-reference receipts with pinned dependency closure.",
      measurementKind: "snapshot", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "One shared immutable schema acquisition; separate goal-specific native metrics and denominators.",
      recommendation: "Review static reference gaps and unreachable definitions alongside intended schema/implementation behavior.",
      presentation: { label: unused ? "Root schema definition usage" : "Local schema reference integrity",
        betterLabel: unused ? "Fewer unreachable root definitions" : "Fewer unresolved local references" } },
    summary: { nativeLabel: unused ? "Unreachable root definitions" : "Unresolved local references" },
    metrics: [
      metric("unused-root-definitions", "Unreachable root schema definitions", "Unused definitions", "definitions",
        "Count root $defs entries not reachable from the evaluation root through applicable schema children and resolved local references."),
      metric("unresolved-local-references", "Unresolved local schema references", "Unresolved references", "references",
        "Count declared local $ref occurrences whose native JSON Pointer resolution is absent or does not target a valid Draft-7 schema object/boolean."),
    ],
    validationExamples: { targetAttained: sample(false), targetMissed: sample(true), missing: { valid: false },
      malformed: { valid: true, native: { ...sample(false).native, referenceCount: "one" } } } },
  scoreMetric: scoreSchemaReferences, collectBatch(requests) {
    const index = readCensusJson(`${contract.directory}/index.json`);
    const facts = readCensusJson(`${contract.directory}/facts.json.gz`);
    if (!index.complete || index.factsSha256 !== censusDigest(facts) || index.repository !== contract.repository
      || index.sourceRevision !== contract.sourceRevision || index.until !== contract.until
      || !index.contracts.includes(censusDigest(contract))) throw new Error("Native schema reference evidence changed");
    const features = new Map(facts.features.map(row => [row.id, row]));
    if (features.size !== facts.features.length) throw new Error("Duplicate native schema reference facts");
    return requests.map(request => {
      if (request.repository && request.repository !== contract.repository) throw new Error("Native schema reference repository mismatch");
      const state = facts.states.find(state => state.windowEnd === request.windowEnd);
      const native = features.get(state?.schemaGitBlob);
      const evidence = { valid: native?.known === true, native: native ?? null };
      const scan = scanSchemaReferences(evidence);
      const comparable = scan !== null && (!unused || scan["unresolved-local-references"] === 0);
      return { evidence: { ...evidence, coverageStatus: comparable ? "complete" : scan ? "partial" : "unknown",
        maturityStatus: "matured", eligibleCount: scan?.[unused ? "definitions" : "references"] ?? null,
        missingReason: comparable ? null : scan ? "Unresolved references prevent complete definition reachability."
          : native?.reason ?? "No immutable main schema retained for this endpoint.",
        fullGoalAcceptance: "not-measured", requiredFieldCorrectness: "not-measured",
        implementationAgreement: "not-measured", workflowCausation: "not-measured", costs: "not-measured" },
      provenance: [{ repository: contract.repository, kind: "immutable-workflow-source", ref: contract.sourceGitBlob },
        { repository: contract.repository, kind: "native-schema-reference-index", ref: censusDigest(index) }],
      commit: state?.commit ?? contract.sourceRevision };
    });
  } };
}
