import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { validateDashboardDocument, validateLogicalSources } from "../src/validator.js";

const corpusDirectory = resolve(
  process.cwd(),
  process.argv[2] || "../../.github/skills/generate-dashboard-ir/corpus",
);
const examplesDirectory = resolve(corpusDirectory, "examples");
const index = JSON.parse(await readFile(resolve(corpusDirectory, "index.json"), "utf8"));

assert.equal(index.schemaVersion, 1, "corpus index must use schemaVersion 1");
assert.ok(Array.isArray(index.examples), "corpus examples must be an array");

const ids = index.examples.map((entry) => entry.id);
assert.deepEqual(ids, [...ids].sort(), "corpus index must be sorted by id");
assert.equal(new Set(ids).size, ids.length, "corpus example ids must be unique");

const referencedFiles = new Set(["index.json"]);
for (const entry of index.examples) {
  assert.match(entry.id, /^[a-z][a-z0-9-]*$/, `invalid corpus id: ${entry.id}`);
  assert.equal(entry.metadata, `examples/${entry.id}.json`, `${entry.id}: metadata path must match id`);
  assert.equal(
    entry.dashboard,
    `examples/${entry.id}.dashboard.yml`,
    `${entry.id}: dashboard path must match id`,
  );

  const metadata = JSON.parse(await readFile(resolve(corpusDirectory, entry.metadata), "utf8"));
  assert.equal(metadata.schemaVersion, 1, `${entry.id}: metadata must use schemaVersion 1`);
  assert.equal(metadata.id, entry.id, `${entry.id}: metadata id mismatch`);
  assert.ok(metadata.task?.intent, `${entry.id}: task intent is required`);
  for (const field of [
    "activationConditions",
    "requiredEffects",
    "noopConditions",
    "successConditions",
    "uncertainties",
  ]) {
    assert.ok(Array.isArray(metadata.task[field]), `${entry.id}: task.${field} must be an array`);
  }

  const value = metadata.operationalValue;
  for (const field of ["upstream", "orderedMetrics", "preservation"]) {
    assert.ok(value?.[field] !== undefined, `${entry.id}: operationalValue.${field} is required`);
  }
  assert.equal(value.upstream, "gh-aw", `${entry.id}: operational value must identify gh-aw as its upstream`);
  assert.ok(Array.isArray(value.orderedMetrics) && value.orderedMetrics.length > 0, `${entry.id}: ordered metrics are required`);
  for (const metric of value.orderedMetrics) {
    assert.match(metric.id, /^[a-z][a-z0-9-]*$/, `${entry.id}: invalid metric id`);
    assert.ok(metric.unit, `${entry.id}: metric unit is required`);
    assert.ok(metric.direction, `${entry.id}: metric direction is required`);
  }

  assert.equal(metadata.dashboard, `${entry.id}.dashboard.yml`, `${entry.id}: dashboard mismatch`);
  const dashboardSource = await readFile(resolve(examplesDirectory, metadata.dashboard), "utf8");
  const dashboardResult = validateDashboardDocument(dashboardSource);
  assert.equal(
    dashboardResult.ok,
    true,
    `${entry.id}: invalid dashboard: ${JSON.stringify(dashboardResult.errors)}`,
  );
  const sourcesResult = validateLogicalSources(metadata.logicalSources || {});
  assert.equal(
    sourcesResult.ok,
    true,
    `${entry.id}: invalid logical sources: ${JSON.stringify(sourcesResult.errors)}`,
  );

  referencedFiles.add(entry.metadata);
  referencedFiles.add(entry.dashboard);
}

const actualFiles = (await readdir(examplesDirectory).catch((error) => {
  if (error.code === "ENOENT") return [];
  throw error;
}))
  .map((name) => `examples/${name}`)
  .sort();
assert.deepEqual(
  [...referencedFiles].filter((name) => name !== "index.json").sort(),
  actualFiles,
  "corpus index must reference every example file exactly once",
);

console.log(`Validated ${index.examples.length} generate-dashboard-ir corpus example(s).`);
