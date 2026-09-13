import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { downloadDeployedDashboardData } from "../e2e/dashboard-view-data.mjs";

test("downloads canonical deployed dashboard inputs", async () => {
  const destination = await mkdtemp(join(tmpdir(), "dashboard-view-data-"));
  const requested = [];
  const fetcher = async (url) => {
    requested.push(String(url));
    const content = String(url).endsWith(".jsonl") ? '{"kind":"run"}\n' : '{"repositories":[]}';
    return {
      ok: true,
      body: new Blob([content]).stream(),
      text: async () => {
        throw new Error("response must be streamed");
      },
    };
  };

  try {
    await downloadDeployedDashboardData(
      destination,
      "https://example.test/cao/gh-aw-logs.jsonl",
      fetcher,
    );

    assert.deepEqual(requested, [
      "https://example.test/cao/gh-aw-logs.jsonl",
      "https://example.test/cao/inventory-sources.json",
    ]);
    assert.equal(await readFile(join(destination, "gh-aw-logs.jsonl"), "utf8"), '{"kind":"run"}\n');
    assert.equal(
      await readFile(join(destination, "inventory-sources.json"), "utf8"),
      '{"repositories":[]}',
    );
  } finally {
    await rm(destination, { recursive: true });
  }
});
