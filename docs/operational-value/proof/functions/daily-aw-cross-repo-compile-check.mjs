import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";

const slug = "daily-aw-cross-repo-compile-check";
const repository = "github/gh-aw";
const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
const activation = "2026-10-18T15:00:12Z";
const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const readJson = file => readJsonArchive(file);
const nonempty = value => typeof value === "string" && value.length > 0;
const iso = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.replace("Z", ".000Z");
const nativePath = fileURLToPath(new URL(`../${slug}/native.json`, import.meta.url));
const sourcePath = fileURLToPath(new URL(`../${slug}/sources.json.gz`, import.meta.url));
const repoName = value => typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
const safePath = value => typeof value === "string" && value.startsWith(".github/workflows/")
  && !value.split("/").some(part => ["", ".", ".."].includes(part)) && /^[A-Za-z0-9_./-]+$/.test(value);
const window = { durationDays: 1, cadenceDays: 1, maturationDays: 0 };
const evidenceContract = {
  key: `${slug}:fixed-cohort-strict-compile`,
  repositories: [repository],
  opportunity: "A frozen cohort of the source-defined top 20 public, non-archived repositories discovered through gh-aw lock-file markers; each repository has its entire native compiler-selected workflow inventory assessed.",
  filters: [
    "Discovery must preserve candidate identities, public/archive status, stars, ranking and selected revisions at or after contract activation, before reading outcomes.",
    "Freeze the initial cohort and exact compiler build/binary/environment; subsequent star rankings or compiler fallback belong to separate comparison eras.",
    "One unmodified compile --strict, one fix --write with the same compiler and no manual edits, then compile --strict. Preserve original inventories, generated outputs and complete transformation diff.",
    "Only original protected independent compiler results at the assessed source revision count. Agent-writable cache summaries, issues, PRs, run conclusions and tracking markers are discovery, not acceptance.",
    "Compiler validation failures are incompatibilities only when setup/access/import resolution are independently complete. Missing or infrastructure-failed evidence remains unknown.",
  ],
  collection: "Offline batch replay of digest-bound original protected compiler reports and exhaustive native workflow inventories. No GitHub API, execution, installation, discovery, compilation or network access occurs during collection/scoring.",
  measurementKind: "snapshot",
  window,
};
const example = (compatible, validWorkflows) => ({
  key: evidenceContract.key, measurementKind: "snapshot", coverageStatus: "complete",
  populationDigest: "a".repeat(64), compilerDigest: "b".repeat(64),
  eligibleCount: 20, assessedRepositories: 20, compatibleRepositories: compatible,
  incompatibleRepositories: 20 - compatible, unknownRepositories: 0,
  knownCompatibleWorkflows: validWorkflows, knownAssessedWorkflows: 40,
  fullInventoryRepositories: 20, maturityStatus: "mature", dubious: false,
});

