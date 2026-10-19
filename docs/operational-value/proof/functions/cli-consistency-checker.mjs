import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { cutoff, revision, repository, normativePath, documentationPath, hash,
  sourceText, checkDocumentation, reviewNativeSource } from "../cli-consistency-checker/native.mjs";

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "../cli-consistency-checker");
const contract = readJsonArchive(path.join(directory, "contract.json"));
const literalRules = contract.rules.filter(rule => rule.expected !== null);
if (hash(JSON.stringify(contract.rules)) !== contract.rulesDigest || contract.revision !== revision
  || contract.repository !== repository || contract.cutoff !== cutoff || literalRules.length !== 22) {
  throw new Error("Invalid frozen CLI contract");
}
const examplesText = "#### `compile`\n#### `update`\n"
  + literalRules.filter(rule => rule.operation === "Contains").map(rule => rule.expected).join("\n");
const example = documentation => ({ profileDigest: contract.rulesDigest, nativeInput: { documentation } });

export const definition = {
  schemaVersion: 3, slug: "cli-consistency-checker", repository,
  workflowName: "CLI Consistency Checker - source-native documentation facet",
  sourcePath: ".github/workflows/cli-consistency-checker.md",
  intent: { goal: contract.intent.goal, acceptance: contract.intent.partialAcceptance,
    temporalAnchor: "contract-activation" },
  adoption: { commit: revision, adoptedAt: cutoff, baselineCommit: null, baselineAt: null },
  evaluation: { mode: "attainment-only" },
  evidence: {
    key: "cli-consistency-checker.native-literal-doc-obligations",
    repositories: [repository],
    opportunity: contract.eligibility.included,
    filters: [contract.eligibility.excluded, contract.eligibility.scope,
      "Current frozen profile only. Historical profiles are not retroactively interpreted as this profile."],
    collection: "Digest-checked complete immutable documentation and native tests from the offline source archive. Reinterpret raw native bytes, never caller-supplied acceptance counts. No remote collection.",
    measurementKind: "snapshot",
    window: { durationDays: 1, cadenceDays: 1, maturationDays: 0 },
  },
  model: {
    architecture: "Deterministic source-native obligation checks; partial repository outcome, not a whole-command acceptance model.",
    recommendation: "Retain native partial progress; require independent help, examples and behavioral evidence before claiming full CLI usability or contribution.",
    presentation: { label: "Source-native CLI documentation obligations", betterLabel: "More native obligations attained" },
  },
  summary: { nativeLabel: "Literal documentation obligation attainment (%) - partial facet only" },
  metrics: [{
    id: "literal-documentation-attainment", name: "Native literal documentation obligation attainment",
    role: "primary", formula: "100 * passed frozen literal source-defined documentation obligations / all frozen literal source-defined documentation obligations",
    direction: "increase", unit: "percent of literal documentation obligations",
    presentation: { name: "Literal documentation conformance", legendLabel: "Native doc obligations", transform: "identity" },
  }],
  validationExamples: {
    targetAttained: example(examplesText),
    targetMissed: example("#### `compile`\n#### `update`\n`--no-models-dev-lookup`\ngraders operational-value"),
    missing: {}, malformed: { profileDigest: contract.rulesDigest, nativeInput: { documentation: 1 } },
  },
  limitations: {
    fullCommandAcceptance: null, contribution: null,
    unresolvedNativeRules: contract.rules.filter(rule => rule.expected === null).map(rule => rule.id),
    fullGoal: contract.intent.fullAcceptance,
    classification: contract.antecedentExistence,
    readiness: "Implemented partial native documentation checker, not a fully accepted CLI measurement.",
    historicalEvaluation: "Activation equals frozen cutoff; standard evaluator requires an endpoint after activation. Do not fabricate an earlier activation to produce a retrospective series.",
  },
};

export function scoreMetric(id, evidence) {
  if (id !== definition.metrics[0].id || !evidence || evidence.profileDigest !== contract.rulesDigest
    || typeof evidence.nativeInput?.documentation !== "string" || !evidence.nativeInput.documentation
    || evidence.coverageStatus === "missing") return null;
  const results = checkDocumentation(evidence.nativeInput.documentation, literalRules);
  return 100 * results.filter(rule => rule.status === "passed").length / literalRules.length;
}

function validRequest(request) {
  const iso = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)
    && Number.isFinite(Date.parse(value));
  return request && [request.windowStart, request.windowEnd, request.observedAt].every(iso)
    && request.windowStart < request.windowEnd && request.windowEnd <= request.observedAt
    && (request.repository === undefined || request.repository === repository);
}

export async function collectBatch(requests) {
  if (!Array.isArray(requests) || !requests.every(validRequest)) throw new Error("Invalid CLI evidence windows or repository");
  const needsSource = requests.some(request => request.windowEnd === cutoff);
  let nativeSource, nativeReview;
  if (needsSource) {
    nativeSource = readJsonArchive(path.join(directory, "source.json.gz"),
      { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 });
    for (const file of nativeSource.files) sourceText(nativeSource, file.path);
    nativeReview = reviewNativeSource(nativeSource, contract.rules);
  }
  return requests.map(request => {
    const evidence = {
      profileDigest: contract.rulesDigest, measurementKind: "snapshot",
      windowStart: request.windowStart, windowEnd: request.windowEnd, observedAt: request.observedAt,
      coverageStatus: "missing", maturityStatus: "unavailable", nativeInput: null,
      fullCommandAcceptance: null, producerAcceptance: null, contribution: null,
      missingReason: request.windowEnd < cutoff
        ? "Historical CLI convention/source/output closure not established; current predicates cannot be backdated."
        : "No independently established latest immutable commit or native capture exists at this requested cutoff.",
    };
    const provenance = [{ repository, kind: "frozen-source-policy",
      ref: `https://github.com/${repository}/blob/${revision}/${normativePath}` }];
    if (request.windowEnd === cutoff) {
      Object.assign(evidence, {
        nativeInput: { documentation: sourceText(nativeSource, documentationPath) },
        coverageStatus: "complete", maturityStatus: "matured", nativeReview,
        eligibleCount: literalRules.length, populationDigest: nativeReview.populationDigest,
        missingReason: null,
      });
      provenance.push({ repository, kind: "immutable-git-source",
        ref: `https://github.com/${repository}/blob/${revision}/${documentationPath}`,
        blob: nativeSource.files.find(file => file.path === documentationPath).blob,
        sha256: nativeReview.documentationDigest });
      return { evidence, provenance, commit: revision };
    }
    return { evidence, provenance };
  });
}
