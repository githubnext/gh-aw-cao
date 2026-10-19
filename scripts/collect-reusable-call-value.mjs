// Measurement contract + acquisition for the github/gh-aw smoke-workflow-call /
// smoke-call-workflow reusable-call cohort, frozen at revision
// c86377ec47b38f0b5af463277ee55d1d03d08da8 (cutoff 2026-10-18T15:00:12Z).
//
// `smoke-call-workflow` is the orchestrator: its `call-workflow` safe output
// compiles (see the `call-smoke-workflow-call` job in its own .lock.yml) to a
// job that runs `uses: ./.github/workflows/smoke-workflow-call.lock.yml`
// *nested inside the orchestrator's own run* (compile-time fan-out). The
// worker's independent run list therefore never contains its workflow_call
// invocations; every workflow_call-context execution of the worker is only
// observable as a nested job inside an orchestrator run. Both modules in this
// file score distinct native questions from the SAME underlying orchestrator
// run inventory:
//   - orchestrator (smoke-call-workflow): did the declared worker and the
//     declared task-description input actually reach the nested job?
//   - worker (smoke-workflow-call): when invoked, did the nested job's
//     protected pre-agent Git readback match the caller-forwarded head/ref
//     with a clean, initialized, origin-bound workspace?
// A dispatch/comment/PASS footer alone proves neither question; see each
// role's `intent.acceptance` below.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { publicGitSourceReader, verifyPublicGitBlob } from "./immutable-public-git-source.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";

const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;

export const repository = "github/gh-aw";
export const repositoryId = 1036865607;
export const sourceRevision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
export const until = "2026-10-18T15:00:12Z";
export const directory = "docs/operational-value/proof/reusable-call";
export const workerWorkflowId = "smoke-workflow-call";
export const orchestratorWorkflowId = "smoke-call-workflow";
const roleWorkflowId = { worker: workerWorkflowId, orchestrator: orchestratorWorkflowId };

// --- Eligibility ------------------------------------------------------------
//
// `run` describes a single smoke-call-workflow orchestrator run (the only
// entry point that can observe either role, per the fan-out architecture
// above). `orchestratorDispatched` is null until the orchestrator's own
// receipt is independently known; worker eligibility is conditional on it.
export function reusableCallOpportunity(run, role) {
  if (!run || run.repositoryId !== repositoryId || run.repository !== repository) {
    return { eligible: null, reason: "No original same-repository run receipt." };
  }
  if (role === "orchestrator") {
    if (run.event === "schedule") return { eligible: true, triggerClass: "schedule-cycle" };
    if (run.event === "workflow_dispatch") return { eligible: true, triggerClass: "manual-dispatch" };
    if (run.event === "pull_request") return { eligible: true, triggerClass: "pr-labeled-water" };
    if (run.event === "issue_comment" || run.event === "issues") {
      return { eligible: true, triggerClass: "centralized-slash-dispatch" };
    }
    return { eligible: false, triggerClass: "unsupported-trigger-control" };
  }
  if (role === "worker") {
    if (run.orchestratorDispatched === true) return { eligible: true, triggerClass: "nested-workflow-call-dispatch" };
    if (run.orchestratorDispatched === false) return { eligible: false, triggerClass: "no-dispatch-control" };
    return { eligible: null, reason: "Orchestrator dispatch state unknown; workflow_call context unverified." };
  }
  throw new Error(`Unknown reusable-call role: ${role}`);
}

