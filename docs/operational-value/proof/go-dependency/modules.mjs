import { readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { cutoff, readBootstrap, readCustody, repository, revision, sha256 } from "./custody.mjs";
import { analyzeAssertions, assertionTransitions, dependencyTarget } from "./native.mjs";

const base = new URL("./", import.meta.url);
const read = file => JSON.parse(readFileSync(new URL(file, base)));
const original = read("contracts-v1.json");
const instrument = read("instrument-v2.json");
const burnerEra = read("burner-era-v3.json");
if (sha256(readFileSync(new URL("contracts-v1.json", base))) !== instrument.predecessor.sha256) {
  throw new Error("Original strict dependency contracts changed");
}
readBootstrap();

const validWindow = request => request && [request.windowStart, request.windowEnd, request.observedAt].every(value =>
  typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value) && Number.isFinite(Date.parse(value)))
  && request.windowStart < request.windowEnd && request.windowEnd <= request.observedAt
  && (request.repository === undefined || request.repository === repository);

export function scoreUpdateInput(input, options) {
  if (!input || typeof input.before !== "string" || typeof input.after !== "string"
    || typeof input.target?.module !== "string" || typeof input.target?.from !== "string"
    || typeof input.target?.to !== "string") return null;
  return dependencyTarget(input.before, input.after, input.target, options).value;
}

export function scoreUsageInput(input) {
  if (!input || typeof input.before !== "string" || typeof input.after !== "string") return null;
  return assertionTransitions(...analyzeAssertions([
    { id: "before.go", text: input.before }, { id: "after.go", text: input.after },
  ])).value;
}

