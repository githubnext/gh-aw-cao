import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const positive = value => Number.isSafeInteger(value) && value > 0;
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const validTime = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
export const choiceEnvironments = ["staging", "production"];
export const choiceTestTypes = ["smoke", "integration", "e2e"];
export function projectChoicePayload(value) {
  if (!value || !Array.isArray(value.items) || value.items.length !== 1) return null;
  const item = value.items[0];
  if (item?.type !== "test_environment" || !choiceEnvironments.includes(item.environment)
    || !choiceTestTypes.includes(item.test_type)) return null;
  return { environment: item.environment, testType: item.test_type };
}

export function expectedWeekdayChoice(at) {
  if (!validTime(at)) return null;
  const day = new Date(at).getUTCDay();
  if ([1, 3, 5].includes(day)) return { environment: "staging", testType: "smoke" };
  if ([2, 4].includes(day)) return { environment: "production", testType: "integration" };
  return null;
}

function successfulStep(step, until) {
  return positive(step?.number) && step.status === "completed" && step.conclusion === "success"
    && validTime(step.started_at) && validTime(step.completed_at)
    && Date.parse(step.completed_at) >= Date.parse(step.started_at) && step.completed_at < until;
}

export function assessChoiceReceipt(row, contract) {
  if (!positive(row?.run?.id) || !validTime(row.run.createdAt)) return { status: "unknown", reason: "Invalid initial-run identity." };
  const expected = expectedWeekdayChoice(row.run.createdAt);
  if (!expected) return { status: "ineligible", reason: "The source declares no weekend selection rule." };
  const { source, artifacts, host } = row;
  if (row.run.attempt !== 1 || row.run.repositoryId !== 1036865607
    || !["schedule", "workflow_dispatch"].includes(row.run.event)
    || row.run.path !== contract.compiledPath || !/^[a-f0-9]{40}$/.test(row.run.headSha)
    || source?.headSha !== row.run.headSha || row.run.createdAt >= contract.until
    || source?.taskSha256 !== contract.taskSha256 || source?.jobSha256 !== contract.jobSha256
    || !/^[a-f0-9]{40}$/.test(source?.sourceGitBlob) || !/^[a-f0-9]{40}$/.test(source?.compiledGitBlob)) {
    return { status: "unknown", reason: row.reason ?? "No reviewed same-repository initial-attempt source profile." };
  }
  if (!Array.isArray(artifacts) || artifacts.length !== 2
    || new Set(artifacts.map(item => item?.name)).size !== 2
    || new Set(artifacts.map(item => item?.id)).size !== 2
    || !artifacts.every(item => ["agent", "agent-output-fallback"].includes(item.name) && positive(item.id)
      && digest(item.archiveSha256) && item.providerDigest === `sha256:${item.archiveSha256}`
      && item.runId === row.run.id && item.headSha === row.run.headSha && item.jobName === "agent"
      && digest(item.payloadSha256) && positive(item.jobId) && successfulStep(item.uploadStep, contract.until)
      && item.uploadStep.name === (item.name === "agent" ? "Upload agent artifacts" : "Upload agent output fallback artifact")
      && validTime(item.createdAt) && Date.parse(item.createdAt) >= Date.parse(item.uploadStep.started_at)
      && Date.parse(item.createdAt) < Date.parse(item.uploadStep.completed_at) + 1000
      && choiceEnvironments.includes(item.selection?.environment) && choiceTestTypes.includes(item.selection?.testType))) {
    return { status: "unknown", reason: row.reason ?? "Two source-bound immutable artifact payloads and upload receipts are required." };
  }
  if (artifacts[0].jobId !== artifacts[1].jobId
    || censusDigest(artifacts[0].selection) !== censusDigest(artifacts[1].selection)) {
    return { status: "unknown", reason: "Merged artifact payloads disagree or do not share the source agent job." };
  }
  if (!positive(host?.jobId) || host.jobId === artifacts[0].jobId
    || host.jobName !== "test_environment" || host.step?.name !== "Display Test Config"
    || !successfulStep(host.step, contract.until)
    || !(typeof host.entry === "string" && (/^test_environment\/\d+_Display Test Config\.txt$/.test(host.entry)
      || /^\d+_test_environment\.txt$/.test(host.entry)))
    || !digest(host.archiveSha256) || !digest(host.hostLogSha256) || typeof host.line !== "string") {
    return { status: "unknown", reason: row.reason ?? "No source-bound protected custom-job readback." };
  }
  const match = host.line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) Test would be executed on (staging|production) environment with (smoke|integration|e2e) tests$/);
  if (!match || !validTime(match[1]) || Date.parse(match[1]) < Date.parse(host.step.started_at)
    || Date.parse(match[1]) >= Date.parse(host.step.completed_at) + 1000
    || match[2] !== artifacts[0].selection.environment || match[3] !== artifacts[0].selection.testType) {
    return { status: "unknown", reason: "Protected readback does not uniquely match the retained artifact selection." };
  }
  const anchors = [row.run.createdAt, ...artifacts.map(item => item.createdAt), host.step.started_at, host.step.completed_at];
  const utcDates = anchors.map(at => new Date(at).toISOString().slice(0, 10));
  const projectDates = anchors.map(at => new Date(Date.parse(at) - 8 * 3600000).toISOString().slice(0, 10));
  if (new Set([...utcDates, ...projectDates]).size !== 1
    || artifacts.some(item => Date.parse(item.uploadStep.completed_at) > Date.parse(host.step.started_at))) {
    return { status: "unknown", reason: "Selection day or producer/consumer ordering is ambiguous." };
  }
  return { status: "assessed", correct: censusDigest(expected) === censusDigest(artifacts[0].selection),
    at: host.step.completed_at };
}

