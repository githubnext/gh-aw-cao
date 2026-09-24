#!/usr/bin/env node

import { existsSync } from "node:fs";
import {
  fail, isExecutable, isIsoUtc, isRepository, isSlug, requireCommand,
  runValueFunction, shiftDays,
} from "./common.mjs";

const args = process.argv.slice(2);
const runCollector = args[0] === "--collector";
if (runCollector) args.shift();
if (args.length !== 1) fail("usage: verify-value-function.mjs [--collector] <value-function.mjs>");
const valueFunction = args[0];
if (!existsSync(valueFunction)) fail(`value function not found: ${valueFunction}`);
if (!isExecutable(valueFunction)) fail(`value function is not executable: ${valueFunction}`);
requireCommand("node");
try {
  new Function(`return import(${JSON.stringify(new URL(`file://${process.cwd()}/${valueFunction}`).href)})`);
} catch {
  fail("value function is not valid JavaScript");
}

let definition;
try {
  definition = JSON.parse(runValueFunction(valueFunction, ["--definition"]));
} catch (error) {
  fail(`value-function definition is invalid: ${error.message}`);
}
const isString = (value) => typeof value === "string" && value.length > 0;
const isInteger = (value, minimum) => Number.isInteger(value) && value >= minimum;
const isSha = (value) => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const adoption = definition.adoption ?? {};
const baselineValid = (adoption.baselineCommit == null && adoption.baselineAt == null)
  || (isSha(adoption.baselineCommit) && isIsoUtc(adoption.baselineAt));
const metrics = definition.metrics;
const examples = definition.validationExamples ?? {};
const valid = definition.schemaVersion === 3
  && isSlug(definition.slug)
  && /^\.github\/workflows\/.+\.md$/.test(definition.sourcePath ?? "")
  && isRepository(definition.repository)
  && isString(definition.workflowName)
  && isSha(adoption.commit)
  && isIsoUtc(adoption.adoptedAt)
  && baselineValid
  && !Object.hasOwn(definition, "collector")
  && isString(definition.evidence?.key)
  && Array.isArray(definition.evidence?.repositories)
  && definition.evidence.repositories.length > 0
  && definition.evidence.repositories.every(isRepository)
  && isString(definition.evidence?.opportunity)
  && Array.isArray(definition.evidence?.filters)
  && definition.evidence.filters.every((value) => typeof value === "string")
  && isString(definition.evidence?.collection)
  && isInteger(definition.evidence?.window?.durationDays, 1)
  && isInteger(definition.evidence?.window?.cadenceDays, 1)
  && isInteger(definition.evidence?.window?.maturationDays, 0)
  && isString(definition.model?.architecture)
  && isString(definition.model?.recommendation)
  && isString(definition.model?.presentation?.label)
  && isString(definition.model?.presentation?.betterLabel)
  && ["baseline-comparable", "attainment-only"].includes(definition.evaluation?.mode ?? "baseline-comparable")
  && isString(definition.summary?.nativeLabel)
  && Array.isArray(metrics)
  && metrics.length > 0
  && metrics.every((metric) => isString(metric.id)
    && isString(metric.name)
    && ["primary", "diagnostic"].includes(metric.role)
    && isString(metric.formula)
    && ["increase", "decrease", "maintain", "target"].includes(metric.direction)
    && isString(metric.presentation?.name)
    && isString(metric.presentation?.legendLabel)
    && metric.presentation.legendLabel.length <= 24
    && ["identity", "complement"].includes(metric.presentation?.transform)
    && (metric.direction !== "increase" || metric.presentation.transform === "identity")
    && (metric.direction !== "decrease" || metric.presentation.transform === "complement"))
  && metrics.filter(({ role }) => role === "primary").length === 1
  && new Set(metrics.map(({ id }) => id)).size === metrics.length
  && ["targetAttained", "targetMissed", "missing", "malformed"].every((key) => Object.hasOwn(examples, key));
if (!valid) fail("value-function definition is invalid");

const score = (metricId, evidence) => {
  const output = runValueFunction(valueFunction, ["--metric", metricId], `${JSON.stringify(evidence)}\n`).trim();
  const result = JSON.parse(output);
  if (result !== null && (typeof result !== "number" || result < 0 || result > 1)) {
    fail(`${metricId} returned an invalid score`);
  }
  return result;
};

for (const metric of metrics) {
  const results = Object.fromEntries(
    Object.entries(examples).map(([name, evidence]) => [name, score(metric.id, evidence)]),
  );
  if (results.targetAttained == null || results.targetMissed == null
      || results.targetAttained <= results.targetMissed) {
    fail(`${metric.id} must score targetAttained higher than targetMissed`);
  }
  if (metric.role === "primary" && (results.missing !== null || results.malformed !== null)) {
    fail(`primary metric ${metric.id} must return null for missing and malformed evidence`);
  }
}

if (runCollector) {
  const mode = definition.evaluation?.mode ?? "baseline-comparable";
  const observedAt = mode === "attainment-only"
    ? adoption.adoptedAt
    : (adoption.baselineAt ?? adoption.adoptedAt);
  const windowEnd = shiftDays(observedAt, -definition.evidence.window.maturationDays);
  const windowStart = shiftDays(windowEnd, -definition.evidence.window.durationDays);
  let collections;
  try {
    collections = JSON.parse(runValueFunction(valueFunction, ["--collect-batch"], `${JSON.stringify([
      { windowStart, windowEnd, observedAt },
    ])}\n`));
  } catch (error) {
    fail(`batch collector did not exit cleanly: ${error.message}`);
  }
  const validCollections = Array.isArray(collections) && collections.length === 1
    && collections.every((collection) => collection.evidence && typeof collection.evidence === "object"
      && (!Object.hasOwn(collection, "commit") || /^[0-9a-fA-F]{40}$/.test(collection.commit))
      && Array.isArray(collection.provenance) && collection.provenance.length > 0
      && collection.provenance.every((item) => isRepository(item.repository)
        && isString(item.kind) && isString(item.ref)));
  if (!validCollections) fail("collector smoke test returned invalid evidence or provenance");
  for (const metric of metrics) {
    const result = score(metric.id, collections[0].evidence);
    if (mode === "baseline-comparable" && result === null) {
      fail(`${metric.id} has no valid score for collected baseline evidence`);
    }
  }
}

console.log(`verified ${valueFunction}`);
