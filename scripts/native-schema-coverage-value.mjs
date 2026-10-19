import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";

export function schemaUsageEvidence(state, facts) {
  if (!Array.isArray(state.properties) || !state.properties.length
    || new Set(state.properties).size !== state.properties.length) throw new Error("Invalid schema property population");
  const eligible = new Set(state.properties), covered = new Set();
  let validExamples = 0;
  for (const source of state.examples) {
    const fact = facts.get(source.fact);
    if (!fact || fact.schema !== state.schema || fact.blob !== source.blob
      || typeof fact.valid !== "boolean" || !Array.isArray(fact.properties)
      || new Set(fact.properties).size !== fact.properties.length
      || fact.properties.some(property => !eligible.has(property))
      || !fact.valid && fact.properties.length) throw new Error("Invalid native schema usage proof");
    if (fact.valid) {
      validExamples += 1;
      for (const property of fact.properties) covered.add(property);
    }
  }
  return { valid: true, coverageStatus: "complete", eligibleCount: eligible.size, coveredProperties: covered.size,
    uncoveredProperties: eligible.size - covered.size, examplesChecked: state.examples.length,
    validExamples, covered: [...covered].sort(), stateSha256: censusDigest(state),
    compilerAcceptance: "not-measured", workflowContribution: "not-measured", costs: "not-measured" };
}

export function scoreSchemaUsage(id, evidence) {
  if (!["uncovered-properties", "covered-properties", "coverage-percent"].includes(id)
    || evidence?.valid !== true || ![evidence.eligibleCount, evidence.coveredProperties,
      evidence.uncoveredProperties, evidence.examplesChecked, evidence.validExamples]
      .every(value => Number.isSafeInteger(value) && value >= 0)
    || evidence.eligibleCount === 0 || evidence.coveredProperties + evidence.uncoveredProperties !== evidence.eligibleCount
    || evidence.validExamples > evidence.examplesChecked
    || evidence.coveredProperties > 0 && evidence.validExamples === 0) return null;
  if (id === "coverage-percent") return 100 * evidence.coveredProperties / evidence.eligibleCount;
  return id === "covered-properties" ? evidence.coveredProperties : evidence.uncoveredProperties;
}

export function nativeSchemaCoverageModule(contract) {
  if (contract.nativeModelSha256 !== createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex")) {
    throw new Error("Frozen schema usage interpreter changed");
  }
  const sample = covered => ({ valid: true, eligibleCount: 2, coveredProperties: covered,
    uncoveredProperties: 2 - covered, examplesChecked: 2, validExamples: 2 });
  const presentation = label => ({ name: label, legendLabel: label, transform: "identity" });
  const definition = {
    schemaVersion: 3, slug: contract.workflowId, repository: contract.repository,
    workflowName: "Schema Feature Coverage", sourcePath: `.github/workflows/${contract.workflowId}.md`,
    intent: { goal: "Provide usage examples for every top-level main workflow schema property.",
      acceptance: "Partial facet: a property occurs as a root frontmatter key in at least one structurally Draft-7-valid standalone workflow/demo, using the main schema at the same immutable revision. Format annotations, compiler semantics and imported partial fragments remain separate.",
      temporalAnchor: "workflow-adoption" },
    adoption: contract.adoption, evaluation: { mode: "attainment-only" },
    evidence: { key: "structurally-validated-schema-usage-v1", repositories: [contract.repository],
      nativeModelSha256: contract.nativeModelSha256, validatorSha256: contract.validatorSha256,
      opportunity: "All top-level schema properties and Markdown files under .github/workflows/ and schema-demos/ at each immutable state.",
      filters: ["Parse actual root YAML frontmatter, not prose, nested keys or fenced examples.",
        "Only main-schema-valid standalone documents supply coverage. Imported fragments lacking a trigger do not qualify for this partial facet.",
        "The pinned independent Draft-7 validator never retrieves remote references or treats format annotations as assertions.",
        "Invalid YAML and schema-invalid examples are recorded and cannot supply property credit.",
        "Repository coverage is a state, not fresh weekly delivery, compiler acceptance or workflow causation."],
      collection: "Replay digest-checked native validations from immutable Git snapshots; acquisition uses YAML 2.9 and jsonschema 4.23.0.",
      measurementKind: "snapshot", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Independent structural schema validation and root-key set coverage.",
      recommendation: "Review native example coverage separately from compiler acceptance, attribution and costs.",
      presentation: { label: "Validated schema usage", betterLabel: "Fewer properties without a validated standalone example" } },
    summary: { nativeLabel: "Schema properties without validated standalone usage" },
    metrics: [
      { id: "uncovered-properties", role: "primary", name: "Properties without structurally valid standalone usage",
        unit: "properties", direction: "decrease", formula: "current schema properties minus the union of validated root-key usages",
        presentation: presentation("Uncovered properties") },
      { id: "covered-properties", role: "diagnostic", name: "Properties with structurally valid standalone usage",
        unit: "properties", direction: "increase", formula: "distinct schema properties in validated standalone root frontmatter",
        presentation: presentation("Covered properties") },
      { id: "coverage-percent", role: "diagnostic", name: "Validated standalone schema coverage",
        unit: "percent", direction: "increase", formula: "covered properties * 100 / current schema property population",
        presentation: presentation("Validated coverage") },
    ],
    validationExamples: { targetAttained: sample(2), targetMissed: sample(0),
      missing: {}, malformed: { ...sample(2), coveredProperties: "two" } },
  };
  return { definition, scoreMetric: scoreSchemaUsage, collectBatch(requests) {
    const directory = "docs/operational-value/proof/schema-usage";
    const index = readCensusJson(`${directory}/index.json.gz`);
    if (index.complete !== true || index.repository !== contract.repository || index.sourceRevision !== contract.sourceRevision
      || index.until !== contract.until || index.nativeModelSha256 !== contract.nativeModelSha256
      || index.validatorSha256 !== contract.validatorSha256) throw new Error("Native schema archive scope changed");
    const facts = new Map(index.partitions.flatMap(part => {
      if (!/^facts-\d{3}\.json\.gz$/.test(part.file)) throw new Error("Unsafe schema proof partition");
      const rows = readCensusJson(`${directory}/${part.file}`);
      if (censusDigest(rows) !== part.sha256 || rows.length !== part.count) throw new Error("Native schema proofs changed");
      return rows.map(row => [row.id, row]);
    }));
    return requests.map(request => {
      if (request.repository && request.repository !== contract.repository) throw new Error("Native schema repository mismatch");
      const state = index.states.find(row => row.windowEnd === request.windowEnd);
      if (!state) return { evidence: { valid: false, missingReason: "No preserved native schema state at this endpoint." },
        provenance: [{ repository: contract.repository, kind: "immutable-git-head", ref: contract.sourceRevision }] };
      return { evidence: schemaUsageEvidence(state, facts), commit: state.commit,
        provenance: [{ repository: contract.repository, kind: "immutable-git-tree", ref: state.tree },
          { repository: contract.repository, kind: "schema-usage-state-sha256", ref: censusDigest(state) }] };
    });
  } };
}
