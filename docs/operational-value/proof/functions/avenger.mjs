import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const repository = "github/gh-aw";
const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
const activatedAt = "2026-10-18T06:32:44Z";
const cutoff = "2026-10-18T15:00:12Z";
const sourceBlob = "c2dc70ea2ff6d1e684b4cfd17c3a1e61bb85f56d";
const ciBlob = "48c10a8731efd8b78cf7ee2a3145ca1f2261cf60";
const makeBlob = "2d1f1f3b840f876b8a24a6ca1beaa2006163adac";
const hex = (value, length) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const text = value => typeof value === "string" && value.length > 0;
const iso = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.replace("Z", ".000Z");
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;
const digest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const bytesDigest = value => createHash("sha256").update(value).digest("hex");
const same = (a, b) => a === undefined || b === undefined ? a === b : digest(a) === digest(b);
const positiveId = value => typeof value === "string" && /^[1-9]\d*$/.test(value);
const safePath = value => text(value) && !value.startsWith("/") && !value.split("/").some(part => ["", ".", ".."].includes(part));
const inside = (at, start, end) => at >= start && at < end;

const evidenceContract = {
  key: "avenger-original-ci-condition-repair-v1",
  repositories: [repository],
  opportunity: "Distinct original mechanical failing conditions on main, independently established by a required ci.yml check; infrastructure/transient failures and later introduced defects are separate.",
  filters: [
    "Frozen current-source profile only; never reinterpret an unknown historical intent era.",
    "Original condition identity is frozen before repair: rule, logical locus, predicate and failing input class; never PR, run, test count or an editable tracking marker.",
    "The first landed and independently verified repair of a condition is delivered once. Repeats, reruns, later receipts and duplicate PRs do not redeliver it.",
    "Count all actors. Avenger contribution additionally needs an independent producer/implementation linkage; body markers alone remain discovery.",
    "Skipped, masked, waived, deleted, weakened, setup-failed or differently configured checks do not establish a repair.",
  ],
  collection: "Offline digest-checked retained source, condition catalogue, Git ancestry/landing and protected native check receipts. No commands from the target repository, remote APIs, lazy fetch or workflow execution.",
  measurementKind: "interval",
  window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 },
};
const metric = (id, name, role = "diagnostic", direction = "increase") => ({
  id, name, role, direction, unit: "defects",
  formula: id === "introduced"
    ? "Distinct newly introduced conditions with an independently passing predecessor and failing landed successor, delivered once at max(failure completion, evidence availability); null without exhaustive coverage."
    : id === "incomplete"
      ? "Original conditions established in this interval whose native check/landing proof remains incomplete at observedAt; null without catalogue coverage. Not a count of failed runs."
      : `Distinct original-condition identities in ${id}; delivered at max(landing time, first matching protected native pass completion, evidence availability). Null without corresponding coverage, with accepted partial subtotals retained.`,
  presentation: { name, legendLabel: id.slice(0, 24), transform: "identity" },
});
const example = (repairs, complete, linked, introduced, incomplete) => ({
  key: evidenceContract.key, schemaVersion: 1, validatedNativeEvidence: true,
  coverageStatus: "complete", eligibleCount: 4, populationDigest: "a".repeat(64),
  nativeCounts: { repairs, complete, linked, introduced, incomplete },
  metricCoverage: { repairs: true, complete: true, linked: true, introduced: true, incomplete: true },
  measurementKind: "interval", windowStart: activatedAt, windowEnd: cutoff,
});

