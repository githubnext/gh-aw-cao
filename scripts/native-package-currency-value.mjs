import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";
import { assessVersionCurrency, compareStableVersions, scoreVersionCurrency, stableVersion } from "./native-version-currency-value.mjs";

export function satisfiesStablePackageRange(version, range) {
  const match = typeof range === "string" && range.match(/^([~^]?)(v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/);
  const actual = stableVersion(version), minimum = match && stableVersion(match[2]);
  if (!actual || !minimum) return null;
  if (!match[1]) return compareStableVersions(version, match[2]) === 0;
  if (compareStableVersions(version, match[2]) < 0) return false;
  if (match[1] === "~") return actual[0] === minimum[0] && actual[1] === minimum[1];
  return minimum[0] > 0 ? actual[0] === minimum[0]
    : minimum[1] > 0 ? actual[0] === 0 && actual[1] === minimum[1]
      : actual[0] === 0 && actual[1] === 0 && actual[2] === minimum[2];
}

export function readNativePackagePins(manifest, lock, tools) {
  const pins = {}, diagnostics = [];
  for (const tool of tools) {
    const range = manifest?.[tool.scope]?.[tool.name], rootRange = lock?.packages?.[""]?.[tool.scope]?.[tool.name];
    const installed = lock?.packages?.[`node_modules/${tool.name}`]?.version;
    const satisfies = satisfiesStablePackageRange(installed, range);
    if (![2, 3].includes(lock?.lockfileVersion) || typeof range !== "string" || range !== rootRange || satisfies !== true) {
      diagnostics.push({ package: tool.name, reason: satisfies === null ? "Unsupported or missing stable declaration/lock pin."
        : "Declared and locked direct dependency are not aligned." });
      continue;
    }
    pins[tool.constant] = installed;
  }
  return { pins, diagnostics };
}

export function packageCurrencyModule(contract) {
  const sha = file => createHash("sha256").update(readFileSync(file)).digest("hex");
  if (sha(import.meta.filename) !== contract.interpreterSha256
    || sha("scripts/native-version-currency-value.mjs") !== contract.versionOracleSha256) {
    throw new Error("Frozen package-currency interpreter changed");
  }
  const example = stale => ({ valid: true, completeCohort: true, eligible: 2, known: 2, stale });
  const metric = (id, role, name, label) => ({ id, role, name, unit: "packages", direction: "decrease",
    formula: "Count aligned, locked direct dependencies below the greatest surviving official stable release published by the endpoint.",
    presentation: { name, legendLabel: label, transform: "identity" } });
  return { definition: { schemaVersion: 3, slug: contract.workflowId, repository: contract.repository,
    workflowName: contract.workflowName, sourcePath: contract.sourcePath,
    intent: { goal: "Keep the documentation site's direct npm dependencies current with official stable publications.",
      acceptance: "Immutable manifest and lockfile agree; native locked versions are compared with independently dated surviving official releases. Migration correctness and successful builds remain separate.",
      temporalAnchor: "workflow-adoption" },
    adoption: contract.adoption, evaluation: { mode: "attainment-only" },
    evidence: { key: "native-direct-package-currency-v1", repositories: [contract.repository],
      sourcePolicySha256: censusDigest(contract), tools: contract.tools,
      reviewCoveragePolicy: contract.reviewCoveragePolicy,
      opportunity: "The fixed direct production/development dependency cohort from the frozen source manifest.",
      filters: ["Compare actual locked versions, not lower bounds of caret/tilde declarations or agent update claims.",
        "Both the root lock declarations and each native lock pin must satisfy the source manifest.",
        "Require the full frozen cohort for the primary comparison; partial history is a separate diagnostic.",
        "Use dated surviving numeric stable releases; mutable latest-channel history and deleted releases are not reconstructed.",
        "Package currency is not migration correctness, build compatibility, transitives, overrides or exclusive workflow contribution."],
      collection: "Digest-checked immutable manifest/lock blobs and normalized official npm publication histories.",
      measurementKind: "snapshot", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Native direct npm lock pins joined to official package release history.",
      recommendation: "Review known dependency lag alongside independently established migrations and build checks.",
      presentation: { label: "Stale direct documentation dependencies", betterLabel: "Fewer direct packages behind official stable releases" } },
    summary: { nativeLabel: "Stale direct packages" },
    metrics: [metric("stale-pins", "primary", "Stale direct packages in the complete cohort", "Stale direct packages"),
      metric("known-stale-pins", "diagnostic", "Known stale direct packages in partial history", "Known stale packages")],
    validationExamples: { targetAttained: example(0), targetMissed: example(1), missing: { valid: false },
      malformed: { ...example(1), stale: 3 } } },
  scoreMetric: scoreVersionCurrency, collectBatch(requests) {
    const index = readCensusJson(`${contract.directory}/index.json`), facts = readCensusJson(`${contract.directory}/facts.json.gz`);
    if (!index.complete || index.contractSha256 !== censusDigest(contract) || index.factsSha256 !== censusDigest(facts)) {
      throw new Error("Package-currency evidence scope or facts changed");
    }
    return requests.map(request => {
      if (request.repository && request.repository !== contract.repository) throw new Error("Package observation repository mismatch");
      const state = facts.states.find(state => state.windowEnd === request.windowEnd);
      const evidence = state && Date.parse(request.windowEnd) <= Date.parse(contract.until)
        ? assessVersionCurrency(state.pins, contract.tools, facts.releases, request.windowEnd)
        : { valid: false, reason: "No exact frozen manifest/lock endpoint." };
      return { evidence: { ...evidence,
        coverageStatus: evidence.valid && evidence.completeCohort ? "complete" : evidence.valid ? "partial" : "unknown",
        maturityStatus: "matured", eligibleCount: evidence.valid ? evidence.eligible : null,
        lockDiagnostics: state?.diagnostics ?? [],
        fullGoalAcceptance: "not-measured", migrationCorrectness: "not-measured", buildCompatibility: "not-measured",
        workflowCausation: "not-measured", costs: "not-measured" },
      provenance: [{ repository: contract.repository, kind: "immutable-workflow-source", ref: contract.sourceGitBlob },
        { repository: contract.repository, kind: "native-package-currency-index", ref: censusDigest(index) }],
      commit: state?.commit ?? contract.sourceRevision };
    });
  } };
}