export function scanChoiceEvidence(evidence, contract) {
  if (evidence?.valid !== true || !Array.isArray(evidence.observations)
    || new Set(evidence.observations.map(row => row?.run?.id)).size !== evidence.observations.length) return null;
  const assessments = evidence.observations.map(row => assessChoiceReceipt(row, contract));
  const eligible = assessments.filter(row => row.status !== "ineligible").length;
  const known = assessments.filter(row => row.status === "assessed");
  return { "correct-configurations": known.length || !eligible ? known.filter(row => row.correct).length : null,
    "assessed-configurations": known.length, "unassessed-opportunities": eligible - known.length, eligible };
}

export function scoreChoiceMetric(id, evidence, contract) {
  if (!["correct-configurations", "unassessed-opportunities"].includes(id)) throw new Error("Unknown native choice metric");
  return scanChoiceEvidence(evidence, contract)?.[id] ?? null;
}

export function nativeChoiceModule(contract) {
  if (contract.interpreterSha256 !== hash(readFileSync(import.meta.filename))) throw new Error("Frozen native choice interpreter changed");
  const step = (number, start, end) => ({ number, status: "completed", conclusion: "success",
    started_at: `2026-10-16T11:${start}:00Z`, completed_at: `2026-10-16T11:${end}:00Z` });
  const fixture = correct => {
    const selection = correct ? { environment: "staging", testType: "smoke" } : { environment: "production", testType: "integration" };
    return { valid: true, observations: [{ run: { id: 1, attempt: 1, repositoryId: 1036865607, event: "schedule",
      path: contract.compiledPath, headSha: "a".repeat(40), createdAt: "2026-10-16T11:19:00Z" },
    source: { headSha: "a".repeat(40), taskSha256: contract.taskSha256, jobSha256: contract.jobSha256, sourceGitBlob: "a".repeat(40), compiledGitBlob: "b".repeat(40) },
    artifacts: ["agent", "agent-output-fallback"].map((name, i) => ({ id: i + 1, name, selection, jobId: 2,
      runId: 1, headSha: "a".repeat(40), jobName: "agent",
      archiveSha256: "c".repeat(64), providerDigest: `sha256:${"c".repeat(64)}`, payloadSha256: "d".repeat(64),
      createdAt: "2026-10-16T11:21:30Z", uploadStep: { ...step(i + 1, "21", "22"),
        name: name === "agent" ? "Upload agent artifacts" : "Upload agent output fallback artifact" } })),
    host: { jobId: 3, jobName: "test_environment", entry: "5_test_environment.txt",
      step: { ...step(3, "23", "24"), name: "Display Test Config" }, archiveSha256: "e".repeat(64), hostLogSha256: "f".repeat(64),
      line: `2026-10-16T11:23:30Z Test would be executed on ${selection.environment} environment with ${selection.testType} tests` } }] };
  };
  const metric = (id, role, name, label, formula) => ({ id, role, name, formula, unit: "configurations", direction: "increase",
    presentation: { name, legendLabel: label, transform: "identity" } });
  const missed = fixture(false);
  missed.observations.push({ run: { id: 2, createdAt: "2026-10-15T11:19:00Z" } });
  return { definition: { schemaVersion: 3, slug: contract.workflowId, repository: contract.repository,
    workflowName: "Daily Choice Type Test", sourcePath: contract.sourcePath,
    intent: { goal: "Deliver the source's weekday-specific safe-output test configuration.",
      acceptance: "Two immutable initial-attempt artifact payloads agree on one allowed configuration, and the exact protected custom job reads it back. Monday/Wednesday/Friday requires staging/smoke; Tuesday/Thursday requires production/integration. UTC and source project day must agree.",
      temporalAnchor: "workflow-adoption" },
    adoption: contract.adoption, evaluation: { mode: "attainment-only" },
    evidence: { key: "native-weekday-choice-deliveries-v1", repositories: [contract.repository],
      sourcePolicySha256: censusDigest(contract), opportunity: "Initial same-repository scheduled/manual weekday runs before the frozen cutoff.",
      filters: ["A successful run or custom job alone is not a correct configuration.",
        "Retain single-item allowed argument projections, whole payload/archive hashes and source-bound upload/readback receipts; no agent prose.",
        "Both merged artifact names must survive with agreeing selections and provider-matching archive digests.",
        "Reruns, unreviewed sources, ambiguous dates, missing/expired receipts and payload disagreements remain unassessed.",
        "Count one verified configuration per initial execution, at protected readback completion; unassessed opportunities retain creation-time coverage.",
        "Weekend dispatches have no declared rule and are ineligible, not failures.",
        "This proves delivered configuration, not deployment/test execution, invalid-choice rejection, exclusive model authorship or costs."],
      collection: "Exhaustive bounded date-sliced run inventory plus normalized immutable artifact and protected host receipts.",
      measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Independent expected weekday function joined to source-bound artifact arguments and native host readback.",
      recommendation: "Inspect verified deliveries and unassessed opportunity counts separately.",
      presentation: { label: "Verified weekday-choice configurations", betterLabel: "More correctly delivered configurations" } },
    summary: { nativeLabel: "Verified correct weekday configurations" },
    metrics: [
      { ...metric("correct-configurations", "primary", "Verified correct weekday configurations", "Correct configurations",
        "Count source-bound initial execution receipts whose delivered configuration matches the deterministic weekday rule.") },
      { ...metric("unassessed-opportunities", "diagnostic", "Unassessed weekday opportunities", "Unassessed opportunities",
        "Eligible initial weekday executions without a complete independent configuration receipt."), direction: "decrease" },
    ],
    validationExamples: { targetAttained: fixture(true),
      targetMissed: missed,
      missing: { valid: false }, malformed: { valid: true, observations: "unknown" } } },
  scoreMetric(id, evidence) { return scoreChoiceMetric(id, evidence, contract); },
  collectBatch(requests) {
    const index = readCensusJson(`${contract.directory}/index.json`);
    const facts = readCensusJson(`${contract.directory}/facts.json.gz`);
    if (!index.complete || index.contractSha256 !== censusDigest(contract) || index.factsSha256 !== censusDigest(facts)) {
      throw new Error("Native choice evidence changed");
    }
    return requests.map(request => {
      if (request.repository && request.repository !== contract.repository) throw new Error("Native choice repository mismatch");
      const observations = facts.observations.filter(row => {
        const assessment = assessChoiceReceipt(row, contract);
        const at = assessment.at ?? row.run.createdAt;
        return at >= request.windowStart && at < request.windowEnd;
      });
      const evidence = { valid: true, observations }, scan = scanChoiceEvidence(evidence, contract);
      return { evidence: { ...evidence, coverageStatus: scan["unassessed-opportunities"] ? "partial" : "complete",
        maturityStatus: "matured", eligibleCount: scan.eligible, fullGoalAcceptance: "not-measured",
        deploymentExecution: "not-measured", invalidChoiceRejection: "not-measured", costs: "not-measured" },
      provenance: [{ repository: contract.repository, kind: "native-choice-index", ref: censusDigest(index) }],
      commit: contract.sourceRevision };
    });
  } };
}
