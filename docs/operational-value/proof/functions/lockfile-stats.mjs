import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { censusDigest, readCensusJson } from "../../../../scripts/operational-value-census-io.mjs";
import { checkoutReceipt, reconciledFactCounts, reconcileStatisticalClaims } from "../../../../scripts/reconcile-lockfile-stats.mjs";
import { readLockfileInputs } from "../../../../scripts/lockfile-stats-inputs.mjs";
import { verifyPublicGitBlob } from "../../../../scripts/immutable-public-git-source.mjs";
import { parse } from "yaml";

const directory = "docs/operational-value/proof/lockfile-stats";
const contract = readCensusJson(`${directory}/contract.json`);
if (censusDigest(contract) !== "e1efbb89684712dd6b2e1ad8728e1985d403afa55ccc5b8c44e6f7e1902b2143") {
  throw new Error("Frozen lockfile statistical contract changed");
}
const examples = (good, bad) => ({ valid: true, assessments: [{ id: 1, status: "assessed",
  claims: [...Array.from({ length: good }, (_, index) => ({ field: `good-${index}`, agrees: true })),
    ...Array.from({ length: bad }, (_, index) => ({ field: `bad-${index}`, agrees: false }))] }] });
const metric = (id, name, role, direction, formula) => ({ id, name, role, direction, formula,
  unit: "statistical facts", presentation: { name, legendLabel: name, transform: "identity" } });

