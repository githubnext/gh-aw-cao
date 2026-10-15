import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareDashboardServerFixture } from "../e2e/dashboard-server-fixture.mjs";

test("server browser fixtures retain linked evidence without weakening retention", () => {
  const directory = mkdtempSync(join(tmpdir(), "dashboard-server-fixture-"));
  const source = new URL("../../server/testdata/deployed-subset/", import.meta.url);
  const original = readFileSync(new URL("payload-hashes.json", source), "utf8");
  try {
    const now = Date.parse("2030-06-15T12:00:00Z");
    prepareDashboardServerFixture(directory, now);
    const manifest = JSON.parse(readFileSync(join(directory, "payload-hashes.json"), "utf8"));
    const records = [];
    for (const [name, hash] of Object.entries(manifest)) {
      const content = readFileSync(join(directory, name), "utf8");
      assert.equal(createHash("sha256").update(content).digest("hex"), hash);
      const before = readFileSync(new URL(name, source), "utf8").trim().split("\n").map(JSON.parse);
      const after = content.trim().split("\n").map(JSON.parse);
      assert.equal(after.length, before.length);
      for (let i = 1; i < after.length; i++) {
        assert.equal(after[i].record.id, before[i].record.id);
        if (after[i].record.runId) assert.equal(after[i].record.runId, before[i].record.runId);
        records.push(after[i].record);
      }
    }
    assert.equal(records.length, 8);
    for (const record of records.filter((record) => record.timestamp)) {
      const age = now - Date.parse(record.timestamp);
      assert.ok(age >= 86_400_000 && age < 2 * 86_400_000);
    }
    assert.equal(readFileSync(new URL("payload-hashes.json", source), "utf8"), original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