export const definition = {
  schemaVersion: 3, slug, repository,
  workflowName: "Daily AW Cross-Repo Compile Check",
  sourcePath: `.github/workflows/${slug}.md`,
  intent: {
    goal: "Maintain compiler compatibility with real public repositories using gh-aw, including the declared automatic migration pass.",
    acceptance: "Every native-selected workflow in each fixed selected repository independently compiles under the exact fixed assessed compiler after its one declared fix --write pass.",
    temporalAnchor: "contract-activation",
  },
  adoption: { commit: revision, adoptedAt: activation, baselineCommit: null, baselineAt: null },
  evaluation: { mode: "attainment-only",
    reason: "Current-source-scoped contract activation, not verified workflow adoption. The phenomenon predates the instrument; historical baseline evidence is unacquired, not exhausted." },
  evidence: evidenceContract,
  scope: {
    collectionIdentity: "github/gh-aw is the intent-source and aggregate collection identity, not a substitute target repository.",
    outcomeIdentities: "Only the independently preserved public selected-cohort identities; none are resolved yet. Observations with a cohort name the actual outcome repositories.",
  },
  sourceIdentity: {
    repositoryId: 1036865607, revision,
    workflowBlob: "a4726c28d67f33d3d45e0ff288aaffdfd0498233",
    workflowSha256: "65b165e903b32c5fcd5e5845991f7a60c49942ccd2e4144a0e71942d6d405608",
    compiledBlob: "d467506953667aaa20c50b9e539cb1bbfdabb927",
    compiledReviewStatus: "complete-source-reviewed-no-independent-compile-checker",
    compiledSha256: "ac3bc374ab1882577fabc6428fc4749030d3595895861c1a31a47ad71c7c2925",
    archiveCodecSha256: "18045c03ca00fc5f8cccf2a02486255e03a0df22adddf0c426c9182fc6e2554b",
    imports: [
      { path: "shared/reporting.md", gitBlob: "263d2413472e62582c578897a8b06462da5ef171" },
      { path: "shared/otlp.md", gitBlob: "f68eee05a7f9d4379511148f65aa2ed8bf7667dd" },
    ],
    nativeContract: [
      "814e017d471bb54355fcbf9be911f262dfc354a6",
      "d3b78d4d5cfde5dfe6d6359d17984ac534860a76",
      "10ef3e478dbf16758e1250bb5c84f88945ef54f2",
      "8c767685b35c4fa936d837bf9a60edb4ca2b6006",
      "4b2aed7c64ef0066b3d5c6f8c3e05123aa1ff75b",
      "0da5d8c94cbbb45a3d405c1c3d5eed592aad777a",
      "4fe1a7b1f60ff1555d8350a0a03c649996e2360e",
    ],
  },
  acceptance: {
    cohortSize: 20,
    ranking: "Stars descending; preserve the source's actual selection for tied stars instead of inventing a tie-breaker.",
    compiler: "Exact original assessed compiler revision, binary SHA-256, native version, build toolchain and environment; freeze at the first independently verified selection before outcome inspection.",
    transformation: "One native fix --write invocation, including its registry's internal convergence passes and documented scaffolding/cleanup side effects; no arbitrary manual repair, workflow deletion or disabled checks.",
    inventory: "Full before/after native selected Markdown inventory plus imports, configuration, action/container pins and generated lock identities. Inventory loss or narrowed selection cannot improve attainment.",
    evidenceAuthority: "An independently protected checker source and report must be reviewed and pinned in the native input ledger before replay. Digest integrity alone does not establish protected provenance.",
    reviewedCheckerSources: [],
    nativeProjection: "A protected replay may add --json to compile --strict for the original compiler's ValidationResult array; this changes output formatting only, not checks. Whole process exit and batch errors remain gates.",
    maturation: "A contemporaneous immutable cutoff assessment, no later evidence backdated; unavailable cutoffs remain visible. No stale-last-known-success fallback.",
  },
  antecedent: {
    result: "pre-existing-but-not-yet-reconstructed",
    reason: "Humans or any other automation can produce compilable sources and compatible compilers. Exact historical discovery, source inventories and compiler receipts have not been acquired.",
    baselineProbe: "Offline preserved-source and discovery inspection found no accepted original native compile reports. Network acquisition was explicitly withheld; this is not evidence exhaustion.",
  },
  metricDisposition: {
    primary: "Repository-wide strict compile compatibility after the exact declared migration pass.",
    diagnostic: "Independently demonstrated compiling workflow subtotal, retained even when full repository compatibility is unknown.",
    gates: ["Complete selection/public identity", "Fixed compiler/environment", "Exhaustive unchanged selection", "Allowed transformation only", "Original independently protected native results"],
    rejected: ["Issue/PR counts or closure", "Successful agent/job conclusions", "Self-reported compatibility", "Search activity", "Clone count", "Changed file count", "Failure cluster count", "Cache writes", "AI eval answers"],
  },
  model: {
    architecture: "Deterministic native compatibility snapshot over one frozen discovery cohort; exact-period original evidence only.",
    recommendation: "Report accepted attainment and independent partial evidence; no invented keep bar, utility weight, savings, runtime certification or causal contribution.",
    presentation: { label: "Fixed-cohort strict compilation", betterLabel: "More repositories independently compile" },
  },
  summary: { nativeLabel: "Selected repositories compiling after native migration (%)" },
  metrics: [
    { id: "compatible-repositories", name: "Selected repository compilation compatibility",
      role: "primary", formula: "100 * compatibleRepositories / eligibleCount; only when all 20 selected repositories have complete independent native assessments.",
      direction: "increase", unit: "percent",
      presentation: { name: "Repository compatibility", legendLabel: "Compiling repositories", transform: "identity" } },
    { id: "compatible-workflows", name: "Independently compiling workflows",
      role: "diagnostic", formula: "knownCompatibleWorkflows from verified original native per-workflow results; null when no workflows were independently assessed.",
      direction: "increase", unit: "workflows",
      presentation: { name: "Known compiling workflows", legendLabel: "Compiling workflows", transform: "identity" } },
  ],
  validationExamples: { targetAttained: example(20, 40), targetMissed: example(0, 0),
    missing: { coverageStatus: "missing" }, malformed: { ...example(20, 40), eligibleCount: -1 } },
  limitations: [
    "Complete current workflow, imports, compiled source and native command/specification are preserved and reviewed. No separate protected native compiler checker exists in this compiled workflow.",
    "No native selected-repository snapshot, compiler build, target inventories or protected original compile reports are retained yet. Population is unknown, not an assumed 20.",
    "Discovery verifies surviving output identities only; current issue state and mutable tracking markers are not backdated.",
    "Changing cohorts, compiler versions, toolchains or eligibility rules cannot establish longitudinal improvement.",
    "Compile acceptance is not runtime correctness, full compatibility, source repair delivery, workflow contribution or exclusive causation.",
    "Snapshots are retained state, not additive fresh work or non-overlapping delivered contributions. No costs are measured and no keep/change policy is rated.",
  ],
};

