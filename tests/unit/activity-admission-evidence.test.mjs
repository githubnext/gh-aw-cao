import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAdmissionRecord } from "../../activity/admission-evidence.mjs";

const record = {
  schema_version: 1,
  observed_at: "2026-09-05T10:00:00.000Z",
  repository: "acme/control",
  workflow: "Dependabot",
  workflow_sha: "1111111111111111111111111111111111111111",
  run_id: "42",
  run_attempt: 1,
  package: "dependabot",
  role: "orchestrator",
  worker: "",
  target_repository: "",
  authorized: false,
  reason: "package-disabled",
  failed_check: "Package",
  checks: [
    { check: "Runtime revision", status: "passed" },
    { check: "Package", status: "failed" },
    { check: "Worker", status: "not-evaluated" },
  ],
};

test("admission evidence validates and normalizes a matching structured record", () => {
  assert.deepEqual(
    normalizeAdmissionRecord(record, {
      repository: "acme/control",
      runId: 42,
      runAttempt: 1,
    }),
    {
      schemaVersion: 1,
      observedAt: "2026-09-05T10:00:00.000Z",
      repository: "acme/control",
      workflow: "Dependabot",
      workflowSha: "1111111111111111111111111111111111111111",
      runId: "42",
      runAttempt: 1,
      package: "dependabot",
      role: "orchestrator",
      worker: "",
      targetRepository: "",
      authorized: false,
      reason: "package-disabled",
      failedCheck: "Package",
      checks: [
        { check: "Runtime revision", status: "passed" },
        { check: "Package", status: "failed" },
        { check: "Worker", status: "not-evaluated" },
      ],
    },
  );
});

test("admission evidence rejects mismatched provenance and unsupported check states", () => {
  assert.equal(normalizeAdmissionRecord(record, { runId: 43 }), null);
  assert.equal(normalizeAdmissionRecord(record, { runId: 0 }), null);
  assert.equal(
    normalizeAdmissionRecord({
      ...record,
      checks: [{ check: "Package", status: "maybe" }],
    }),
    null,
  );
});