export const definition = {
  schemaVersion: 3, slug: "avenger", repository, workflowName: "Avenger",
  sourcePath: ".github/workflows/avenger.md",
  intent: {
    goal: "For original mechanical CI defects on main, restore the same required failing condition by a landed minimal fix, independently verified without bypass, measured as distinct defects repaired per non-overlapping period.",
    acceptance: "An original protected native failure and an exercised pass under the same predicate, required check, toolchain, scope and suppression policy; immutable main landing and ordered receipts. A PR, merge, green job, self-healing run or agent evaluation alone is insufficient.",
    temporalAnchor: "contract-activation",
  },
  adoption: { commit: revision, adoptedAt: activatedAt, baselineCommit: null, baselineAt: null },
  evaluation: { mode: "attainment-only" },
  evidence: evidenceContract,
  sourceProfile: {
    revision, sourceBlob, ciBlob, makeBlob, cutoff,
    sourceSha256: "7b003b1d1d9e28b08b8cf4f26643d7912c484de48570e3ed69048c4368496485",
    sourceArchiveSha256: "811b2e7ccd81eb48409fe5e0699acc4703725598b97f6a347ca0daac491eb3ad",
    discoveryArchiveSha256: "e29c1237adfb1a33a95e37b4b97c5058bf2020e095356cec4c0d16a883a4fb40",
    discoveryIndexSha256: "43000ac536195c686e0af961ed401e7144f9ef17b9ea276583b9927c55d16a71",
    actualWorkflowAddition: "928cdd6ba4a388dfed2d4ddd1d7b229551f7f6bc",
    actualAdditionParent: "f2738c94a86819bc4d95f17ec0081713da78e463",
    actualAddedAt: "2026-05-24T00:06:12Z",
    historicalReadiness: "Addition is verified against the actual parent, not a shallow boundary. No historical native baseline established; reconstruction is not exhausted. Current predicates are not backdated to adoption.",
    sources: "../avenger/sources.json.gz",
    nativeEvidence: "../avenger/native-evidence.json",
  },
  nativeAcceptance: {
    conditionIdentity: ["repositoryId", "rule", "locus", "predicateSha256", "inputClassSha256"],
    catalogue: "An independently adjudicated pre-repair catalogue must join equivalent diagnostics to the same original condition. Ambiguous root-cause identity stays incomplete, not one defect per failing testcase.",
    categories: ["formatting", "lint", "tests", "wasm-golden", "compile", "other"],
    decoders: ["go-test-jsonl", "golangci-json", "go-fmt", "prettier-check", "go-build"],
    unsupported: "Other native formats and unreviewed source/checker eras remain incomplete and cannot imply zero repairs.",
    planIdentity: ["ciBlob", "makeBlob", "predicateSha256", "assertionInputsSha256", "toolchainSha256", "configurationSha256", "suppressionSha256", "scopeSha256", "argv", "job", "matrix"],
    predicateIdentity: "Hash the complete native assertion closure, including test assertions, frozen golden expectations, normalization, exclusions and expected results. The producer must retain source/input inclusion proofs at both heads; a bare self-declared hash or changed expected fixture is not an oracle.",
    evidenceTrust: "Retained protected-producer projections are an explicit external evidence trust boundary. Digests verify integrity, not remote authenticity or causal condition equivalence. A future producer must bind actual platform job, branch policy, logs/artifacts, source/input inclusion and protected condition catalogue before emitting these envelopes; no such producer evidence is retained here.",
    requiredCheck: "Retained requirement receipt at both heads must bind the same CI job/matrix/predicate to protected branch requirements; an Actions success is not evidence it was required.",
    fullGoal: "Native repair plus protected passing make fmt, make lint, make test-unit and all applicable non-tolerated CI assertions at the landed revision, with complete introduced-defect assessment and zero introductions. Local sampled test-unit is not exhaustive CI recovery.",
    safeguards: [
      "make test-unit defaults to a 30-second impacted sample, up to five top-level tests per impacted package; a successful sample cannot prove the original failure was exercised.",
      "Wasm golden normalization and graceful skips mean suite success or regenerated expected bytes alone is insufficient; require the unchanged original subtest to pass without a skip.",
      "Race-detector CI is schedule-only and continue-on-error; explicitly disabled marketplace and negative-control GH_HOST reproduction are not buildability proofs.",
      "Lint includes stale locks, skill paths, gofmt, JSON/JS formatting, syntax, golangci, model aliases, no-python shell checks, shellcheck and stale schema binary. A skipped golangci check remains incomplete.",
      "Workflow files are excluded from safe-output PRs. File guards (>50 recompile, >80 staged), 8-minute budget and 50 turns are process safeguards, not repair quantities.",
    ],
    maturation: "No invented waiting period; deliver only after landing and independent pass are both observed. Later discovery cannot move delivery into an earlier period.",
  },
  model: {
    architecture: "Native condition-level proof pairs, with separate progress, full acceptance, regression, incompleteness and contribution channels.",
    recommendation: "Not rated: no source-defined keep bar, accepted native history or matching costs. Acquire only coordinator-approved bounded missing inputs.",
    presentation: { label: "Original CI defects repaired", betterLabel: "More independently proven repairs" },
  },
  summary: { nativeLabel: "Distinct original mechanical CI defects repaired" },
  metrics: [
    metric("repairs", "Independently demonstrated original repairs", "primary"),
    metric("complete", "Repairs with full buildability acceptance"),
    metric("linked", "Demonstrated Avenger contributions"),
    metric("introduced", "Independently demonstrated introduced defects", "diagnostic", "decrease"),
    metric("incomplete", "Conditions with incomplete check evidence", "diagnostic", "decrease"),
  ],
  signal: { metricId: "linked", basis: "workflow-contribution" },
  dispositions: {
    primary: "Count repaired original mechanical conditions independently of actor.",
    diagnostic: "Keep full buildability, introduced defects, unresolved checks and demonstrated contribution separate; never subtract or average them into progress.",
    rejected: ["PR/issue/run counts", "Merge count", "CI conclusion alone", "Agent-authored evals", "Trajectory recurrence graders", "Self-reported checks", "Arbitrary quality weights", "Time/dollar savings without costs"],
    antecedent: "Original mechanical CI defects and repairs pre-exist Avenger; exact current-source history has not been reconstructed. Baseline unavailable is not exhausted or zero.",
  },
  validationExamples: {
    targetAttained: example(3, 2, 2, 0, 0),
    targetMissed: example(1, 0, 0, 2, 2),
    missing: { coverageStatus: "missing" },
    malformed: { nativeCounts: { repairs: -1 } },
  },
};