export const definition = {
  schemaVersion: 3, slug: "lockfile-stats", repository: contract.repository,
  workflowName: "Lockfile Statistics Analysis Agent", sourcePath: ".github/workflows/lockfile-stats.md",
  intent: { goal: contract.goal, acceptance: contract.acceptance, temporalAnchor: "workflow-adoption" },
  adoption: contract.adoption, evaluation: { mode: "attainment-only" },
  evidence: { key: "independently-reconciled-lockfile-statistics-v1", repositories: [contract.repository],
    contractSha256: censusDigest(contract),
    opportunity: contract.scope.opportunity,
    filters: [contract.scope.files, contract.scope.sourceCompatibility, ...contract.nativeRules, ...contract.separateUnknowns],
    collection: "Replay original protected-upload cache summaries against the complete immutable checkout using the pinned native YAML/JSON census; retain all assertions and mismatches.",
    measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
  model: { architecture: "Independent native reconciliation of each distinct persisted statistical assertion, not report/run counts.",
    recommendation: "Review demonstrated statistical accuracy separately from missing history, report completeness, insights, cost and resource safeguards.",
    presentation: { label: "Reconciled census facts", betterLabel: "More independently verified statistical facts" } },
  summary: { nativeLabel: "Reconciled census facts" },
  metrics: [
    metric("verified-statistical-facts", "Reconciled census facts", "primary", "increase",
      contract.primary.formula),
    metric("incorrect-statistical-facts", "Incorrect census facts", "diagnostic", "decrease",
      "Count distinct mapped numeric assertions whose value disagrees with the independent full-population native census; unbound reports stay unknown."),
  ],
  validationExamples: { targetAttained: examples(2, 0), targetMissed: examples(1, 1),
    missing: { valid: false }, malformed: { valid: true, assessments: [{ id: 1, status: "assessed", claims: [{ agrees: "yes" }] }] } },
};

export function scoreMetric(id, evidence) {
  if (!["verified-statistical-facts", "incorrect-statistical-facts"].includes(id)
    || evidence?.valid !== true || !Array.isArray(evidence.assessments) || !evidence.assessments.length
    || new Set(evidence.assessments.map(row => row.id)).size !== evidence.assessments.length
    || evidence.assessments.some(row => !Number.isSafeInteger(row.id) || row.id <= 0
      || !["assessed", "missing"].includes(row.status) || !Array.isArray(row.claims)
      || new Set(row.claims.map(claim => claim.field)).size !== row.claims.length
      || row.claims.some(claim => typeof claim.field !== "string" || !claim.field || typeof claim.agrees !== "boolean"
        || claim.meaning !== undefined && (typeof claim.meaning !== "string" || !claim.meaning))
      || row.status === "missing" && row.claims.length)) return null;
  const assessed = evidence.assessments.filter(row => row.status === "assessed");
  if (!assessed.length) return null;
  return assessed.reduce((sum, row) => sum + reconciledFactCounts(row.claims)[id === "verified-statistical-facts" ? "verified" : "incorrect"], 0);
}

function readAcceptedEvidence() {
  const index = readCensusJson(`${directory}/index.json`);
  const rows = readCensusJson(`${directory}/assessments.json.gz`);
  const inventory = readCensusJson(`${directory}/inventory.json.gz`);
  if (!index.complete || index.contractSha256 !== censusDigest(contract)
    || index.assessmentsSha256 !== censusDigest(rows) || rows.length !== index.observations
    || censusDigest(inventory) !== index.inventorySha256) {
    throw new Error("Lockfile statistical evidence index changed");
  }
  const oracle = createHash("sha256").update(readFileSync("scripts/native-lockfile-stats.py")).digest("hex");
  const sourceIndex = readCensusJson(`${directory}/sources-index.json`);
  if (!sourceIndex.complete || !Array.isArray(sourceIndex.parts)) throw new Error("Missing complete workflow source closure");
  const sourceRows = sourceIndex.parts.flatMap(part => {
    if (!/^sources-\d{3}\.json\.gz$/.test(part.file)) throw new Error("Unsafe workflow source partition");
    const values = readCensusJson(`${directory}/${part.file}`);
    if (values.length !== part.count || censusDigest(values) !== part.sha256) throw new Error("Workflow source partition changed");
    return values;
  });
  if (sourceRows.length !== sourceIndex.count) throw new Error("Incomplete workflow source closure");
  const sources = new Map(sourceRows.map(source => {
    const bytes = verifyPublicGitBlob(Buffer.from(source.native, "base64"), source.id);
    if (source.lfs || !bytes.equals(Buffer.from(source.content, "base64"))
      || createHash("sha256").update(bytes).digest("hex") !== source.sha256) throw new Error("Workflow source bytes changed");
    return [source.id, bytes];
  }));
  if (!sources.has(contract.sourceGitBlob)) throw new Error("Missing frozen workflow source");
  for (const row of rows.filter(row => row.status === "assessed")) {
    const source = sources.get(row.sourceGitBlob);
    if (!source || !sources.has(row.lockGitBlob)
      || createHash("sha256").update(source.toString("utf8").split("\n---\n").slice(1).join("\n---\n")).digest("hex") !== row.sourceBodySha256) {
      throw new Error("Missing or incompatible original workflow/compiled source");
    }
    const steps = parse(sources.get(row.lockGitBlob).toString("utf8")).jobs?.agent?.steps;
    const checkouts = steps?.filter(step => step.name === row.receipt.checkout.step.name
      && /^actions\/checkout@[a-f0-9]{40}$/.test(step.uses) && !step.with?.ref && !step.with?.repository);
    const uploads = steps?.filter(step => step.name === row.receipt.upload.name
      && /^actions\/upload-artifact@[a-f0-9]{40}$/.test(step.uses)
      && step.with?.name === "cache-memory" && step.with?.path === "/tmp/gh-aw/cache-memory");
    if (checkouts?.length !== 1 || uploads?.length !== 1
      || !checkoutReceipt(row.receipt.checkout.excerpt, row.receipt.checkout.step, row.headSha)
      || createHash("sha256").update(row.receipt.checkout.excerpt).digest("hex") !== row.receipt.checkout.sha256
      || row.receipt.artifact.digest !== `sha256:${row.receipt.archiveSha256}`) {
      throw new Error("Protected source-bound checkout/upload receipt changed");
    }
    if (!/^[a-f0-9]{40}$/.test(row.headSha) || row.nativeInput !== `inputs/${row.headSha}.json.gz`) {
      throw new Error("Unsafe lockfile census reference");
    }
    const native = readCensusJson(`${directory}/${row.nativeInput}`);
    if (censusDigest(native) !== row.nativeInputSha256 || native.oracleSha256 !== oracle
      || native.commit !== row.headSha || native.inputPopulationDigest !== row.inputPopulationDigest
      || native.population.length !== row.eligibleLockfiles) throw new Error("Native census changed");
    const parts = readLockfileInputs(`${directory}/inputs`, native);
    if (parts.length !== native.population.length || censusDigest(parts.map(({ path, gitBlob }) => ({ path, gitBlob }))) !== native.inputPopulationDigest) {
      throw new Error("Full lockfile population is incomplete");
    }
    for (const file of parts) {
      const bytes = Buffer.from(file.content, "base64");
      if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== file.gitBlob) {
        throw new Error("Native input Git identity mismatch");
      }
    }
    const bytes = Buffer.from(row.originalSummary.content, "base64");
    if (createHash("sha256").update(bytes).digest("hex") !== row.originalSummary.sha256
      || censusDigest(reconcileStatisticalClaims(JSON.parse(bytes), native.facts, native.population))
        !== censusDigest({ claims: row.claims, unsupported: row.unsupported })) throw new Error("Original summary reconciliation changed");
    if (row.receipt.checkout.checkoutSha !== row.headSha || row.receipt.artifact.workflow_run.id !== row.id
      || row.receipt.artifact.workflow_run.head_sha !== row.headSha || row.receipt.upload.conclusion !== "success") {
      throw new Error("Original protected input/upload binding changed");
    }
  }
  const eligible = new Set(inventory.filter(run => ["schedule", "workflow_dispatch"].includes(run.event)).map(run => run.id));
  return { index, rows, eligible };
}

