import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { actionsLog } from "../actions-log.mjs";

function formatFileSize(bytes) {
  const units = ["bytes", "KiB", "MiB", "GiB"];
  const unitIndex = bytes === 0
    ? 0
    : Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${unitIndex === 0 ? value : value.toFixed(1)} ${units[unitIndex]}`;
}

export async function runValidateActivityData({
  options,
  option,
  rejectUnknownOptions,
}) {
  const optionNames = ["database", "shard-dir", "payload-hashes", "control-settings", "inventory", "memory-manifest"];
  rejectUnknownOptions(options, optionNames);
  const requiredPath = (name) => path.resolve(option(options, name));
  const shardDirectory = requiredPath("shard-dir");
  const memoryManifest = requiredPath("memory-manifest");
  const activityFiles = [
    requiredPath("database"),
    requiredPath("payload-hashes"),
    requiredPath("control-settings"),
    requiredPath("inventory"),
    memoryManifest,
  ];

  if (!existsSync(memoryManifest)) {
    // Older activity caches predate repository-memory publication. Preserve
    // compatibility only when the file is absent; an existing manifest must
    // still pass validation below.
    await mkdir(path.dirname(memoryManifest), { recursive: true });
    await writeFile(memoryManifest, `${JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      campaigns: [],
    }, null, 2)}\n`);
  }

  actionsLog.info`Validating restored activity data`;
  let validationFailed = false;
  for (const activityFile of activityFiles) {
    const fileName = path.basename(activityFile);
    if (!existsSync(activityFile)) {
      actionsLog.error`Required activity data file is missing: ${fileName}`;
      validationFailed = true;
      continue;
    }
    const { size } = await stat(activityFile);
    if (size === 0) {
      actionsLog.error`Required activity data file is empty: ${fileName}`;
      validationFailed = true;
    } else if (activityFile === memoryManifest) {
      try {
        const manifest = JSON.parse(await readFile(memoryManifest, "utf8"));
        if (manifest?.version !== 1 || !Array.isArray(manifest.campaigns)) {
          throw new Error("invalid repository-memory manifest");
        }
        actionsLog.info`Validated ${fileName} (${formatFileSize(size)})`;
      } catch {
        actionsLog.error`Required activity data file is invalid: ${fileName}`;
        validationFailed = true;
      }
    } else {
      actionsLog.info`Validated ${fileName} (${formatFileSize(size)})`;
    }
  }

  const shardFiles = existsSync(shardDirectory)
    ? (await readdir(shardDirectory)).filter((name) => name.endsWith(".jsonl"))
    : [];
  if (shardFiles.length === 0) {
    actionsLog.error`Required activity shard directory is empty`;
    validationFailed = true;
  }

  if (validationFailed) {
    const activityRoot = path.dirname(shardDirectory);
    actionsLog.info`Restored activity cache directory contents:`;
    if (existsSync(activityRoot)) {
      const restoredFiles = (await readdir(activityRoot, { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .toSorted((left, right) => left.name.localeCompare(right.name));
      for (const entry of restoredFiles) {
        actionsLog.info`  ${entry.name} (${formatFileSize((await stat(path.join(activityRoot, entry.name))).size)})`;
      }
    }
    throw new Error("Restored activity data validation failed");
  }

  actionsLog.info`Restored activity data validation completed (${activityFiles.length} files)`;
  return { command: "validate-activity-data", files: activityFiles.length, shards: shardFiles.length };
}
