import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";
import { schemaUsageEvidence, scoreSchemaUsage } from "./native-schema-coverage-value.mjs";

export function safeOutputFixtureEvidence(state, facts) {
  const eligible = new Set(state.properties);
  const selected = new Map();
  for (const source of state.examples) {
    const fact = facts.get(source.fact);
    if (!fact || !Array.isArray(fact.safeOutputProperties)
      || new Set(fact.safeOutputProperties).size !== fact.safeOutputProperties.length
      || fact.safeOutputProperties.some(name => typeof name !== "string")
      || !fact.valid && fact.safeOutputProperties.length) throw new Error("Invalid safe-output fixture proof");
    selected.set(source.fact, { ...fact, properties: fact.safeOutputProperties.filter(name => eligible.has(name)) });
  }
  return { ...schemaUsageEvidence(state, selected), scope: "static-registered-safe-output-types",
    runtimeExercise: "not-measured", compilerTestAcceptance: "not-measured" };
}

export function nativeSafeOutputFixtureModule(contract) {
  const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
  if (hash(import.meta.filename) !== contract.nativeModelSha256
    || hash(new URL("./native-schema-coverage-value.mjs", import.meta.url)) !== contract.schemaInterpreterSha256) {
    throw new Error("Frozen fixture coverage interpreter changed");
  }
  const sample = covered => ({ valid: true, eligibleCount: 2, coveredProperties: covered,
    uncoveredProperties: 2 - covered, examplesChecked: 2, validExamples: 2 });
  const presentation = name => ({ name, legendLabel: name, transform: "identity" });
  const definition = {
    schemaVersion: 3, slug: contract.workflowId, repository: contract.repository,
    workflowName: "Daily Safe Output Integrator", sourcePath: `.github/workflows/${contract.workflowId}.md`,
    intent: { goal: "Provide meaningful fixture and compiler assertion coverage for every supported safe-output type.",
      acceptance: "Partial facet: statically registered safe-output tools with a canonical safe-outputs schema key have a structurally valid standalone pkg/cli/workflows/test-*.md declaration at the same immutable revision. Runtime exercise, imported-only fixtures, dynamic tools and Go compiler assertions remain separate.",
      temporalAnchor: "workflow-adoption" },
    adoption: contract.adoption, evaluation: { mode: "attainment-only" },
    evidence: { key: "validated-static-safe-output-fixtures-v1", repositories: [contract.repository],
      nativeModelSha256: contract.nativeModelSha256, schemaInterpreterSha256: contract.schemaInterpreterSha256,
      validatorSha256: contract.validatorSha256, yamlVersion: contract.yamlVersion, validatorVersion: contract.validatorVersion,
      opportunity: "Static safe_outputs_tools.json tool names mapped from underscores to schema hyphens and intersected with canonical safe-outputs properties.",
      filters: ["Validate actual standalone fixture frontmatter against the same-revision Draft-7 main schema.",
        "Only direct safe-outputs keys in valid test-*.md fixtures supply declaration coverage.",
        "Configuration-only keys and tools outside the canonical schema intersection do not create false fixture gaps.",
        "Fixture availability is repository state, not fresh delivery, compiler acceptance or workflow causation."],
      collection: "Replay digest-checked immutable fixture/schema/registry facts; independent validation denies remote schema retrieval.",
      measurementKind: "snapshot", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Independent same-revision structural validation and registered-type declaration coverage.",
      recommendation: "Review native fixture gaps separately from compiler assertions and runtime exercise.",
      presentation: { label: "Safe-output fixture coverage", betterLabel: "Fewer registered types without valid fixtures" } },
    summary: { nativeLabel: "Registered safe-output types without valid standalone fixtures" },
    metrics: [
      { id: "uncovered-properties", role: "primary", name: "Registered safe-output types without valid fixtures",
        unit: "types", direction: "decrease", formula: "eligible registered types minus distinct validated fixture declarations",
        presentation: presentation("Types without fixtures") },
      { id: "covered-properties", role: "diagnostic", name: "Registered safe-output types with valid fixtures",
        unit: "types", direction: "increase", formula: "eligible registered types declared in at least one validated standalone fixture",
        presentation: presentation("Types with fixtures") },
      { id: "coverage-percent", role: "diagnostic", name: "Validated static safe-output fixture coverage",
        unit: "percent", direction: "increase", formula: "covered registered types * 100 / eligible registered types",
        presentation: presentation("Validated coverage") },
    ],
    validationExamples: { targetAttained: sample(2), targetMissed: sample(0),
      missing: {}, malformed: { ...sample(2), coveredProperties: "two" } },
  };
  return { definition, scoreMetric: scoreSchemaUsage, collectBatch(requests) {
    const directory = "docs/operational-value/proof/safe-output-fixtures";
    const index = readCensusJson(`${directory}/index.json.gz`);
    if (index.complete !== true || index.repository !== contract.repository || index.sourceRevision !== contract.sourceRevision
      || index.until !== contract.until || index.nativeModelSha256 !== contract.nativeModelSha256
      || index.schemaInterpreterSha256 !== contract.schemaInterpreterSha256 || index.validatorSha256 !== contract.validatorSha256
      || index.yamlVersion !== contract.yamlVersion || index.validatorVersion !== contract.validatorVersion) {
      throw new Error("Native fixture archive scope changed");
    }
    const facts = new Map(index.partitions.flatMap(part => {
      if (!/^facts-\d{3}\.json\.gz$/.test(part.file)) throw new Error("Unsafe fixture proof partition");
      const rows = readCensusJson(`${directory}/${part.file}`);
      if (censusDigest(rows) !== part.sha256 || rows.length !== part.count) throw new Error("Native fixture proofs changed");
      return rows.map(row => [row.id, row]);
    }));
    return requests.map(request => {
      if (request.repository && request.repository !== contract.repository) throw new Error("Native fixture repository mismatch");
      const state = index.states.find(row => row.windowEnd === request.windowEnd);
      if (!state) return { evidence: { valid: false, missingReason: "No preserved fixture state at this endpoint." },
        provenance: [{ repository: contract.repository, kind: "immutable-git-head", ref: contract.sourceRevision }] };
      return { evidence: safeOutputFixtureEvidence(state, facts), commit: state.commit,
        provenance: [{ repository: contract.repository, kind: "immutable-git-tree", ref: state.tree },
          { repository: contract.repository, kind: "fixture-state-sha256", ref: censusDigest(state) }] };
    });
  } };
}