export function collectBatch(requests) {
  const { index, rows, eligible } = readAcceptedEvidence();
  return requests.map(request => {
    if (request.repository && request.repository !== contract.repository) throw new Error("Repository mismatch");
    if (!Number.isFinite(Date.parse(request.windowStart)) || !Number.isFinite(Date.parse(request.windowEnd))
      || request.windowStart >= request.windowEnd) throw new Error("Invalid bounded observation window");
    const inventoried = rows.filter(row => row.at >= request.windowStart && row.at < request.windowEnd);
    const selected = inventoried.filter(row => eligible.has(row.id));
    const assessed = selected.filter(row => row.status === "assessed");
    const valid = assessed.length > 0 && request.windowEnd <= contract.until;
    return { evidence: { valid, assessments: selected.map(({ id, status, claims }) => ({ id, status, claims })),
      coverageStatus: selected.length && assessed.length === selected.length ? "complete" : assessed.length ? "partial" : "missing",
      missingReason: valid ? null : "No original, source-compatible, protected-upload census with exact checkout binding establishes statistics in this interval.",
      eligibleCount: selected.length, assessedCount: assessed.length,
      inventoriedRuns: inventoried.length, ineligibleRuns: inventoried.length - selected.length,
      lockfilePopulations: assessed.map(row => ({ runId: row.id, count: row.eligibleLockfiles, digest: row.inputPopulationDigest })),
      missingAssessments: selected.filter(row => row.status !== "assessed").map(({ id, reason }) => ({ id, reason })),
      costs: "not-measured", insights: "not-measured", publication: "not-measured",
      safeguards: "Token/turn budgets, recommendation quality, historical deltas and final Discussion content are not established by cached numeric accuracy.",
      fullAcceptance: "not-established" },
    provenance: [{ repository: contract.repository, kind: "immutable-workflow-source", ref: contract.sourceGitBlob },
      { repository: contract.repository, kind: "native-lockfile-reconciliation-index", ref: censusDigest(index) }],
    commit: contract.sourceRevision };
  });
}