function validCounts(evidence) {
  const fields = ["eligibleCount", "assessedRepositories", "compatibleRepositories", "incompatibleRepositories",
    "unknownRepositories", "knownCompatibleWorkflows", "knownAssessedWorkflows", "fullInventoryRepositories"];
  if (!evidence || typeof evidence !== "object" || evidence.key !== evidenceContract.key
    || evidence.measurementKind !== "snapshot" || !digest(evidence.populationDigest) || !digest(evidence.compilerDigest)
    || !fields.every(field => Number.isSafeInteger(evidence[field]) && evidence[field] >= 0)
    || evidence.eligibleCount !== 20 || evidence.assessedRepositories > 20
    || evidence.compatibleRepositories + evidence.incompatibleRepositories !== evidence.assessedRepositories
    || evidence.assessedRepositories + evidence.unknownRepositories !== 20
    || evidence.fullInventoryRepositories > evidence.assessedRepositories
    || evidence.compatibleRepositories > evidence.fullInventoryRepositories
    || evidence.assessedRepositories > evidence.knownAssessedWorkflows
    || evidence.compatibleRepositories > evidence.knownCompatibleWorkflows
    || evidence.knownCompatibleWorkflows > evidence.knownAssessedWorkflows
    || !["complete", "partial", "unknown", "missing"].includes(evidence.coverageStatus)) return false;
  return true;
}

export function scoreMetric(id, evidence) {
  if (!validCounts(evidence)) return null;
  if (id === "compatible-workflows") {
    return evidence.knownAssessedWorkflows > 0 ? evidence.knownCompatibleWorkflows : null;
  }
  if (id !== "compatible-repositories" || evidence.coverageStatus !== "complete"
    || evidence.assessedRepositories !== 20 || evidence.fullInventoryRepositories !== 20) return null;
  return 100 * evidence.compatibleRepositories / evidence.eligibleCount;
}

function compilerIdentity(value) {
  return value && sha(value.revision) && digest(value.binarySha256) && nonempty(value.version)
    && digest(value.toolchainDigest) && digest(value.environmentDigest);
}

