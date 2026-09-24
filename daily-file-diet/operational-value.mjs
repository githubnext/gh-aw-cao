#!/usr/bin/env node

import { readFileSync } from "node:fs";
import {
  collectBatch,
  definition,
  scoreMetric,
} from "./operational-value/daily-file-diet.mjs";

const REPOSITORY_COORDINATE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

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

const supported = new Map(
  definition.evidence.repositories.map((repository) => [repository.toLowerCase(), repository]),
);
const repositories = request.repositories.filter((repository) => supported.has(repository.toLowerCase()));
if (repositories.length === 0) process.exit(0);

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
  collections = await collectBatch(windows, {
    database: request.database,
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
if (!Array.isArray(collections) || collections.length !== windows.length) {
  fail("Operational value collector returned an invalid result");
}

for (let index = 0; index < windows.length; index += 1) {
  for (const metric of definition.metrics) {
    const value = scoreMetric(metric.id, collections[index].evidence);
    if (value === null) continue;
    console.log(JSON.stringify({
      timestamp: request.timestamp,
      repository: windows[index].repository,
      valueId: metric.id,
      value,
    }));
  }
}