function validateWindow(request) {
  if (!request || ![request.windowStart, request.windowEnd, request.observedAt].every(iso)
    || request.windowStart >= request.windowEnd || request.observedAt < request.windowEnd
    || (request.repository !== undefined && request.repository !== repository)) {
    throw new Error("Invalid Avenger bounded window or repository");
  }
}

function validateArchive(archive) {
  if (!archive || archive.schemaVersion !== 1 || archive.kind !== "avenger-native-ci-repairs"
    || archive.repository !== repository || archive.repositoryId !== 1036865607
    || archive.sourceRevision !== revision || !iso(archive.observedAt)
    || !Array.isArray(archive.conditions) || !Array.isArray(archive.repairs)
    || !Array.isArray(archive.introduced) || !Array.isArray(archive.coverage) || !Array.isArray(archive.receipts)
    || typeof archive.missingReason !== "string") throw new Error("Invalid Avenger native archive");
  let previous = null;
  for (const coverage of archive.coverage) {
    if (![coverage.startAt, coverage.endAt].every(iso) || coverage.startAt >= coverage.endAt
      || previous && coverage.startAt < previous || coverage.startAt < activatedAt
      || !["complete", "partial", "missing", "unknown"].includes(coverage.status)
      || !Array.isArray(coverage.facets)
      || !iso(coverage.knownAt) || coverage.knownAt > archive.observedAt
      || coverage.facets.some(id => !definition.metrics.some(metric => metric.id === id))
      || coverage.status === "complete" && (!hex(coverage.inventorySha256, 64)
        || !text(coverage.inventoryRef))) throw new Error("Invalid native coverage interval");
    previous = coverage.endAt;
  }
  const identities = new Map();
  for (const condition of archive.conditions) {
    if (!condition || !definition.nativeAcceptance.categories.includes(condition.category)
      || !text(condition.rule) || !safePath(condition.locus)
      || !hex(condition.predicateSha256, 64) || !hex(condition.inputClassSha256, 64)
      || !iso(condition.establishedAt) || !text(condition.catalogueRef)
      || !hex(condition.catalogueSha256, 64)
      || !["original", "introduced"].includes(condition.origin)) throw new Error("Invalid frozen native condition");
    const key = conditionKey(condition);
    if (identities.has(key) && !same(identities.get(key), condition)) throw new Error("Conflicting condition identity");
    identities.set(key, condition);
  }
  return identities;
}

function retainedReceipts(archive) {
  const receipts = new Map();
  for (const receipt of archive.receipts) {
    if (!receipt || !text(receipt.ref) || !text(receipt.kind) || typeof receipt.payload !== "string"
      || !hex(receipt.sha256, 64) || bytesDigest(receipt.payload) !== receipt.sha256
      || !iso(receipt.knownAt) || receipt.knownAt > archive.observedAt) {
      throw new Error("Invalid retained native producer receipt");
    }
    const prior = receipts.get(receipt.sha256);
    if (prior && !same(prior, receipt)) throw new Error("Conflicting retained receipt identity");
    receipts.set(receipt.sha256, receipt);
  }
  return receipts;
}

function binds(receipts, sha256, ref, kind, expected, observedAt) {
  const receipt = receipts.get(sha256);
  if (!receipt || receipt.ref !== ref || receipt.kind !== kind || receipt.knownAt > observedAt) return false;
  let payload;
  try { payload = JSON.parse(receipt.payload); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; return false; }
  return Object.entries(expected).every(([key, value]) => same(payload[key], value));
}