function inventory(value) {
  if (!value || value.complete !== true || !Array.isArray(value.workflows) || !value.workflows.length
    || !Array.isArray(value.files) || !value.files.length || value.files.length > 10000
    || new Set(value.workflows).size !== value.workflows.length
    || new Set(value.files.map(row => row.path)).size !== value.files.length) {
    throw new Error("Native inventory is absent, empty, incomplete or duplicated");
  }
  for (const row of value.files) {
    if (!nonempty(row.path) || row.path.startsWith("/") || row.path.split("/").some(part => ["", ".", ".."].includes(part))
      || !/^[A-Za-z0-9_./-]+$/.test(row.path) || !sha(row.gitBlob) || !digest(row.sha256)) {
      throw new Error("Invalid native source inventory entry");
    }
  }
  for (const file of value.workflows) {
    if (!safePath(file) || !file.endsWith(".md") || !value.files.some(row => row.path === file)) {
      throw new Error("Native-selected workflow absent from complete source inventory");
    }
  }
  return value;
}

function nativeCompile(pass, selected) {
  if (!pass || JSON.stringify(pass.argv) !== JSON.stringify(["compile", "--strict", "--json"])
    || !Number.isSafeInteger(pass.exitCode) || pass.exitCode < 0 || pass.exitCode > 255
    || !nonempty(pass.stdout) || !digest(pass.stdoutSha256)
    || createHash("sha256").update(pass.stdout).digest("hex") !== pass.stdoutSha256
    || typeof pass.stderr !== "string" || !digest(pass.stderrSha256)
    || createHash("sha256").update(pass.stderr).digest("hex") !== pass.stderrSha256
    || !["complete", "infrastructure-failed", "unknown"].includes(pass.environmentStatus)) {
    throw new Error("Missing or malformed original native compiler invocation");
  }
  let rows;
  try {
    rows = JSON.parse(pass.stdout);
  } catch {
    throw new Error("Original native compiler output is not a ValidationResult array");
  }
  if (!Array.isArray(rows) || !rows.length || rows.length > 10000) throw new Error("Invalid native compiler result population");
  const seen = new Set(), valid = [], invalid = [];
  const selectedByName = new Map();
  for (const file of selected) {
    for (const name of [file, file.slice(file.lastIndexOf("/") + 1)]) {
      selectedByName.set(name, [...(selectedByName.get(name) ?? []), file]);
    }
  }
  let batchFailure = false;
  for (const row of rows) {
    if (!row || typeof row.workflow !== "string" || typeof row.valid !== "boolean"
      || !Array.isArray(row.errors) || !Array.isArray(row.warnings)
      || row.errors.some(error => !nonempty(error.type) || !nonempty(error.message))) {
      throw new Error("Malformed native ValidationResult");
    }
    if (row.scope === "batch") {
      if (!row.valid || row.errors.length) batchFailure = true;
      continue;
    }
    const matches = selectedByName.get(row.workflow) ?? [];
    if (matches.length !== 1 || seen.has(matches[0])) throw new Error("Unexpected, ambiguous or duplicate compiler workflow result");
    seen.add(matches[0]);
    if (row.valid && row.errors.length) throw new Error("Contradictory native compiler result");
    if (row.valid) valid.push(matches[0]);
    else if (row.errors.length) invalid.push(matches[0]);
  }
  const complete = seen.size === selected.length && pass.environmentStatus === "complete";
  const accepted = complete && pass.exitCode === 0 && !batchFailure && valid.length === selected.length;
  if (pass.exitCode === 0 && (invalid.length || batchFailure)) throw new Error("Native process exit contradicts failed validation");
  return { accepted, complete, valid: pass.environmentStatus === "complete" ? valid : [],
    invalid: pass.environmentStatus === "complete" ? invalid : [],
    batchFailure, exitCode: pass.exitCode };
}

