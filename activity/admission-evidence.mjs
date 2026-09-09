import { spawnSync } from "node:child_process";

const CHECK_STATUSES = new Set(["passed", "failed", "not-evaluated"]);
const MAX_RECORD_BYTES = 128 * 1024;

function text(value, maximum = 256) {
  return typeof value === "string" && value.length <= maximum ? value : null;
}

function capacity(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(
    fields.flatMap((field) => {
      const current = value[field];
      if (typeof current === "boolean" || (typeof current === "number" && Number.isFinite(current))) return [[field, current]];
      const normalized = text(current);
      return normalized === null ? [] : [[field, normalized]];
    }),
  );
}

export function normalizeAdmissionRecord(value, expected = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema_version !== 1) return null;
  const repository = text(value.repository);
  const runId = text(value.run_id, 32);
  const runAttempt = Number(value.run_attempt);
  if (
    !repository ||
    !/^[^/\s]+\/[^/\s]+$/.test(repository) ||
    !/^\d+$/.test(runId || "") ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1 ||
    (expected.repository !== undefined && repository.toLowerCase() !== expected.repository.toLowerCase()) ||
    (expected.runId !== undefined && runId !== String(expected.runId)) ||
    (expected.runAttempt !== undefined && runAttempt !== Number(expected.runAttempt)) ||
    typeof value.authorized !== "boolean" ||
    !Array.isArray(value.checks) ||
    value.checks.length === 0 ||
    value.checks.length > 32
  )
    return null;
  const checks = value.checks.map((entry) => ({
    check: text(entry?.check),
    status: text(entry?.status),
  }));
  if (checks.some(({ check, status }) => !check || !CHECK_STATUSES.has(status))) return null;
  const observedAt = text(value.observed_at, 64);
  if (!Number.isFinite(Date.parse(observedAt || ""))) return null;
  const githubApiCapacity = capacity(value.github_api_capacity, ["status", "limit", "remaining", "required", "resetAt", "gateActive"]);
  return {
    schemaVersion: 1,
    observedAt,
    repository,
    workflow: text(value.workflow) || "",
    workflowSha: text(value.workflow_sha, 64) || "",
    runId,
    runAttempt,
    package: text(value.package) || "",
    role: text(value.role, 32) || "",
    worker: text(value.worker) || "",
    targetRepository: text(value.target_repository) || "",
    authorized: value.authorized,
    reason: text(value.reason) || "unknown",
    failedCheck: value.failed_check === null ? null : text(value.failed_check),
    checks,
    ...(githubApiCapacity ? { githubApiCapacity } : {}),
  };
}

export function admissionRecordFromArchive(archivePath, expected = {}) {
  const result = spawnSync("unzip", ["-p", archivePath, "admission.json"], {
    encoding: "utf8",
    maxBuffer: MAX_RECORD_BYTES,
    timeout: 10_000,
  });
  if (result.error || result.status !== 0 || !result.stdout || Buffer.byteLength(result.stdout) >= MAX_RECORD_BYTES) return null;
  try {
    return normalizeAdmissionRecord(JSON.parse(result.stdout), expected);
  } catch {
    return null;
  }
}
