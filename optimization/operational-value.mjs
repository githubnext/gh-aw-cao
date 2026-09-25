#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_COORDINATE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const MODULE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const moduleDirectory = fileURLToPath(new URL("./operational-value/", import.meta.url));

function fail(message) {
  console.error(message);
  process.exit(1);
}

function shiftDays(timestamp, days) {
  return new Date(Date.parse(timestamp) + days * 86_400_000).toISOString();
}

let request;
try {
  request = JSON.parse(readFileSync(0, "utf8"));
} catch {
  fail("Invalid operational value request");
}
if (
  request?.schemaVersion !== 1
  || typeof request.timestamp !== "string"
  || Number.isNaN(Date.parse(request.timestamp))
  || !Array.isArray(request.repositories)
  || request.repositories.some((repository) => (
    typeof repository !== "string" || !REPOSITORY_COORDINATE.test(repository)
  ))
) {
  fail("Invalid operational value request");
}

const selectedModule = process.env.CAO_OPERATIONAL_VALUE_MODULE;
if (selectedModule && !MODULE_SLUG.test(selectedModule)) {
  fail("CAO_OPERATIONAL_VALUE_MODULE must be a workflow slug");
}
const moduleFiles = readdirSync(moduleDirectory)
  .filter((name) => MODULE_SLUG.test(name.replace(/\.mjs$/, "")) && name.endsWith(".mjs"))
  .filter((name) => !selectedModule || name === `${selectedModule}.mjs`)
  .sort();
if (selectedModule && moduleFiles.length === 0) {
  fail(`Operational value module not found: ${selectedModule}`);
}

for (const moduleFile of moduleFiles) {
  const valueModule = await import(pathToFileURL(path.join(moduleDirectory, moduleFile)).href);
  const { collectBatch, definition, scoreMetric } = valueModule;
  if (
    !MODULE_SLUG.test(definition?.slug ?? "")
    || typeof collectBatch !== "function"
    || typeof scoreMetric !== "function"
    || !Array.isArray(definition?.metrics)
    || !Array.isArray(definition?.evidence?.repositories)
  ) {
    fail(`Invalid operational value module: ${moduleFile}`);
  }

  const supported = new Set(
    definition.evidence.repositories.map((repository) => String(repository).toLowerCase()),
  );
  const repositories = request.repositories.filter((repository) => supported.has(repository.toLowerCase()));
  if (repositories.length === 0) continue;

  const { durationDays, maturationDays } = definition.evidence.window;
  const observedAt = request.timestamp;
  const windowEnd = shiftDays(observedAt, -maturationDays);
  const windows = repositories.map((repository) => ({
    repository,
    observedAt,
    windowStart: shiftDays(windowEnd, -durationDays),
    windowEnd,
  }));

  let collections;
  try {
    collections = await collectBatch(windows, { database: request.database });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (!Array.isArray(collections) || collections.length !== windows.length) {
    fail(`Operational value collector returned an invalid result: ${definition.slug}`);
  }

  for (let index = 0; index < windows.length; index += 1) {
    for (const metric of definition.metrics) {
      const value = scoreMetric(metric.id, collections[index].evidence);
      if (value === null) continue;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fail(`Operational value metric returned an invalid value: ${definition.slug}.${metric.id}`);
      }
      console.log(JSON.stringify({
        timestamp: request.timestamp,
        repository: windows[index].repository,
        valueId: `${definition.slug}.${metric.id}`,
        value,
        metricRole: metric.role,
        metricName: metric.name,
        metricDirection: metric.direction,
        maturityStatus: collections[index].evidence?.maturityStatus ?? "matured",
      }));
    }
  }
}
