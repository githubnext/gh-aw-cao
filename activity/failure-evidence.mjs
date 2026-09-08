const FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);
const API_LIMITED_STEP_PREFIX = "CAO admission blocked: GitHub API limited until ";
const API_UNAVAILABLE_STEP = "CAO admission blocked: GitHub API capacity unavailable";
const CAO_FAILURE_MARKER = "[CAO failure] ";
const MISSING_TARGET_AUTHORITY = "live mode requires .github/workflows/cao.json on the target default branch";
const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/g;

export function isFailedConclusion(value) {
  return FAILURE_CONCLUSIONS.has(String(value ?? ""));
}

export function runFailureEvidence(jobs, now = Date.now()) {
  const failedJob = jobs.find((job) => isFailedConclusion(job.conclusion));
  const failedStep = failedJob?.steps?.find((step) => isFailedConclusion(step.conclusion));
  let admission = {};
  for (const step of jobs.flatMap((job) => job.steps || [])) {
    if (step.conclusion !== "failure") continue;
    if (step.name === API_UNAVAILABLE_STEP) {
      admission = {
        admissionStatus: "resource-limited",
        admissionReason: "github-api-capacity-unavailable",
        resource: "github-rest-api",
      };
      break;
    }

    if (!step.name.startsWith(API_LIMITED_STEP_PREFIX)) continue;
    const resetTime = Date.parse(step.name.slice(API_LIMITED_STEP_PREFIX.length).trim());
    admission = {
      admissionStatus: "resource-limited",
      admissionReason: "github-api-capacity-insufficient",
      resource: "github-rest-api",
      ...(Number.isFinite(resetTime) ? {
        resourceResetAt: new Date(resetTime).toISOString(),
        resourceWaitHours: Math.ceil(Math.max(0, resetTime - now) / 36_000) / 100,
      } : {}),
    };
    break;
  }
  return {
    ...admission,
    failureJobId: failedJob?.id ?? null,
    ...(failedJob?.name ? { failureJob: String(failedJob.name) } : {}),
    ...(failedStep?.name ? { failureStep: String(failedStep.name) } : {}),
  };
}

export function performanceJobRecord(job) {
  const labels = Array.isArray(job?.labels)
    ? job.labels.filter((label) => typeof label === "string" && label.trim()).map((label) => label.trim())
    : [];
  return {
    jobId: job?.id ?? job?.jobId ?? null,
    name: String(job?.name || "Unknown job"),
    status: String(job?.status || "unknown"),
    conclusion: job?.conclusion == null ? null : String(job.conclusion),
    startedAt: job?.started_at || job?.startedAt || null,
    completedAt: job?.completed_at || job?.completedAt || null,
    runnerName: job?.runner_name || job?.runnerName || null,
    runnerGroupName: job?.runner_group_name || job?.runnerGroupName || null,
    labels,
  };
}

function normalizeCaoFailureMessage(message) {
  if (!message || message.length > 240 || /[\r\n]/.test(message)) return "";
  if (message === MISSING_TARGET_AUTHORITY) {
    return "Target authority missing: add .github/workflows/cao.json to the target default branch for live mode";
  }
  return `${message[0].toUpperCase()}${message.slice(1)}`;
}

export function extractCaoFailureMessage(logText) {
  const log = String(logText ?? "").replace(ANSI_ESCAPE, "");
  for (const line of log.split(/\r?\n/)) {
    const marker = line.indexOf(CAO_FAILURE_MARKER);
    if (marker >= 0) {
      return normalizeCaoFailureMessage(line.slice(marker + CAO_FAILURE_MARKER.length).trim());
    }
  }
  return log.includes(MISSING_TARGET_AUTHORITY)
    ? normalizeCaoFailureMessage(MISSING_TARGET_AUTHORITY)
    : "";
}