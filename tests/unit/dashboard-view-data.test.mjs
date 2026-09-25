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
    const content = String(url).endsWith(".jsonl")
      ? '{"kind":"run"}\n'
      : String(url).endsWith("payload-hashes.json")
        ? `{"gh-aw-logs-runs/fixture.jsonl":"${"a".repeat(64)}"}`
        : '{"repositories":[]}';
    return {
      ok: true,
      body: new Blob([content]).stream(),
      text: async () => {
        throw new Error("response must be streamed");
      },
      json: async () => JSON.parse(content),
    };
  };

  try {
    await downloadDeployedDashboardData(
      destination,
      "https://example.test/cao/payload-hashes.json",
      fetcher,
    );

    assert.deepEqual(requested, [
      "https://example.test/cao/payload-hashes.json",
      "https://example.test/cao/inventory-sources.json",
      "https://example.test/cao/gh-aw-logs-runs/fixture.jsonl",
    ]);
    assert.equal(await readFile(join(destination, "gh-aw-logs-runs", "fixture.jsonl"), "utf8"), '{"kind":"run"}\n');
    assert.equal(
      await readFile(join(destination, "inventory-sources.json"), "utf8"),
      '{"repositories":[]}',
    );
  } finally {
    await rm(destination, { recursive: true });
  }
});

test("limits the downloaded activity shards when requested", async () => {
  const destination = await mkdtemp(join(tmpdir(), "dashboard-view-data-"));
  const requested = [];
  const fetcher = async (url) => {
    requested.push(String(url));
    const content = String(url).endsWith("payload-hashes.json")
      ? JSON.stringify({
          "gh-aw-logs-runs/first.jsonl": "a".repeat(64),
          "gh-aw-logs-records/second.jsonl": "b".repeat(64),
        })
      : String(url).endsWith("inventory-sources.json")
        ? '{"repositories":[]}'
        : '{"kind":"record"}\n';
    return {
      ok: true,
      body: new Blob([content]).stream(),
      json: async () => JSON.parse(content),
    };
  };

  try {
    await downloadDeployedDashboardData(
      destination,
      "https://example.test/cao/payload-hashes.json",
      fetcher,
      1,
    );

    assert.deepEqual(requested, [
      "https://example.test/cao/payload-hashes.json",
      "https://example.test/cao/inventory-sources.json",
      "https://example.test/cao/gh-aw-logs-runs/first.jsonl",
    ]);
  } finally {
    await rm(destination, { recursive: true });
  }
});

test("waits for both deployed dashboard downloads when one fails", async () => {
  const destination = await mkdtemp(join(tmpdir(), "dashboard-view-data-"));
  let inventoryFinished = false;
  const fetcher = async (url) => ({
    ok: true,
    body: String(url).endsWith("inventory-sources.json")
      ? new ReadableStream({
          async start(controller) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            controller.enqueue(new TextEncoder().encode('{"repositories":[]}'));
            controller.close();
            inventoryFinished = true;
          },
        })
      : new ReadableStream({
          start(controller) {
            controller.error(new Error("activity download failed"));
          },
        }),
    json: async () => ({ "gh-aw-logs-runs/fixture.jsonl": "a".repeat(64) }),
  });

  try {
    await assert.rejects(
      downloadDeployedDashboardData(
        destination,
        "https://example.test/cao/payload-hashes.json",
        fetcher,
      ),
      /activity download failed/,
    );
    assert.equal(inventoryFinished, true);
  } finally {
    await rm(destination, { recursive: true });
  }
});