// --- Scoring -----------------------------------------------------------------
//
// `receipt.runId`/`attempt` bind an immutable original orchestrator-run
// identity (custody-checked via `runSha256`); `receipt.orchestrator` carries
// the independently captured call-workflow dispatch facts, and
// `receipt.worker` carries the independently captured nested-job checkout
// readback. Either sub-record may be unknown (null) even when the run itself
// is bound, which keeps "known but ineligible" distinct from "unknown".
export function assessReusableCallReceipt(receipt, role, contract) {
  const unknown = (reason) => ({ eligible: null, attained: null, headMatches: null, reason });
  if (!receipt || !positive(receipt.runId) || receipt.attempt !== 1 || !digest(receipt.runSha256)
    || censusDigest({
      runId: receipt.runId, attempt: receipt.attempt, event: receipt.event,
      repository: receipt.repository, repositoryId: receipt.repositoryId,
    }) !== receipt.runSha256) {
    return unknown("No immutable original run receipt.");
  }
  if (receipt.lockGitBlob !== contract.orchestratorLockGitBlob || receipt.sourceVerified !== true
    || receipt.policyAdmitted !== true) {
    return unknown("Unbound historical source policy.");
  }
  const opportunity = reusableCallOpportunity({
    repository: receipt.repository, repositoryId: receipt.repositoryId, event: receipt.event,
    orchestratorDispatched: receipt.orchestrator?.dispatched ?? null,
  }, role);
  if (opportunity.eligible !== true) return { ...opportunity, attained: null, headMatches: null };
  if (role === "orchestrator") {
    const row = receipt.orchestrator;
    if (!row || typeof row.dispatched !== "boolean") {
      return { ...opportunity, attained: null, headMatches: null, reason: "Dispatch state unknown." };
    }
    if (row.dispatched === false) return { ...opportunity, attained: false, headMatches: false, reason: null };
    if (typeof row.calledWorkflowFile !== "string") {
      return { ...opportunity, attained: null, headMatches: null, reason: "Dispatch known; declared workflow file unknown." };
    }
    const headMatches = row.calledWorkflowFile === contract.calledWorkflowFile;
    if (!headMatches) return { ...opportunity, attained: false, headMatches: false, reason: null };
    if (typeof row.taskDescriptionActual !== "string") {
      return { ...opportunity, attained: null, headMatches: true,
        reason: "Declared file match known; resolved task-description input unknown." };
    }
    return { ...opportunity, attained: row.taskDescriptionActual === contract.expectedTaskDescriptionLiteral, headMatches: true, reason: null };
  }
  const row = receipt.worker;
  if (!row || typeof row.headSha !== "string" || typeof row.expectedHeadSha !== "string") {
    return { ...opportunity, attained: null, headMatches: null, reason: "Invocation known; head identity unknown." };
  }
  const headMatches = row.headSha === row.expectedHeadSha && (!row.expectedRef || row.branch === row.expectedRef);
  if (!headMatches) return { ...opportunity, attained: false, headMatches: false, reason: null };
  const knownConjunction = typeof row.clean === "boolean" && typeof row.initialized === "boolean"
    && typeof row.originPresent === "boolean" && Number.isSafeInteger(row.visibleCommits);
  if (!knownConjunction) {
    return { ...opportunity, attained: null, headMatches: true,
      reason: "Head match known; complete clean/initialized/origin/history conjunction unknown." };
  }
  return { ...opportunity, attained: row.clean && row.initialized && row.originPresent && row.visibleCommits > 0, headMatches: true, reason: null };
}

export function scoreReusableCallMetric(primaryId, diagnosticId) {
  return function scoreMetric(id, evidence) {
    if (![primaryId, diagnosticId].includes(id) || evidence?.valid !== true
      || !Array.isArray(evidence.assessments) || !evidence.assessments.length
      || new Set(evidence.assessments.map((row) => row?.id)).size !== evidence.assessments.length
      || evidence.assessments.some((row) => typeof row?.id !== "string" || !row.id
        || ![true, false, null].includes(row.eligible)
        || ![true, false, null].includes(row.attained)
        || ![true, false, null].includes(row.headMatches)
        || (row.attained === true && row.headMatches !== true)
        || (row.eligible !== true && (row.attained !== null || row.headMatches !== null)))) return null;
    const field = id === primaryId ? "attained" : "headMatches";
    const eligible = evidence.assessments.filter((row) => row.eligible === true);
    if (!eligible.some((row) => typeof row[field] === "boolean")) return null;
    return eligible.filter((row) => row[field] === true).length;
  };
}

