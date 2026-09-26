import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runValidateActivityData } from "../../activity/commands/validate-activity-data.mjs";

const option = (options, name) => {
  const value = options[name];
  if (!value) throw new Error(`Missing required option --${name}`);
  return value;
};
const rejectUnknownOptions = (options, allowed) => {
  for (const name of Object.keys(options)) {
    if (!allowed.includes(name)) throw new Error(`Unknown option --${name}`);
  }
};

test("validates restored activity data and creates a fallback memory manifest", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cao-validate-activity-"));
  const shards = path.join(root, "gh-aw-logs-shards");
  const memoryManifest = path.join(root, "memory", "manifest.json");
  const files = {
    database: path.join(root, "gh-aw-logs.sqlite"),
    "payload-hashes": path.join(root, "payload-hashes.json"),
    "control-settings": path.join(root, "control-settings.json"),
    inventory: path.join(root, "inventory-sources.json"),
  };
  try {
    await mkdir(shards);
    writeFileSync(path.join(shards, "activity.jsonl"), "{}\n");
    for (const file of Object.values(files)) writeFileSync(file, "{}\n");

    const result = await runValidateActivityData({
      options: { ...files, "shard-dir": shards, "memory-manifest": memoryManifest },
      option,
      rejectUnknownOptions,
    });

    assert.deepEqual(result, { command: "validate-activity-data", files: 5, shards: 1 });
    assert.equal(existsSync(memoryManifest), true);
    assert.deepEqual(JSON.parse(readFileSync(memoryManifest, "utf8")).campaigns, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects missing, empty, and shardless restored activity data", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cao-validate-activity-invalid-"));
  const shards = path.join(root, "gh-aw-logs-shards");
  const memoryManifest = path.join(root, "memory", "manifest.json");
  try {
    await mkdir(shards);
    writeFileSync(path.join(root, "gh-aw-logs.sqlite"), "");
    writeFileSync(path.join(root, "payload-hashes.json"), "{}\n");
    writeFileSync(path.join(root, "control-settings.json"), "{}\n");

    await assert.rejects(runValidateActivityData({
      options: {
        database: path.join(root, "gh-aw-logs.sqlite"),
        "shard-dir": shards,
        "payload-hashes": path.join(root, "payload-hashes.json"),
        "control-settings": path.join(root, "control-settings.json"),
        inventory: path.join(root, "missing-inventory.json"),
        "memory-manifest": memoryManifest,
      },
      option,
      rejectUnknownOptions,
    }), /Restored activity data validation failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