// This decoder validates native facts only. The collector separately checks protected provenance.
export function assessNativeReport(report) {
  if (!report || !repoName(report.repository) || !Number.isSafeInteger(report.repositoryId) || report.repositoryId <= 0
    || !sha(report.sourceCommit) || !iso(report.assessedAt) || !compilerIdentity(report.compiler)) {
    throw new Error("Invalid native repository or compiler identity");
  }
  const before = inventory(report.beforeInventory), after = inventory(report.afterInventory);
  if (JSON.stringify(before.workflows.toSorted()) !== JSON.stringify(after.workflows.toSorted())) {
    throw new Error("Migration removed, added or narrowed the selected workflow cohort");
  }
  const fix = report.fix;
  if (!fix || JSON.stringify(fix.argv) !== JSON.stringify(["fix", "--write"])
    || !Number.isSafeInteger(fix.exitCode) || fix.exitCode < 0 || fix.exitCode > 255
    || fix.manualEdits !== false || fix.disabledCodemods?.length !== 0
    || !digest(fix.originalDiffSha256) || !digest(fix.sideEffectInventorySha256)) {
    throw new Error("Missing original allowed migration pass or unauthorized transformations");
  }
  const pre = nativeCompile(report.before, before.workflows);
  const post = nativeCompile(report.after, after.workflows);
  if (report.importsResolved !== true || report.pinsResolved !== true) {
    return { status: "unknown", compatibleWorkflows: 0, assessedWorkflows: 0, fullInventory: false,
      compilerDigest: hash(report.compiler), reason: "Import or action/container resolution is unverified" };
  }
  return {
    status: post.accepted && pre.complete ? "compatible" : post.complete && post.invalid.length ? "incompatible" : "unknown",
    compatibleWorkflows: post.valid.length, assessedWorkflows: post.valid.length + post.invalid.length,
    fullInventory: pre.complete && post.complete,
    compilerDigest: hash(report.compiler),
    migratedFromIncompatible: pre.complete && pre.invalid.length > 0 && post.accepted,
    fixExitCode: fix.exitCode,
    reason: post.accepted ? null : post.invalid.length ? "Native validation failed" : "Process, batch or infrastructure outcome remains unknown",
  };
}