// --- Module factory -----------------------------------------------------------
export function reusableCallModule(role) {
  if (!["worker", "orchestrator"].includes(role)) throw new Error(`Unknown reusable-call role: ${role}`);
  const workflowId = roleWorkflowId[role];
  const contract = readCensusJson(`${directory}/contract.json`);
  if (contract.interpreterSha256 !== createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex")) {
    throw new Error("Frozen reusable-call interpreter changed");
  }
  const roleFacts = role === "worker" ? contract.worker : contract.orchestrator;
  const subDirectory = `${directory}/${workflowId}`;
  const primaryId = role === "worker" ? "verified-workflow-call-checkouts" : "verified-call-workflow-invocations";
  const diagnosticId = role === "worker" ? "verified-workflow-call-heads" : "verified-call-workflow-dispatches";
  const examples = (count) => ({
    valid: true,
    assessments: Array.from({ length: count }, (_, index) => ({
      id: String(index), eligible: true, attained: true, headMatches: true,
    })),
  });
  const scoreMetric = scoreReusableCallMetric(primaryId, diagnosticId);
  const definition = {
    schemaVersion: 3,
    slug: workflowId,
    repository,
    workflowName: role === "worker" ? "Smoke Workflow Call (workflow_call worker)" : "Smoke Call Workflow (call-workflow orchestrator)",
    sourcePath: roleFacts.sourcePath,
    intent: { goal: roleFacts.goal, acceptance: roleFacts.acceptance, temporalAnchor: "workflow-adoption" },
    adoption: roleFacts.adoption,
    evaluation: { mode: "attainment-only" },
    evidence: {
      key: role === "worker" ? "protected-workflow-call-checkout-conjunction-v1" : "protected-call-workflow-invocation-conjunction-v1",
      repositories: [repository],
      contractSha256: censusDigest(contract),
      sourceGitBlob: roleFacts.sourceGitBlob,
      sourceRevision: contract.sourceRevision,
      interpreterSha256: contract.interpreterSha256,
      opportunity: role === "worker"
        ? "Every orchestrator run (github/gh-aw smoke-call-workflow) whose call-workflow safe output independently dispatched the nested smoke-workflow-call job; runs with no observed dispatch are excluded as out-of-workflow_call-context, not scored as a failed checkout."
        : "Every policy-admitted smoke-call-workflow run (schedule cycle, manual/workflow_dispatch, centralized slash dispatch, and `water`-labeled pull_request triggers).",
      filters: [...contract.rejectedProxies.map((proxy) => `Not proof: ${proxy}`), ...contract.limitations],
      collection: role === "worker"
        ? "Offline replay of digest-checked orchestrator run inventory, bound nested-dispatch receipt, and protected pre-agent Git state captured inside the nested workflow_call job; absent receipts remain null."
        : "Offline replay of digest-checked orchestrator run inventory and bound call-workflow safe-output dispatch receipt (declared workflow file plus resolved task-description input); absent receipts remain null.",
      measurementKind: "interval",
      window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 },
    },
    model: {
      architecture: "Independent source-bound run/dispatch/checkout-state conjunction; worker and orchestrator read distinct bound fields of the same nested-job run, so each module measures a different native question from shared acquisition.",
      recommendation: "Do not rate value until authentic invocation/checkout receipts exist; preserve partial evidence independently rather than treating run success as proof.",
      presentation: {
        label: role === "worker" ? "Verified workflow_call checkout outcomes" : "Verified call-workflow invocation outcomes",
        betterLabel: role === "worker" ? "More independently verified workflow_call checkouts" : "More independently verified worker invocations",
      },
    },
    summary: { nativeLabel: role === "worker" ? "Verified workflow_call checkout outcomes" : "Verified call-workflow invocation outcomes" },
    metrics: [
      {
        id: primaryId,
        name: role === "worker" ? "Verified workflow_call checkouts" : "Verified call-workflow invocations",
        role: "primary",
        unit: role === "worker" ? "checkout proofs" : "invocation proofs",
        formula: role === "worker"
          ? "Count independently verified nested-job checkouts whose head/ref match the orchestrator-forwarded expectation and whose Git state is clean, initialized, origin-bound, with visible history."
          : "Count independently verified call-workflow dispatches whose nested job used the exact declared workflow file and whose resolved task-description input matches the source-declared literal.",
        direction: "increase",
        presentation: {
          name: role === "worker" ? "Verified workflow_call checkouts" : "Verified call-workflow invocations",
          legendLabel: role === "worker" ? "Verified checkouts" : "Verified invocations",
          transform: "identity",
        },
      },
      {
        id: diagnosticId,
        name: role === "worker" ? "Verified intended workflow_call heads" : "Verified intended worker dispatches",
        role: "diagnostic",
        unit: role === "worker" ? "head-match proofs" : "dispatch-match proofs",
        formula: role === "worker"
          ? "Count independent intended head/ref matches inside the nested job; does not assert a clean workspace."
          : "Count independent confirmations that the nested job used the exact declared smoke-workflow-call.lock.yml file; does not assert the task-description input matched.",
        direction: "increase",
        presentation: {
          name: role === "worker" ? "Verified intended workflow_call heads" : "Verified intended worker dispatches",
          legendLabel: role === "worker" ? "Verified intended heads" : "Verified dispatches",
          transform: "identity",
        },
      },
    ],
    validationExamples: {
      targetAttained: examples(2),
      targetMissed: examples(1),
      missing: { valid: false },
      malformed: { valid: true, assessments: [{ id: "invalid", eligible: true, attained: "PASS", headMatches: "PASS" }] },
    },
  };
  const collectBatch = (requests) => {
    const index = readCensusJson(`${subDirectory}/index.json`);
    const rows = readCensusJson(`${subDirectory}/observations.json.gz`);
    if (index.contractSha256 !== censusDigest(contract) || index.observationsSha256 !== censusDigest(rows)
      || rows.length !== index.inventoryRuns) {
      throw new Error("Reusable-call evidence inventory or frozen source integrity mismatch");
    }
    const assessContract = {
      calledWorkflowFile: contract.coupling.calledWorkflowFile,
      expectedTaskDescriptionLiteral: contract.coupling.expectedTaskDescriptionLiteral,
      orchestratorLockGitBlob: contract.orchestrator.lockGitBlob,
    };
    return requests.map((request) => {
      const start = Date.parse(request.windowStart), end = Date.parse(request.windowEnd);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start
        || !Number.isFinite(Date.parse(request.observedAt)) || (request.repository && request.repository !== repository)) {
        throw new Error("Invalid reusable-call observation request");
      }
      const selected = rows.filter((row) => Date.parse(row.createdAt) >= start && Date.parse(row.createdAt) < end);
      const assessments = selected.map((row) => ({
        id: `${row.runId}:1`,
        ...assessReusableCallReceipt(row.receipt, role, assessContract),
      }));
      const known = assessments.some((row) => row.attained !== null || row.headMatches !== null);
      const covered = request.windowStart >= roleFacts.adoption.adoptedAt && request.windowEnd <= contract.until;
      return {
        evidence: {
          valid: covered && known,
          assessments,
          inventoryRuns: selected.length,
          eligibleCount: assessments.every((row) => row.eligible !== null)
            ? assessments.filter((row) => row.eligible).length : null,
          unassessedEligibility: assessments.filter((row) => row.eligible === null).length,
          coverageStatus: covered && assessments.length && assessments.every((row) => row.eligible !== null
            && (row.eligible === false || row.attained !== null)) ? "complete" : "missing",
          missingReason: known ? null
            : `Actions run/job/log acquisition was blocked (${index.classification}); Actions run success is not independent invocation/checkout proof.`,
          costs: "not-measured", attribution: "not-measured", sourceCoverage: covered, limitations: contract.limitations,
        },
        provenance: [
          { repository, kind: "immutable-workflow-source", ref: roleFacts.sourceGitBlob },
          { repository, kind: role === "worker" ? "worker-run-inventory" : "orchestrator-run-inventory", ref: censusDigest(index) },
        ],
        commit: contract.sourceRevision,
      };
    });
  };
  return { definition, collectBatch, scoreMetric };
}

