import assert from "node:assert/strict";
import test from "node:test";
import {
  hasOperationalValueResult,
  operationalValueRecordTime,
} from "../../dashboard/report/operational-value-records.mjs";

test("operational-value record detection accepts native and legacy results only", () => {
  assert.equal(hasOperationalValueResult({ resultAvailable: true, metrics: [] }), true);
  assert.equal(hasOperationalValueResult({ resultAvailable: true }), false);
  assert.equal(hasOperationalValueResult({ observation: { evidenceAt: "2026-09-01T00:00:00Z" } }), true);
  assert.equal(hasOperationalValueResult({ resultAvailable: false, observation: { evidenceAt: "2026-09-01T00:00:00Z" } }), false);
  assert.equal(hasOperationalValueResult({ resultAvailable: false, observation: null }), false);
  assert.equal(hasOperationalValueResult({ observation: [] }), false);
  assert.equal(hasOperationalValueResult({ evaluatorDigest: "legacy-digest" }), false);
});

test("operational-value record time prefers native observed time, then legacy evidence time", () => {
  assert.equal(operationalValueRecordTime({
    observedAt: "2026-09-02T00:00:00Z",
    observation: { evidenceAt: "2026-09-01T00:00:00Z" },
    run: { createdAt: "2026-08-31T00:00:00Z" },
  }), "2026-09-02T00:00:00Z");
  assert.equal(operationalValueRecordTime({
    observation: { evidenceAt: "2026-09-01T00:00:00Z" },
    run: { createdAt: "2026-08-31T00:00:00Z" },
  }), "2026-09-01T00:00:00Z");
});