function validateLedger(ledger) {
  if (ledger?.schemaVersion !== 1 || ledger.repository !== repository || ledger.workflow !== slug
    || ledger.sourceRevision !== revision || !Array.isArray(ledger.assessments)
    || !Array.isArray(ledger.authorities) || !Array.isArray(ledger.reports)) {
    throw new Error("Invalid native compatibility evidence ledger");
  }
  if (ledger.authorities.some(authority => !definition.acceptance.reviewedCheckerSources.includes(authority))) {
    throw new Error("No independent protected checker source has been reviewed for this contract; authority activation requires review");
  }
  const cohort = ledger.cohort;
  if (cohort !== null) {
    if (!cohort || !iso(cohort.frozenAt) || Date.parse(cohort.frozenAt) < Date.parse(activation)
      || !compilerIdentity(cohort.compiler) || !Array.isArray(cohort.candidates)
      || cohort.candidates.length < 20 || cohort.candidates.length > 10000
      || !Array.isArray(cohort.selected) || cohort.selected.length !== 20
      || new Set(cohort.candidates.map(row => row.repositoryId)).size !== cohort.candidates.length
      || new Set(cohort.candidates.map(row => row.repository.toLowerCase())).size !== cohort.candidates.length
      || new Set(cohort.selected).size !== 20 || !digest(cohort.selectionReceiptSha256)
      || !ledger.authorities.includes(cohort.checkerSourceBlob)) {
      throw new Error("Missing independently frozen eligible population");
    }
    for (const row of cohort.candidates) {
      if (!repoName(row.repository) || !Number.isSafeInteger(row.repositoryId) || row.repositoryId <= 0
        || !Number.isSafeInteger(row.stars) || row.stars < 0 || !sha(row.sourceCommit)
        || row.isPrivate !== false || row.isArchived !== false || !digest(row.lockMarkerEvidenceSha256)) {
        throw new Error("Invalid public lock-file discovery candidate");
      }
    }
    const selected = cohort.selected.map(id => cohort.candidates.find(row => row.repositoryId === id));
    if (selected.some(row => !row) || selected.some((row, i) => i > 0 && selected[i - 1].stars < row.stars)
      || cohort.candidates.some(row => !cohort.selected.includes(row.repositoryId) && row.stars > selected.at(-1).stars)) {
      throw new Error("Selected cohort is not the preserved public top twenty");
    }
  } else if (ledger.assessments.length || ledger.reports.length) {
    throw new Error("Native reports require a frozen eligible population");
  }
  const reports = new Map();
  for (const entry of ledger.reports) {
    if (!entry || !digest(entry.sha256) || !nonempty(entry.original)
      || createHash("sha256").update(entry.original).digest("hex") !== entry.sha256
      || !ledger.authorities.includes(entry.receipt?.checkerSourceBlob)
      || entry.receipt?.agentWritable !== false || !sha(entry.receipt?.headSha)
      || !Number.isSafeInteger(entry.receipt?.runId) || entry.receipt.runId <= 0
      || !Number.isSafeInteger(entry.receipt?.attempt) || entry.receipt.attempt <= 0
      || !digest(entry.receipt?.providerResponseSha256) || !digest(entry.receipt?.artifactDigest)
      || entry.receipt?.subjectSha256 !== entry.sha256 || reports.has(entry.sha256)) {
      throw new Error("Native report lacks independently protected original receipt binding");
    }
    const report = JSON.parse(entry.original);
    if (!cohort.selected.includes(report.repositoryId)
      || !cohort.candidates.some(row => row.repositoryId === report.repositoryId && row.repository === report.repository)
      || hash(report.compiler) !== hash(cohort.compiler) || !iso(report.sourceCutoff)
      || !iso(report.sourceCommittedAt) || Date.parse(report.sourceCommittedAt) >= Date.parse(report.sourceCutoff)
      || report.latestCommitBeforeCutoff !== true || Date.parse(report.assessedAt) < Date.parse(report.sourceCutoff)) {
      throw new Error("Native report escaped frozen cohort/compiler or immutable source cutoff");
    }
    reports.set(entry.sha256, { report, assessment: assessNativeReport(report) });
  }
  const cutoffs = new Set();
  for (const assessment of ledger.assessments) {
    if (!iso(assessment.cutoff) || !Array.isArray(assessment.reports)
      || new Set(assessment.reports).size !== assessment.reports.length
      || assessment.reports.some(ref => !reports.has(ref)) || assessment.cohortDigest !== hash(cohort)
      || cutoffs.has(assessment.cutoff)) {
      throw new Error("Invalid original native cutoff assessment");
    }
    const items = assessment.reports.map(ref => reports.get(ref).report);
    if (items.some(report => report.sourceCutoff !== assessment.cutoff)
      || new Set(items.map(report => report.repositoryId)).size !== items.length) {
      throw new Error("Duplicate or mismatched native snapshot result");
    }
    cutoffs.add(assessment.cutoff);
  }
  if (!nonempty(ledger.missingReason)) throw new Error("Empty native ledger requires an explicit missing-evidence reason");
  return reports;
}