export function dependencyModule(config, evaluateCases, scoreInput) {
  const contract = original.contracts.find(row => row.slug === config.slug);
  if (!contract) throw new Error("Unknown dependency outcome contract");
  for (const [file, expected] of Object.entries(config.bindings)) {
    if (sha256(readFileSync(new URL(file, base))) !== expected) throw new Error(`Frozen dependency interpreter changed: ${file}`);
  }
  const profilesBytes = readFileSync(new URL("profiles.json", base));
  if (sha256(profilesBytes) !== config.profilesSha256) throw new Error("Frozen native case profiles changed");
  const profiles = JSON.parse(profilesBytes);
  const workflow = profiles.workflows.find(row => row.slug === config.slug);
  if (!workflow) throw new Error("Missing frozen dependency workflow profile");
  const custody = readCustody(new URL("cache-originals.json.br", base), config.custodySha256);
  const info = custody.commit(workflow.adoption.commit), sourcePath = `.github/workflows/${config.slug}.md`;
  if (info.at !== workflow.adoption.adoptedAt || info.parents[0] !== workflow.adoption.parent
    || custody.resolve(workflow.adoption.parent, sourcePath) !== null
    || !custody.resolve(workflow.adoption.commit, sourcePath)) throw new Error("Invalid dependency source introduction anchor");
  let retained;
  function facts() {
    if (retained) return retained;
    const bytes = readFileSync(new URL("selected-originals.json.br", base));
    if (sha256(bytes) !== config.originalsSha256) throw new Error("Selected public originals changed");
    const originals = JSON.parse(brotliDecompressSync(bytes, { maxOutputLength: 16 * 1024 * 1024 }));
    retained = evaluateCases({ custody, originals, workflow, profiles });
    if (!Array.isArray(retained) || new Set(retained.map(row => row.id)).size !== retained.length
      || retained.some(row => !row.id || typeof row.at !== "string" || !Number.isFinite(Date.parse(row.at))
        || (row.value !== null && (!Number.isSafeInteger(row.value) || row.value < 0)))) {
      throw new Error("Malformed native case evaluation");
    }
    return retained;
  }
  const metric = (id, name, role, label) => ({
    id, name, role, direction: "increase", unit: workflow.unit,
    formula: id === "native-partial" ? "Sum independently verified native partial deliveries in evaluated retained cases within this disjoint interval; null when no eligible retained case was evaluated."
      : "The same native deliveries restricted to original recommendation and implementation-reference matches; shared contribution, not sole causation.",
    presentation: { name, legendLabel: label, transform: "identity" },
  });
  const goExample = after => ({
    kind: "native-validation-input", nativeInput: {
      before: 'package example\nimport "github.com/stretchr/testify/assert"\nfunc TestExample() { assert.Contains(t, err.Error(), "wanted") }\n',
      after,
    },
  });
  const manifestExample = after => ({
    kind: "native-validation-input", nativeInput: {
      before: "module example.com/test\nrequire github.com/example/module v1.2.3\n",
      after: `module example.com/test\nrequire github.com/example/module ${after}\n`,
      target: { module: "github.com/example/module", from: "v1.2.3", to: "v1.2.4" },
    },
  });
  const examples = config.slug === "go-fan" ? {
    targetAttained: goExample('package example\nimport "github.com/stretchr/testify/require"\nfunc TestExample() { require.ErrorContains(t, err, "wanted") }\n'),
    targetMissed: goExample('package example\nimport "github.com/stretchr/testify/assert"\nfunc TestExample() { assert.Contains(t, err.Error(), "wanted") }\n'),
  } : { targetAttained: manifestExample("v1.2.4"), targetMissed: manifestExample("v1.2.3") };
  const definition = {
    schemaVersion: 3, slug: config.slug, repository,
    workflowName: `${workflow.name} - explicitly partial native deliveries`,
    sourcePath,
    intent: { goal: workflow.goal ?? contract.goal, acceptance: workflow.partialAcceptance, temporalAnchor: "workflow-adoption" },
    adoption: { commit: workflow.adoption.commit, adoptedAt: workflow.adoption.adoptedAt, baselineCommit: null, baselineAt: null },
    evaluation: { mode: "attainment-only" },
    evidence: {
      key: `${config.slug}-native-partial-${config.slug === "dependabot-burner" ? "v3" : "v2"}`, repositories: [repository],
      opportunity: workflow.scope,
      filters: [
        "Retrospective fixed-reference and selected-case assessment; not complete historical repository or workflow output coverage.",
        "Immutable actual merge/first-parent source transitions only; one opportunity is counted in one interval.",
        "Periods without evaluated eligible cases are unknown, never zero workflow delivery.",
        "Original strict acceptance, behavior safeguards, historical executor continuity and authoritative creation receipts remain separate.",
      ],
      collection: "Offline replay of digest-checked original Git commits, trees and source blobs plus bounded public GitHub originals; no target code or network execution.",
      measurementKind: "interval", window: {
        durationDays: original.period.durationDays, cadenceDays: original.period.cadenceDays, maturationDays: original.period.maturationDays,
      },
      sourceGitBlob: contract.sourceGitBlob, profilesSha256: config.profilesSha256,
      originalContractSha256: instrument.predecessor.sha256, interpreterBindings: config.bindings,
      historicalGoalReference: config.slug === "dependabot-burner"
        ? { revision: burnerEra.sourceRevision, blob: burnerEra.sourceGitBlob, contract: "burner-era-v3.json" } : null,
    },
    model: {
      architecture: "Goal-specific native interpreter over portable immutable originals; only custody and scheduling are shared.",
      recommendation: "Not rated: no agreed keep bar or complete comparable history. Do not interpret selected-case missing periods as deterioration.",
      presentation: { label: workflow.nativeLabel, betterLabel: "More independently established native partial deliveries" },
    },
    summary: { nativeLabel: workflow.nativeLabel },
    metrics: [metric("native-partial", workflow.nativeLabel, "primary", "Native partial delivery"),
      metric("corroborated-partial", "Corroborated shared workflow contribution", "diagnostic", "Corroborated delivery")],
    signal: { metricId: "corroborated-partial", basis: "workflow-contribution" },
    validationExamples: { ...examples, missing: {}, malformed: { kind: "native-validation-input", nativeInput: { before: 1, after: false } } },
    limitations: {
      strictFullGoalAcceptance: null,
      strictAcceptanceRule: config.slug === "dependabot-burner" ? burnerEra.strictAcceptance : contract.strictAcceptance,
      originalCurrentReferenceStrictAcceptance: contract.strictAcceptance,
      behaviorPreservation: null, sourceExecutorContinuity: null, authoritativeCreationReceipts: null,
      wholePopulationPeriodTotals: null, actualCosts: null, keepDecision: "not rated",
      originalContractPreserved: "contracts-v1.json",
      instrument: config.slug === "dependabot-burner" ? "burner-era-v3.json" : "instrument-v2.json",
      sourceIntroductionIsNotGoalContinuity: true,
    },
  };
  function scoreMetric(id, evidence) {
    if (!definition.metrics.some(metric => metric.id === id) || !evidence) return null;
    if (evidence.kind === "native-validation-input") return scoreInput(evidence.nativeInput);
    if (evidence.kind !== "retained-native-cases" || evidence.profilesSha256 !== config.profilesSha256
      || !validWindow(evidence) || evidence.windowEnd > cutoff || evidence.windowStart < workflow.adoption.adoptedAt) return null;
    const rows = facts().filter(row => row.at >= evidence.windowStart && row.at < evidence.windowEnd);
    if (!Array.isArray(evidence.caseIds) || JSON.stringify(evidence.caseIds) !== JSON.stringify(rows.map(row => row.id))) return null;
    const known = rows.filter(row => row.value !== null && (id === "native-partial" || row.corroborated));
    return known.length ? known.reduce((sum, row) => sum + row.value, 0) : null;
  }
  async function collectBatch(requests) {
    if (!Array.isArray(requests) || !requests.every(validWindow)) throw new Error("Invalid dependency observation windows or repository");
    const rows = facts();
    return requests.map(request => {
      const available = request.windowStart >= workflow.adoption.adoptedAt && request.windowEnd <= cutoff;
      const selected = available ? rows.filter(row => row.at >= request.windowStart && row.at < request.windowEnd) : [];
      const evaluated = selected.filter(row => row.value !== null);
      return {
        evidence: {
          kind: "retained-native-cases", profilesSha256: config.profilesSha256, ...request,
          caseIds: selected.map(row => row.id), evaluatedCases: evaluated.length,
          missingCases: selected.filter(row => row.value === null).map(row => ({ id: row.id, reason: row.reason })),
          nativeFacts: evaluated.map(row => ({ id: row.id, native: row.native, attribution: row.attribution })),
          coverageStatus: evaluated.length ? "partial-selected-cohort" : "missing",
          fullEligiblePopulation: null, completeComparablePeriod: false,
          strictFullGoalAcceptance: null, safeguards: null, authoritativeCreationReceipts: null,
          actualCosts: null, keepDecision: "not rated",
          missingReason: evaluated.length ? null : available
            ? "No evaluated eligible retained case in this interval; complete workflow delivery is unknown."
            : "Window outside retained fixed-cutoff source-introduction scope.",
        },
        provenance: [
          { repository, kind: "native-go-dependency-originals", ref: config.originalsSha256 },
          { repository, kind: "native-go-dependency-git-custody", ref: config.custodySha256 },
          { repository, kind: "native-go-dependency-profiles", ref: config.profilesSha256 },
          { repository, kind: "frozen-workflow-source", ref: `${revision}:${sourcePath}` },
        ],
      };
    });
  }
  return { definition, collectBatch, scoreMetric };
}