// --- Authoring (one-time contract.json bootstrap from immutable public git source) ------
export function authorReusableCallContract(cache) {
  const reader = publicGitSourceReader(cache, repository);
  const git = (args) => execFileSync("git", [`--git-dir=${cache}`, ...args], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60000,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" }, stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
  if (git(["rev-parse", "--is-shallow-repository"]) !== "false") throw new Error("Shallow adoption history");
  const dateOf = (commit) => new Date(git(["log", "-1", "--no-patch", "--format=%cI", commit])).toISOString().replace(".000Z", "Z");
  const adoptionOf = (sourcePath) => {
    const additions = git(["log", "--first-parent", "--diff-filter=A", "--format=%H", sourceRevision, "--", sourcePath]).split("\n").filter(Boolean);
    if (additions.length !== 1) throw new Error(`Ambiguous adoption for ${sourcePath}`);
    const commit = additions[0], baseline = git(["rev-parse", `${commit}^`]);
    if (git(["ls-tree", baseline, "--", sourcePath])) throw new Error(`Workflow already exists before adoption: ${sourcePath}`);
    return { commit, adoptedAt: dateOf(commit), baselineCommit: baseline, baselineAt: dateOf(baseline) };
  };
  const readBlob = (file) => {
    const row = reader.read(sourceRevision, file);
    if (!row) throw new Error(`Missing source: ${sourceRevision}:${file}`);
    return row;
  };
  const workerSource = readBlob(".github/workflows/smoke-workflow-call.md");
  const workerLock = readBlob(".github/workflows/smoke-workflow-call.lock.yml");
  const orchestratorSource = readBlob(".github/workflows/smoke-call-workflow.md");
  const orchestratorLock = readBlob(".github/workflows/smoke-call-workflow.lock.yml");
  if (workerSource.id !== "4c18d992aaa8ceee3bcc4b0a5bcb505d7a79758b") throw new Error("Assigned worker source changed");
  if (orchestratorSource.id !== "7e126368cd292d93519d66aa3a317c46db414a51") throw new Error("Assigned orchestrator source changed");
  if (workerLock.id !== "8a4ebdd786a55296e7d7f5beeb09cade276b4db9") throw new Error("Assigned worker lock changed");
  if (orchestratorLock.id !== "631f36c009524dfbf35a1244ad07f012e2343de0") throw new Error("Assigned orchestrator lock changed");
  // Verify the architecture facts the modules rely on directly from the
  // frozen compiled source, rather than trusting prose documentation.
  const lockText = orchestratorLock.bytes.toString("utf8");
  if (!lockText.includes("uses: ./.github/workflows/smoke-workflow-call.lock.yml")
    || !lockText.includes('\\"workflow_files\\":{\\"smoke-workflow-call\\":\\"./.github/workflows/smoke-workflow-call.lock.yml\\"')
    || !/task-description:\s*\$\{\{\s*fromJSON\(needs\.safe_outputs\.outputs\.call_workflow_payload\)\['task-description'\]\s*\}\}/.test(lockText)) {
    throw new Error("Orchestrator lock no longer matches the verified call-workflow fan-out architecture");
  }
  const orchestratorBody = orchestratorSource.bytes.toString("utf8");
  if (!orchestratorBody.includes('Pass `"smoke test checkout validation"` as the `task-description` input.')) {
    throw new Error("Orchestrator source no longer declares the expected task-description literal");
  }
  const workerBody = workerSource.bytes.toString("utf8");
  if (!workerBody.includes("default: validate workflow_call checkout") || !workerBody.includes("workflow_call:")) {
    throw new Error("Worker source no longer declares the expected workflow_call contract");
  }
  const workerAdoption = adoptionOf(".github/workflows/smoke-workflow-call.md");
  const orchestratorAdoption = adoptionOf(".github/workflows/smoke-call-workflow.md");
  const contract = {
    schemaVersion: 1,
    repository, repositoryId, sourceRevision, until,
    architecture: "call-workflow safe output compiles to a job (`call-smoke-workflow-call` in smoke-call-workflow.lock.yml) that runs `uses: ./.github/workflows/smoke-workflow-call.lock.yml` nested inside the SAME orchestrator run id (compile-time fan-out). The worker's own independent run list (schedule/workflow_dispatch only) never contains workflow_call-context executions; those are only observable as a nested job inside smoke-call-workflow's run history.",
    worker: {
      workflowId: workerWorkflowId,
      sourcePath: ".github/workflows/smoke-workflow-call.md",
      sourceGitBlob: workerSource.id,
      lockGitBlob: workerLock.id,
      adoption: workerAdoption,
      goal: "Validate PR branch checkout in reusable workflow_call context.",
      acceptance: "Independent checkout-state evidence matches the intended caller PR head and initialized Git state.",
      designLimitation: "Git commands working or a PASS comment cannot prove the intended PR was checked out.",
    },
    orchestrator: {
      workflowId: orchestratorWorkflowId,
      sourcePath: ".github/workflows/smoke-call-workflow.md",
      sourceGitBlob: orchestratorSource.id,
      lockGitBlob: orchestratorLock.id,
      adoption: orchestratorAdoption,
      goal: "Validate reusable-worker invocation and checkout through call-workflow.",
      acceptance: "Independent invocation and checkout evidence confirms the requested worker and task input reached the intended context.",
      designLimitation: "A dispatch safe output alone does not demonstrate correct worker checkout.",
    },
    coupling: {
      mechanism: "compile-time fan-out via the call-workflow safe output",
      workerEligibilityFloor: orchestratorAdoption.adoptedAt,
      workerEligibilityFloorReason: "Before the orchestrator existed, no workflow_call coupling to the worker was possible regardless of the worker's own earlier standalone adoption.",
      nestedJobName: "call-smoke-workflow-call",
      calledWorkflowFile: "./.github/workflows/smoke-workflow-call.lock.yml",
      expectedTaskDescriptionLiteral: "smoke test checkout validation",
    },
    rejectedProxies: [
      "a run concluding 'success'",
      "a PASS/FAIL comment footer written by the agent itself",
      "the call_workflow safe-output count alone (dispatch without confirmed destination/input match)",
      "the worker's own schedule/workflow_dispatch run history (never reflects workflow_call context)",
      "editable issue/PR body or comment text",
    ],
    limitations: [
      "Actions run/job/log-level evidence (run lists, job steps, and logs for both workflows) could not be acquired in this measurement environment; see acquisition below.",
      "Repository, commit, blob, and adoption facts above were independently verified via unauthenticated public git smart-HTTP clone plus SHA1 blob hashing, which remained reachable.",
      "Complete attribution and cost accounting remain not-measured.",
    ],
    acquisition: { attempts: [] },
  };
  mkdirSync(directory, { recursive: true });
  const serialized = { ...contract, interpreterSha256: createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex") };
  writeCensusJson(`${directory}/contract.json`, serialized);
  return serialized;
}

// --- Acquisition (attempts real Actions API evidence; records honest blocks) --
function probe(label, fn) {
  try {
    return { label, ok: true, detail: fn().toString("utf8").slice(0, 300) };
  } catch (error) {
    return { label, ok: false, detail: String(error.message ?? error).slice(0, 300) };
  }
}

export function collectReusableCallEvidence() {
  const contract = readCensusJson(`${directory}/contract.json`);
  const attempts = [
    probe("gh api repos/github/gh-aw", () => execFileSync("gh", ["api", `repos/${repository}`], { timeout: 20000, stdio: ["ignore", "pipe", "pipe"] })),
    probe(`gh api repos/github/gh-aw/actions/workflows/${orchestratorWorkflowId}.lock.yml/runs`, () => execFileSync("gh", [
      "api", `repos/${repository}/actions/workflows/${orchestratorWorkflowId}.lock.yml/runs`, "-f", "per_page=1",
    ], { timeout: 20000, stdio: ["ignore", "pipe", "pipe"] })),
    probe("curl https://api.github.com/repos/github/gh-aw", () => {
      const result = execFileSync("curl", [
        "-sS", "--fail", "--max-time", "20", `https://api.github.com/repos/${repository}`,
      ], { timeout: 25000, stdio: ["ignore", "pipe", "pipe"] });
      if (!(() => { try { return JSON.parse(result.toString("utf8"))?.full_name === repository; } catch { return false; } })()) {
        throw new Error(`Unexpected non-API response body: ${result.toString("utf8").slice(0, 200)}`);
      }
      return result;
    }),
  ];
  const acquired = attempts.some((attempt) => attempt.ok);
  const classification = acquired ? "acquired" : "blocked-acquisition";
  const acquisitionAttemptedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const acquisitionRecord = { attempts, acquisitionAttemptedAt, classification };
  const updatedContract = {
    ...contract,
    acquisition: { attempts: attempts.map(({ label, ok, detail }) => ({ label, ok, detail })), acquisitionAttemptedAt, classification },
  };
  writeCensusJson(`${directory}/contract.json`, updatedContract);
  for (const role of ["worker", "orchestrator"]) {
    const workflowId = roleWorkflowId[role];
    const subDirectory = `${directory}/${workflowId}`;
    mkdirSync(subDirectory, { recursive: true });
    // No genuine run/job/log evidence could be acquired (see `attempts`
    // above): the observation set stays empty rather than inventing rows.
    const rows = [];
    writeCensusJson(`${subDirectory}/observations.json.gz`, rows);
    const index = {
      schemaVersion: 1, repository, repositoryId, workflowId, role,
      contractSha256: censusDigest(updatedContract),
      observationsSha256: censusDigest(rows),
      inventoryRuns: rows.length,
      inventoryComplete: false,
      classification,
      acquisitionAttemptedAt,
      acquisitionAttempts: attempts.map(({ label, ok, detail }) => ({ label, ok, detail })),
    };
    writeCensusJson(`${subDirectory}/index.json`, index);
  }
  return acquisitionRecord;
}

// --- CLI ---------------------------------------------------------------------
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "author") {
    if (rest.length !== 1) throw new Error("usage: collect-reusable-call-value.mjs author BARE_CACHE");
    authorReusableCallContract(path.resolve(rest[0]));
    console.log(`Wrote ${directory}/contract.json`);
  } else if (mode === "collect") {
    const result = collectReusableCallEvidence();
    console.log(JSON.stringify({ classification: result.classification, attempts: result.attempts.length }, null, 2));
  } else {
    throw new Error("usage: collect-reusable-call-value.mjs <author BARE_CACHE|collect>");
  }
}