function conditionKey(condition) {
  return digest({ repositoryId: 1036865607, rule: condition.rule, locus: condition.locus,
    predicateSha256: condition.predicateSha256, inputClassSha256: condition.inputClassSha256 });
}

function planValid(plan, condition) {
  return plan?.ciBlob === ciBlob && plan.makeBlob === makeBlob
    && plan.predicateSha256 === condition.predicateSha256
    && ["assertionInputsSha256", "toolchainSha256", "configurationSha256", "suppressionSha256", "scopeSha256"].every(key => hex(plan[key], 64))
    && Array.isArray(plan.argv) && plan.argv.length > 0 && plan.argv.every(text)
    && text(plan.job) && plan.matrix && typeof plan.matrix === "object" && !Array.isArray(plan.matrix);
}

function receiptValid(check, condition, observedAt, receipts) {
  if (!check || check.repositoryId !== 1036865607 || check.branch !== "main"
    || !hex(check.headSha, 40) || !iso(check.startedAt) || !iso(check.completedAt)
    || check.startedAt > check.completedAt || check.completedAt > observedAt
    || check.startedAt < activatedAt || !positiveId(check.runId) || !positiveId(check.jobId)
    || !Number.isSafeInteger(check.attempt) || check.attempt < 1 || check.appId !== 15368
    || check.workflowPath !== ".github/workflows/ci.yml" || check.status !== "completed"
    || check.skipped !== false || check.continueOnError !== false || check.setup !== "complete"
    || !planValid(check.plan, condition) || !text(check.providerRef)
    || !hex(check.providerSha256, 64) || !check.requirement
    || check.requirement.headSha !== check.headSha || check.requirement.job !== check.plan.job
    || !same(check.requirement.matrix, check.plan.matrix)
    || !hex(check.requirement.policySha256, 64) || !text(check.requirement.providerRef)
    || check.requirement.enforcement !== "required"
    || !Array.isArray(check.inputPaths) || !check.inputPaths.includes(condition.locus)
    || !check.native || !text(check.native.format)
    || typeof check.native.stdout !== "string" || typeof check.native.stderr !== "string"
    || !Number.isInteger(check.native.exitCode) || check.native.exitCode < 0
    || !hex(check.native.sha256, 64)
    || check.native.sha256 !== digest({ format: check.native.format, stdout: check.native.stdout,
      stderr: check.native.stderr, exitCode: check.native.exitCode })) return false;
  return binds(receipts, check.providerSha256, check.providerRef, "protected-native-check", {
    repositoryId: check.repositoryId, headSha: check.headSha, workflowPath: check.workflowPath,
    runId: check.runId, jobId: check.jobId, attempt: check.attempt, appId: check.appId,
    plan: check.plan, nativeSha256: check.native.sha256, inputPaths: check.inputPaths,
    startedAt: check.startedAt, completedAt: check.completedAt,
    setup: "complete", skipped: false, continueOnError: false, branch: "main",
  }, observedAt) && binds(receipts, check.requirement.policySha256, check.requirement.providerRef,
    "branch-requirement", { headSha: check.headSha, job: check.plan.job, matrix: check.plan.matrix,
      repositoryId: 1036865607, enforcement: "required", predicateSha256: condition.predicateSha256 }, observedAt);
}

