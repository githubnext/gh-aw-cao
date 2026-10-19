import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { historicalRevisions, lockPairGuard, repository, revision } from "./collect-gh-aw-operational-evidence.mjs";
import { censusDigest as digest, readCensusEvidence, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";

export { digest };
const day = 86_400_000;
const nonnegative = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const count = value => Number.isSafeInteger(value) && value >= 0;

function validateContract(contract) {
  for (const key of ["path", "goal", "population", "acceptance", "evidencePlan", "missingReason", "limitation"]) {
    if (typeof contract[key] !== "string" || !contract[key].trim()) throw new Error(`Missing ${key}: ${contract.path}`);
  }
  if (!["candidate", "needs-clarification"].includes(contract.designStatus)
    || !["count", "share", "ratio", "unresolved"].includes(contract.measureKind)
    || !Array.isArray(contract.grounding) || !contract.grounding.length) {
    throw new Error(`Invalid contract design: ${contract.path}`);
  }
  for (const citation of contract.grounding) {
    if (!Number.isSafeInteger(citation.startLine) || citation.startLine < 1
      || !Number.isSafeInteger(citation.endLine) || citation.endLine < citation.startLine
      || typeof citation.quote !== "string" || !citation.quote || citation.quote.length > 220) {
      throw new Error(`Invalid source grounding: ${contract.path}`);
    }
  }
  if (contract.designStatus === "needs-clarification" && contract.measureKind !== "unresolved") {
    throw new Error(`Unresolved contracts must not masquerade as executable metrics: ${contract.path}`);
  }
  if (contract.measureKind === "unresolved") return;
  if (contract.designStatus !== "candidate" || !contract.metricName || !contract.formula || !contract.unit
    || !["increase", "decrease", "maintain", "target"].includes(contract.direction)
    || (["maintain", "target"].includes(contract.direction) && !nonnegative(contract.target))) {
    throw new Error(`Invalid native metric: ${contract.path}`);
  }
  if (contract.measureKind === "share" && !/^(percent|%)(?:$| of )/.test(contract.unit)) {
    throw new Error(`Share functions must retain percentage units: ${contract.path}`);
  }
}

export function validateCensus(manifest, evidence) {
  if (manifest.repository !== repository || manifest.revision !== revision
    || evidence.repository !== repository || evidence.revision !== revision
    || manifest.contracts.length !== evidence.sources.length || evidence.sources.length !== 385) {
    throw new Error("The full pinned 385-workflow corpus is required");
  }
  const expected = new Set(evidence.sources.map(source => source.path));
  const actual = new Set(manifest.contracts.map(contract => contract.path));
  if (expected.size !== 385 || actual.size !== 385 || [...expected].some(file => !actual.has(file))) {
    throw new Error("Missing, extra, or duplicate workflow contract");
  }
  const sourceByPath = new Map(evidence.sources.map(source => [source.path, source]));
  for (const contract of manifest.contracts) {
    validateContract(contract);
    if (contract.sourceSha256 !== sourceByPath.get(contract.path).sha256) {
      throw new Error(`Source digest mismatch: ${contract.path}`);
    }
  }
  if (JSON.stringify(evidence.snapshots.map(row => [row.windowEnd, row.commit])) !== JSON.stringify(historicalRevisions)) {
    throw new Error("Historical cutoffs and revisions must match the frozen census");
  }
  if (evidence.runInventory.length !== 385
    || new Set(evidence.runInventory.map(row => row.path)).size !== 385
    || evidence.runInventory.some(row => !expected.has(row.path))) {
    throw new Error("Evidence inventory must account for all source workflows");
  }
}

export function createWorkflowValueFunction(contract, manifest, evidence) {
  validateContract(contract);
  if (contract.measureKind === "unresolved") throw new Error(`Outcome contract needs clarification: ${contract.path}`);
  const contractDigest = digest(contract);
  const slug = path.basename(contract.path).replace(/\.(md|ya?ml)$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const frame = fields => ({ valid: true, coverageStatus: "complete", contractDigest, ...fields });
  const example = value => frame(contract.measureKind === "count" ? { count: value }
    : contract.measureKind === "share" ? { accepted: value, eligible: 100 } : { numerator: value, denominator: 1 });
  const larger = contract.measureKind === "share" ? 100 : 2;
  const better = ["target", "maintain"].includes(contract.direction) ? contract.target
    : contract.direction === "decrease" ? 0 : larger;
  const worse = ["target", "maintain"].includes(contract.direction)
    ? contract.measureKind === "share" ? (contract.target >= 50 ? 0 : 100) : contract.target + 1
    : contract.direction === "decrease" ? larger : 0;
  const definition = {
    schemaVersion: 3, slug, repository, workflowName: contract.goal, sourcePath: contract.path,
    intent: { goal: contract.goal, acceptance: contract.acceptance, temporalAnchor: "contract-activation" },
    adoption: { commit: revision, adoptedAt: manifest.contractActivatedAt, baselineCommit: null, baselineAt: null },
    evaluation: { mode: "attainment-only" },
    evidence: {
      key: slug, repositories: [repository], opportunity: contract.population,
      filters: [contract.acceptance],
      collection: contract.evidencePlan, measurementKind: "snapshot",
      window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 },
    },
    model: { architecture: "Source-grounded candidate contract; deterministic native scoring over preserved evidence.",
      recommendation: "Independently adjudicate intent fidelity and acceptance instruments before production use.",
      presentation: { label: contract.metricName, betterLabel: "Follow the declared native direction" } },
    summary: { nativeLabel: contract.metricName },
    metrics: [{ id: "outcome", name: contract.metricName, role: "primary", formula: contract.formula,
      unit: contract.unit, direction: contract.direction,
      ...(["target", "maintain"].includes(contract.direction) ? { target: contract.target } : {}),
      presentation: { name: contract.metricName, legendLabel: "Native outcome", transform: "identity" } }],
    validationExamples: {
      targetAttained: example(better), targetMissed: example(worse),
      missing: { valid: false, missingReason: contract.missingReason },
      malformed: frame({ count: "unknown", accepted: "unknown", numerator: "unknown" }),
    },
  };
  const scoreMetric = (id, row) => {
    if (id !== "outcome" || row?.valid !== true || row.coverageStatus !== "complete"
      || row.contractDigest !== contractDigest) return null;
    if (contract.measureKind === "count") return count(row.count) ? row.count : null;
    if (contract.measureKind === "share") {
      return count(row.accepted) && count(row.eligible) && row.eligible > 0 && row.accepted <= row.eligible
        ? row.accepted * 100 / row.eligible : null;
    }
    const result = nonnegative(row.numerator) && nonnegative(row.denominator) && row.denominator > 0
      ? row.numerator / row.denominator : null;
    return typeof result === "number" && Number.isFinite(result) ? result : null;
  };
  const collectBatch = requests => requests.map(request => {
    if (request.repository && request.repository !== repository) throw new Error("Unsupported repository");
    const start = Date.parse(request.windowStart);
    const end = Date.parse(request.windowEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start !== 7 * day) {
      throw new Error("Census collection requires an exact seven-day snapshot partition");
    }
    const snapshot = evidence.snapshots.find(row => Date.parse(row.windowEnd) === end);
    const missing = (reason, status = "missing", reasonClass = "missing-preserved-evidence") => ({
      evidence: { valid: false, contractDigest, coverageStatus: status, missingReason: reason, reasonClass },
      provenance: [{ repository, kind: "census-source-and-acquisition-receipt", ref: revision }],
    });
    if (!snapshot) return missing("No preserved snapshot for the requested cutoff.");
    if (!snapshot.presentWorkflowPaths.includes(contract.path)) {
      return missing("Workflow source is absent at this historical cutoff.", "missing", "workflow-absent");
    }
    if (contract.path === ".github/workflows/stale-lock-files.yml" && contract.instrument === "git-lock-pair-guard") {
      const present = snapshot.presentWorkflowPaths.concat(snapshot.presentLockPaths);
      const guard = lockPairGuard(snapshot.changedPaths, present);
      if (guard.count !== snapshot.guard.count || guard.eligibleCount !== snapshot.guard.eligibleCount) {
        throw new Error("Preserved lock-pair evidence is inconsistent");
      }
      return { evidence: frame({ count: guard.count, eligibleCount: guard.eligibleCount,
        populationDigest: digest(guard.eligible), maturityStatus: "matured" }),
      provenance: snapshot.provenance };
    }
    if (contract.path === ".github/workflows/cgo.yml" && contract.instrument === "go-unit-test-events") {
      const tests = evidence.goUnitEvidence.find(row => row.windowEnd === snapshot.windowEnd);
      if (!tests || tests.status !== "available") {
        return missing(tests?.reason ?? "No preserved complete unit-test evidence.",
          tests?.status === "partial" ? "partial" : "missing",
          tests?.status === "partial" ? "partial-evidence" : "missing-preserved-evidence");
      }
      if (contract.measureKind !== "count" || contract.direction !== "decrease") {
        throw new Error("The Go unit-test instrument requires a native failing-test count");
      }
      const outcomes = tests.shards.flatMap(shard => shard.testOutcomes);
      const ids = outcomes.map(test => test.id);
      if (new Set(ids).size !== ids.length || tests.shards.some(shard => shard.coverageStatus !== "complete")) {
        throw new Error("Duplicated or incomplete test population");
      }
      return { evidence: frame({ count: outcomes.filter(test => test.status === "fail").length,
        eligibleCount: outcomes.filter(test => test.status !== "skip").length,
        populationDigest: digest(ids.toSorted()), maturityStatus: "matured" }),
      provenance: tests.shards.map(shard => ({
        repository, kind: "github-go-test-assertion-artifact", ref: `${shard.artifactId}:sha256:${shard.archiveSha256}`,
      })) };
    }
    return missing(`This census has no implemented independent collector for this candidate. ${contract.missingReason}`,
      "missing", "instrument-not-implemented");
  });
  return { definition, collectBatch, scoreMetric, contractDigest };
}

export function measureCensus(manifest, evidence) {
  validateCensus(manifest, evidence);
  const rows = manifest.contracts.map(contract => {
    const measurable = contract.measureKind !== "unresolved";
    const value = measurable ? createWorkflowValueFunction(contract, manifest, evidence) : null;
    const observations = evidence.snapshots.map(snapshot => {
      if (!value) return { windowEnd: snapshot.windowEnd, value: null,
        coverageStatus: "missing", reasonClass: "design-unresolved", reason: `Outcome design unresolved: ${contract.missingReason}` };
      const request = { windowEnd: snapshot.windowEnd, observedAt: snapshot.windowEnd,
        windowStart: new Date(Date.parse(snapshot.windowEnd) - 7 * day).toISOString() };
      const collected = value.collectBatch([request])[0];
      return { windowEnd: snapshot.windowEnd, value: value.scoreMetric("outcome", collected.evidence),
        coverageStatus: collected.evidence.coverageStatus,
        reasonClass: collected.evidence.reasonClass ?? "observed",
        eligibleCount: collected.evidence.eligibleCount ?? null,
        reason: collected.evidence.missingReason ?? null, provenance: collected.provenance };
    });
    return { path: contract.path, designStatus: contract.designStatus,
      functionStatus: measurable ? "executable-candidate" : "blocked-by-outcome-definition",
      contractDigest: digest(contract), metricName: contract.metricName, unit: contract.unit,
      direction: contract.direction, observations };
  });
  const all = rows.flatMap(row => row.observations);
  const primary = rows.filter(row => row.observations.some(observation => observation.value !== null));
  const runRows = evidence.runInventory.filter(row => row.status === "available");
  const root = path.resolve(import.meta.dirname, "..");
  const evaluatorFingerprints = Object.fromEntries([
    "scripts/collect-gh-aw-operational-evidence.mjs",
    "scripts/build-gh-aw-operational-contracts.mjs",
    "scripts/measure-gh-aw-operational-value.mjs",
    "scripts/operational-value-census-io.mjs",
    "tests/unit/cao-operational-value-census.test.mjs",
    ".github/skills/add-operational-value/scripts/verify-value-function.mjs",
    ".github/skills/add-operational-value/scripts/pulse-model.mjs",
    ".github/skills/add-operational-value/scripts/review-value.mjs",
    ".github/skills/add-operational-value/scripts/common.mjs",
    ".github/skills/add-operational-value/scripts/json-archive.mjs",
    "dashboard/site/src/data/model/schema.js",
    "package.json",
  ].map(file => [file, createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex")]));
  return {
    schemaVersion: 1, repository, revision,
    study: "Single-pass assistant-authored contract census with bounded real-evidence reconstruction; not independently adjudicated.",
    inputs: { contractSha256: digest(manifest), evidenceSha256: digest(evidence) },
    evaluatorFingerprints,
    scope: evidence.scope, cutoffs: evidence.snapshots.map(row => row.windowEnd),
    totals: {
      workflows: rows.length, agentic: evidence.sources.filter(source => source.kind === "agentic").length,
      native: evidence.sources.filter(source => source.kind === "native").length,
      executableCandidateContracts: rows.filter(row => row.functionStatus === "executable-candidate").length,
      designBlocked: rows.filter(row => row.functionStatus === "blocked-by-outcome-definition").length,
      observations: all.length, numericObservations: all.filter(row => row.value !== null).length,
      missingObservations: all.filter(row => row.value === null).length,
      workflowsWithAnyNumericValue: primary.length,
      agenticWorkflowsWithAnyNumericValue: primary.filter(row => row.path.endsWith(".md")).length,
      zeroOpportunityNumericObservations: all.filter(row => row.value !== null && row.eligibleCount === 0).length,
      implementedIndependentCollectors: manifest.contracts.filter(contract => contract.instrument).length,
    },
    observationReasons: Object.fromEntries([...new Set(all.map(row => row.reasonClass))].sort()
      .map(reason => [reason, all.filter(row => row.reasonClass === reason).length])),
    acquisition: {
      latestRunMetadata: runRows.length,
      noMatchingRun: evidence.runInventory.filter(row => row.status === "no-matching-run").length,
      runApiErrors: evidence.runInventory.filter(row => row.status === "error").length,
      workflowsWithArtifactMetadata: runRows.filter(row => row.artifacts?.items?.length).length,
      artifactApiErrors: runRows.filter(row => row.artifacts?.status === "error").length,
      truncatedArtifactInventories: runRows.filter(row => row.artifacts?.complete === false).length,
    },
    conclusion: "Corpus and interface coverage do not establish intent fidelity or operational benefit. Missing evidence is not zero; metadata and artifact existence are not accepted outcomes.",
    workflows: rows,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [contracts, evidence, output] = process.argv.slice(2);
  if (!contracts || !evidence || !output || process.argv.length !== 5) {
    throw new Error("usage: node scripts/measure-gh-aw-operational-value.mjs CONTRACTS.json EVIDENCE.json OUTPUT.json");
  }
  const result = measureCensus(readCensusJson(contracts), readCensusEvidence(evidence));
  writeCensusJson(output, result);
  console.log(JSON.stringify({ totals: result.totals, acquisition: result.acquisition }, null, 2));
}