export async function collectBatch(requests, context = {}) {
  if (!Array.isArray(requests)) throw new Error("Expected a bounded array of observation requests");
  if (requests.length > 10000) throw new Error("Observation batch exceeds bounded replay limit");
  const codec = readFileSync(new URL("../../../../.github/skills/add-operational-value/scripts/json-archive.mjs", import.meta.url));
  if (createHash("sha256").update(codec).digest("hex") !== definition.sourceIdentity.archiveCodecSha256) {
    throw new Error("Frozen archive interpreter identity mismatch");
  }
  const ledger = readJson(context.nativeArchive ?? nativePath);
  const reports = validateLedger(ledger);
  const sources = readJson(sourcePath);
  const expectedBlobs = [definition.sourceIdentity.workflowBlob, definition.sourceIdentity.compiledBlob,
    ...definition.sourceIdentity.imports.map(item => item.gitBlob), ...definition.sourceIdentity.nativeContract];
  if (sources.repository !== repository || sources.repositoryId !== 1036865607 || sources.revision !== revision
    || sources.cutoff !== activation || !Array.isArray(sources.sources) || sources.sources.length !== expectedBlobs.length
    || sources.sources.some((source, index) => source.gitBlob !== expectedBlobs[index])) {
    throw new Error("Invalid immutable source closure");
  }
  for (const source of sources.sources) {
    if (!sha(source.gitBlob) || !safeSource(source.path)) throw new Error("Malformed source identity");
    const bytes = Buffer.from(source.content ?? "", "base64");
    if (source.status !== "preserved" || bytes.toString("base64") !== source.content
      || bytes.length !== source.bytes || createHash("sha256").update(bytes).digest("hex") !== source.sha256
      || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== source.gitBlob) {
      throw new Error("Immutable source closure digest mismatch");
    }
  }
  const ledgerDigest = hash(ledger);
  const snapshots = new Map(ledger.assessments.map(item => [item.cutoff, item]));
  const candidates = new Map(ledger.cohort?.candidates.map(item => [item.repositoryId, item]) ?? []);
  const cohortRepositories = ledger.cohort?.selected.map(id => candidates.get(id).repository);
  const populationDigest = ledger.cohort ? hash(ledger.cohort) : null;
  const compilerDigest = ledger.cohort ? hash(ledger.cohort.compiler) : null;
  return requests.map(request => {
    const { windowStart, windowEnd, observedAt } = request ?? {};
    if (!iso(windowStart) || !iso(windowEnd) || !iso(observedAt)
      || Date.parse(windowStart) < Date.parse(activation) || Date.parse(windowStart) >= Date.parse(windowEnd)
      || Date.parse(windowEnd) > Date.parse(observedAt)
      || request.repository !== undefined && request.repository.toLowerCase() !== repository) {
      throw new Error("Invalid contract-activation window or unsupported repository");
    }
    const snapshot = snapshots.get(windowEnd);
    const known = snapshot ? snapshot.reports.map(ref => reports.get(ref)).filter(item =>
      Date.parse(item.report.assessedAt) <= Date.parse(observedAt)) : [];
    const accepted = known.filter(item => item.assessment.fullInventory && item.assessment.status !== "unknown");
    const compatible = accepted.filter(item => item.assessment.status === "compatible").length;
    const evidence = {
        ...evidenceContract, windowStart, windowEnd, observedAt, maturityStatus: "unavailable",
        coverageStatus: "unknown", missingReason: ledger.missingReason,
        eligibleCount: null, populationDigest: null, compilerDigest: null,
        compatibleRepositories: null, incompatibleRepositories: null, unknownRepositories: null,
        knownCompatibleWorkflows: null, knownAssessedWorkflows: null,
        sourceReadiness: "complete-current-source-historical-adoption-unverified", costs: "not-measured",
        contribution: "not-established", decision: "not-rated",
        ledgerDigest,
    };
    if (ledger.cohort && Date.parse(ledger.cohort.frozenAt) <= Date.parse(windowEnd)) {
      Object.assign(evidence, {
        repositories: cohortRepositories,
        eligibleCount: 20, populationDigest, compilerDigest,
        assessedRepositories: accepted.length, compatibleRepositories: compatible,
        incompatibleRepositories: accepted.length - compatible, unknownRepositories: 20 - accepted.length,
        fullInventoryRepositories: accepted.length,
        knownCompatibleWorkflows: known.reduce((sum, item) => sum + item.assessment.compatibleWorkflows, 0),
        knownAssessedWorkflows: known.reduce((sum, item) => sum + item.assessment.assessedWorkflows, 0),
        coverageStatus: accepted.length === 20 ? "complete" : known.length ? "partial" : "missing",
        maturityStatus: known.length ? "mature" : "unavailable",
        ...(accepted.length === 20 ? { missingReason: null } : {}),
      });
    }
    return {
      evidence,
      provenance: [
        { repository, kind: "immutable-intent-source", ref: `git:${revision}:.github/workflows/${slug}.md@${definition.sourceIdentity.workflowBlob}` },
        { repository, kind: "offline-native-evidence-gap", ref: `sha256:${ledgerDigest}` },
        ...known.map(item => ({ repository: item.report.repository,
          kind: "protected-original-native-compile", ref: `sha256:${hash(item.report)}` })),
      ],
      commit: revision,
    };
  });
}

function safeSource(value) {
  return safePath(value) || typeof value === "string" && /^(?:pkg\/cli|docs\/src\/content\/docs\/reference)\/[A-Za-z0-9_.-]+$/.test(value);
}