function nativeResult(check, condition) {
  const { format, stdout, stderr, exitCode } = check.native;
  const argv = check.plan.argv;
  if (format === "go-test-jsonl" && ["tests", "wasm-golden"].includes(condition.category)) {
    if (argv[0] !== "go" || argv[1] !== "test" || !argv.includes("-json")
      || argv.some(argument => argument === "-update" || argument.startsWith("-update="))
      || !text(condition.package) || !text(condition.test)
      || condition.category === "wasm-golden" && !condition.test.startsWith("TestWasmGolden_")) return null;
    let rows;
    try { rows = stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return null;
    }
    const selected = rows.filter(row => row.Package === condition.package && row.Test === condition.test);
    if (!selected.some(row => row.Action === "run")) return null;
    const final = selected.filter(row => ["pass", "fail", "skip"].includes(row.Action));
    if (final.length !== 1 || final[0].Action === "skip") return null;
    if (final[0].Action === "pass") return exitCode === 0 ? "pass" : null;
    return exitCode !== 0 ? "fail" : null;
  }
  if (format === "golangci-json" && condition.category === "lint") {
    if (argv[0] !== "golangci-lint" || argv[1] !== "run" || !text(condition.diagnostic)) return null;
    let report;
    try { report = JSON.parse(stdout); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; return null; }
    if (!Array.isArray(report.Issues) || report.Error || report.Report?.Error) return null;
    const matched = report.Issues.some(issue => issue.FromLinter === condition.rule
      && issue.Pos?.Filename === condition.locus && issue.Text === condition.diagnostic);
    if (matched) return exitCode === 1 ? "fail" : null;
    return exitCode === 0 && report.Issues.length === 0 ? "pass" : null;
  }
  if (format === "go-fmt" && condition.category === "formatting") {
    if (argv[0] !== "gofmt" || !argv.includes("-l") || argv.includes("-w")) return null;
    if (exitCode !== 0 || stderr.trim()) return null;
    const paths = stdout.split(/\r?\n/).filter(Boolean);
    if (paths.some(path => !safePath(path) || !check.inputPaths.includes(path))) return null;
    return paths.includes(condition.locus) ? "fail" : "pass";
  }
  if (format === "prettier-check" && condition.category === "formatting") {
    if (!["prettier", "npx"].includes(argv[0]) || !argv.includes("--check")
      || argv.includes("--write")) return null;
    const warning = stdout.includes(`[warn] ${condition.locus}`) || stderr.includes(`[warn] ${condition.locus}`);
    if (warning && exitCode === 1) return "fail";
    return exitCode === 0 && stdout.includes("All matched files use Prettier code style!")
      && !/\[warn\]|\[error\]/.test(stdout + stderr) ? "pass" : null;
  }
  if (format === "go-build" && condition.category === "compile") {
    if (argv[0] !== "go" || argv[1] !== "build" || !text(condition.diagnostic)) return null;
    const diagnostic = `${condition.locus}:${condition.diagnostic}`;
    if (exitCode === 1 && stderr.split("\n").includes(diagnostic)) return "fail";
    return exitCode === 0 && !stdout.trim() && !stderr.trim() ? "pass" : null;
  }
  return null;
}

function validLanding(landing, before, after, receipts, observedAt) {
  if (!landing || landing.repositoryId !== 1036865607 || landing.branch !== "main"
    || !iso(landing.at) || !hex(landing.commit, 40) || landing.commit !== after.headSha
    || !text(landing.providerRef) || !hex(landing.providerSha256, 64)
    || !Array.isArray(landing.commitChain) || landing.commitChain.length < 1
    || landing.commitChain.length > 1000) return false;
  let child = landing.commit;
  for (const object of landing.commitChain) {
    if (!object || object.sha !== child || typeof object.raw !== "string") return false;
    const bytes = Buffer.from(object.raw);
    if (createHash("sha1").update(`commit ${bytes.length}\0`).update(bytes).digest("hex") !== child) return false;
    const parents = [...object.raw.matchAll(/^parent ([a-f0-9]{40})$/gm)].map(match => match[1]);
    if (!parents.includes(object.nextParent)) return false;
    child = object.nextParent;
  }
  return child === before.headSha && before.completedAt <= landing.at && landing.at <= after.startedAt
    && binds(receipts, landing.providerSha256, landing.providerRef, "main-landing",
      { repositoryId: 1036865607, commit: landing.commit, branch: "main", at: landing.at }, observedAt);
}

function assessRepair(record, conditions, observedAt, receipts) {
  if (!record || !hex(record.conditionKey, 64)) throw new Error("Malformed native repair record");
  const condition = conditions.get(record.conditionKey);
  if (!condition || condition.origin !== "original") throw new Error("Repair references no original condition");
  const before = record.before, after = record.after;
  if (!receiptValid(before, condition, observedAt, receipts) || !receiptValid(after, condition, observedAt, receipts)
    || condition.establishedAt > before.completedAt || condition.establishedAt > record.landing?.at
    || !same(before.plan, after.plan)
    || nativeResult(before, condition) !== "fail" || nativeResult(after, condition) !== "pass"
    || !validLanding(record.landing, before, after, receipts, observedAt)
    || !binds(receipts, condition.catalogueSha256, condition.catalogueRef, "condition-catalogue",
      { conditionKey: record.conditionKey, establishedAt: condition.establishedAt, origin: "original",
        rule: condition.rule, locus: condition.locus, predicateSha256: condition.predicateSha256,
        inputClassSha256: condition.inputClassSha256, equivalence: "independently-adjudicated" }, observedAt)) return null;
  const contribution = record.contribution;
  const linked = contribution && ["receipt-verified", "corroborated"].includes(contribution.status)
    && contribution.workflowId === "avenger" && contribution.sourceBlob === sourceBlob
    && positiveId(contribution.originalRunId) && text(contribution.providerRef)
    && hex(contribution.providerSha256, 64) && contribution.acceptedCommit === after.headSha
    && contribution.conditionKey === record.conditionKey
    && ["protected-creation-receipt", "independent-implementation-edge"].includes(contribution.kind)
    && binds(receipts, contribution.providerSha256, contribution.providerRef, "workflow-contribution",
      { workflowId: "avenger", sourceBlob, originalRunId: contribution.originalRunId,
        acceptedCommit: after.headSha, conditionKey: record.conditionKey, kind: contribution.kind }, observedAt);
  const full = record.fullAcceptance;
  const complete = full?.headSha === after.headSha && full?.sourceRevision === revision
    && full?.introducedAssessment === "complete" && full?.introducedDefects === 0
    && Array.isArray(full.commands) && ["make fmt", "make lint", "make test-unit"].every(command =>
      full.commands.some(check => check.command === command && check.status === "passed"
        && check.skipped === false && hex(check.receiptSha256, 64) && text(check.providerRef)))
    && full.ciCoverage === "all-applicable-assertions" && hex(full.ciInventorySha256, 64)
    && text(full.ciInventoryRef)
    && full.commands.every(command => binds(receipts, command.receiptSha256, command.providerRef,
      "protected-native-command", { headSha: after.headSha, command: command.command,
        status: "passed", skipped: false, independentlyExecuted: true }, observedAt))
    && binds(receipts, full.ciInventorySha256, full.ciInventoryRef, "complete-ci-inventory",
      { headSha: after.headSha, sourceRevision: revision, coverage: "all-applicable-assertions",
        introducedAssessment: "complete", introducedDefects: 0,
        commands: full.commands, bypassAssessment: "unchanged", nativeReceiptsVerified: true }, observedAt);
  return { key: record.conditionKey, headSha: after.headSha,
    at: [after.completedAt, record.knownAt].sort().at(-1), knownAt: record.knownAt,
    linked: Boolean(linked), complete: Boolean(complete),
    contributionAssessed: Boolean(linked), fullAcceptanceAssessed: Boolean(complete),
    recordDigest: digest(record) };
}

function covered(archive, request, facet, receipts) {
  let end = request.windowStart;
  for (const row of archive.coverage) {
    if (row.endAt <= end || row.startAt >= request.windowEnd) continue;
    if (row.startAt > end || row.status !== "complete" || !row.facets.includes(facet)
      || row.knownAt > request.observedAt
      || !binds(receipts, row.inventorySha256, row.inventoryRef, "native-coverage-inventory",
        { repositoryId: 1036865607, sourceRevision: revision, startAt: row.startAt, endAt: row.endAt,
          facets: row.facets, conditions: archive.conditions.map(conditionKey).sort(),
          state: "exhaustive", comparison: "unchanged-native-predicates" }, request.observedAt)) return false;
    end = row.endAt;
    if (end >= request.windowEnd) return true;
  }
  return false;
}

export function assessNativeArchive(archive, request) {
  validateWindow(request);
  const conditions = validateArchive(archive);
  const receipts = retainedReceipts(archive);
  const evidence = {
    ...evidenceContract, schemaVersion: 1, validatedNativeEvidence: true,
    windowStart: request.windowStart, windowEnd: request.windowEnd, observedAt: request.observedAt,
    coverageStatus: "missing", maturityStatus: "unavailable", dubious: true,
    missingReason: archive.missingReason || "Native condition/check coverage is incomplete.",
    eligibleCount: null, populationDigest: null, costs: { status: "not-measured" },
    nativeCounts: { repairs: 0, complete: 0, linked: 0, introduced: 0, incomplete: 0 },
    metricCoverage: { repairs: false, complete: false, linked: false, introduced: false, incomplete: false },
    partialNativeCounts: { repairs: 0, complete: 0, linked: 0, introduced: 0, incomplete: 0 },
    accepted: [], rejectedProofPairs: 0,
    openScope: ["Unknown historical source/check eras", "Unretained native condition/check/landing evidence",
      "Branch requirement snapshots", "Unmeasured matching period costs", "Historical baseline reconstruction not exhausted"],
  };
  const active = request.windowStart >= activatedAt && request.windowEnd <= cutoff;
  const repairs = new Map();
  for (const row of archive.repairs) {
    if (!iso(row.knownAt)) throw new Error("Native repair needs an authoritative evidence-availability timestamp");
    if (row.knownAt > request.observedAt) continue;
    const result = assessRepair(row, conditions, request.observedAt, receipts);
    if (!result) { evidence.rejectedProofPairs += 1; continue; }
    const prior = repairs.get(result.key);
    if (!prior || result.at < prior.at) repairs.set(result.key, result);
    else if (result.at === prior.at && result.recordDigest !== prior.recordDigest) {
      if (result.complete !== prior.complete || result.linked !== prior.linked) {
        throw new Error("Conflicting native acceptance or contribution for one delivery");
      }
    }
  }
  const eligible = [...conditions.entries()].filter(([, condition]) => condition.origin === "original"
    && condition.establishedAt < request.windowEnd && condition.establishedAt <= request.observedAt);
  for (const repair of repairs.values()) {
    if (!active || !inside(repair.at, request.windowStart, request.windowEnd)) continue;
    evidence.accepted.push(repair);
    evidence.partialNativeCounts.repairs += 1;
    evidence.partialNativeCounts.complete += Number(repair.complete);
    evidence.partialNativeCounts.linked += Number(repair.linked);
  }
  const unresolved = new Set();
  for (const [key, condition] of eligible) {
    if (!repairs.has(key) && inside(condition.establishedAt, request.windowStart, request.windowEnd)) unresolved.add(key);
  }
  evidence.partialNativeCounts.incomplete = unresolved.size;
  const introduced = new Map();
  for (const row of archive.introduced) {
    const condition = conditions.get(row.conditionKey);
    if (!condition || condition.origin !== "introduced" || !iso(row.knownAt)) {
      throw new Error("Invalid introduced-defect record");
    }
    if (row.knownAt <= request.observedAt && active
      && receiptValid(row.before, condition, request.observedAt, receipts)
      && receiptValid(row.check, condition, request.observedAt, receipts)
      && same(row.before.plan, row.check.plan) && nativeResult(row.before, condition) === "pass"
      && nativeResult(row.check, condition) === "fail"
      && validLanding(row.landing, row.before, row.check, receipts, request.observedAt)
      && binds(receipts, condition.catalogueSha256, condition.catalogueRef, "condition-catalogue",
        { conditionKey: row.conditionKey, establishedAt: condition.establishedAt, origin: "introduced",
          rule: condition.rule, locus: condition.locus, predicateSha256: condition.predicateSha256,
          inputClassSha256: condition.inputClassSha256, equivalence: "independently-adjudicated" }, request.observedAt)) {
      const at = [row.check.completedAt, row.knownAt].sort().at(-1);
      if (!introduced.has(row.conditionKey) || at < introduced.get(row.conditionKey).at) {
        introduced.set(row.conditionKey, { at, headSha: row.check.headSha });
      }
    }
  }
  evidence.partialNativeCounts.introduced = [...introduced.values()].filter(row =>
    inside(row.at, request.windowStart, request.windowEnd)).length;
  for (const repair of evidence.accepted) {
    if (repair.complete && [...introduced.values()].some(row => row.headSha === repair.headSha)) {
      repair.complete = false;
      repair.fullAcceptanceAssessed = false;
      evidence.partialNativeCounts.complete -= 1;
    }
  }
  for (const key of Object.keys(evidence.metricCoverage)) {
    evidence.metricCoverage[key] = active && covered(archive, request, key, receipts);
    evidence.nativeCounts[key] = evidence.partialNativeCounts[key];
  }
  if (evidence.accepted.some(row => !row.fullAcceptanceAssessed)) evidence.metricCoverage.complete = false;
  if (evidence.accepted.some(row => !row.contributionAssessed)) evidence.metricCoverage.linked = false;
  if (evidence.metricCoverage.repairs) {
    evidence.coverageStatus = "complete";
    evidence.maturityStatus = Date.parse(request.windowEnd) - Date.parse(request.windowStart) < 7 * 86400000 ? "interim" : "mature";
    evidence.dubious = evidence.maturityStatus === "interim";
    evidence.missingReason = "";
    evidence.eligibleCount = eligible.length;
    evidence.populationDigest = digest(eligible.map(([key]) => key).sort());
  } else if (evidence.accepted.length > 0) {
    evidence.coverageStatus = "partial";
  }
  if (!active) evidence.missingReason = "Requested window is outside the reviewed current-source era or frozen evidence cutoff; historical reconstruction is not exhausted.";
  return evidence;
}

function readSources() {
  const bytes = readFileSync(new URL("../avenger/sources.json.gz", import.meta.url));
  if (bytesDigest(bytes) !== definition.sourceProfile.sourceArchiveSha256) throw new Error("Frozen source archive digest mismatch");
  const bundle = JSON.parse(gunzipSync(bytes, { maxOutputLength: 8 * 1024 * 1024 }));
  if (bundle.revision !== revision || bundle.repository !== repository || bundle.repositoryId !== 1036865607
    || !Array.isArray(bundle.sources)) throw new Error("Invalid retained Avenger source scope");
  for (const source of bundle.sources) {
    const content = Buffer.from(source.content, "base64");
    if (content.toString("base64") !== source.content || content.length !== source.bytes
      || bytesDigest(content) !== source.sha256
      || createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex") !== source.gitBlob) {
      throw new Error("Retained Avenger source integrity mismatch");
    }
  }
  for (const [path, id] of [[".github/workflows/avenger.md", sourceBlob], [".github/workflows/ci.yml", ciBlob], ["Makefile", makeBlob]]) {
    if (bundle.sources.find(source => source.path === path)?.gitBlob !== id) throw new Error("Frozen source profile mismatch");
  }
  return { sha256: bytesDigest(bytes), missing: bundle.missing };
}

function readDiscovery() {
  const load = (file, expected) => {
    const bytes = readFileSync(new URL(`../avenger/${file}`, import.meta.url));
    if (bytesDigest(bytes) !== expected) throw new Error("Retained discovery integrity mismatch");
    return JSON.parse(gunzipSync(bytes, { maxOutputLength: 8 * 1024 * 1024 }));
  };
  const index = load("discovery-index.json.gz", definition.sourceProfile.discoveryIndexSha256);
  const data = load("discovery.json.gz", definition.sourceProfile.discoveryArchiveSha256);
  if (index.repositoryId !== 1036865607 || index.sourceRevision !== revision || index.until !== cutoff
    || index.partitions.length !== 346 || index.totalEntities !== 58048
    || data.repositoryId !== 1036865607 || data.sourceRevision !== revision || data.cutoff !== cutoff
    || !Array.isArray(data.selected) || data.selected.length !== 344
    || data.selected.some(row => row.workflowReference?.workflowId !== "avenger" && row.unverifiedWorkflowId !== "avenger")) {
    throw new Error("Retained discovery scope mismatch");
  }
  return { selectedCount: data.selected.length, relatedCount: data.related.length,
    verifiedSharedPartitions: index.partitions.length, verifiedSharedEntities: index.totalEntities,
    interpretation: "Discovery only, never native outcome observations" };
}

export async function collectBatch(requests, context = {}) {
  if (!Array.isArray(requests) || requests.length > 10000) throw new Error("Invalid Avenger request batch");
  requests.forEach(validateWindow);
  const source = readSources();
  const discovery = readDiscovery();
  const file = context.nativeEvidenceFile ?? new URL("../avenger/native-evidence.json", import.meta.url);
  const bytes = readFileSync(file);
  const archive = JSON.parse(bytes);
  validateArchive(archive);
  return requests.map(request => ({
    evidence: { ...assessNativeArchive(archive, request), missingSources: source.missing, discovery },
    commit: revision,
    provenance: [
      { repository, kind: "immutable-git-source", ref: `${revision}:.github/workflows/avenger.md#${sourceBlob}` },
      { repository, kind: "verified-source-closure", ref: `sha256:${source.sha256}` },
      { repository, kind: "retained-native-archive", ref: `sha256:${bytesDigest(bytes)}` },
      { repository, kind: "discovery-not-outcome", ref: `sha256:${definition.sourceProfile.discoveryArchiveSha256}` },
    ],
  }));
}

export function scoreMetric(id, evidence) {
  if (!definition.metrics.some(metric => metric.id === id)) return null;
  if (!evidence || evidence.schemaVersion !== 1 || evidence.key !== evidenceContract.key
    || evidence.validatedNativeEvidence !== true || evidence.metricCoverage?.[id] !== true
    || evidence.measurementKind !== "interval" || !iso(evidence.windowStart) || !iso(evidence.windowEnd)
    || evidence.windowStart >= evidence.windowEnd || evidence.windowStart < activatedAt
    || evidence.windowEnd > cutoff || !Number.isSafeInteger(evidence.eligibleCount)
    || evidence.eligibleCount < 0 || !hex(evidence.populationDigest, 64)
    || !["complete", "partial"].includes(evidence.coverageStatus)
    || !evidence.nativeCounts || Object.values(evidence.nativeCounts).some(value => !Number.isSafeInteger(value) || value < 0)
    || evidence.nativeCounts.repairs > evidence.eligibleCount
    || evidence.nativeCounts.complete > evidence.nativeCounts.repairs
    || evidence.nativeCounts.linked > evidence.nativeCounts.repairs) return null;
  const value = evidence.nativeCounts[id];
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
