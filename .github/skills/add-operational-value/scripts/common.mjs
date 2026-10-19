#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { readJsonArchive } from "./json-archive.mjs";

export const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = process.cwd();

export function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

export function requireArgs(args, minimum, maximum, usage) {
  if (args.length < minimum || args.length > maximum) fail(`usage: ${usage}`);
}

export function requireCommand(command) {
  const result = spawnSync("which", [command], { stdio: "ignore" });
  if (result.status !== 0) fail(`${command} is required`);
}

export function run(command, args = [], options = {}) {
  const nodeScript = command.endsWith(".mjs") && existsSync(command)
    && path.dirname(realpathSync(command)) === realpathSync(scriptDir);
  const result = spawnSync(nodeScript ? process.execPath : command, nodeScript ? [command, ...args] : args, {
    encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
    input: options.input,
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio,
    maxBuffer: options.maxBuffer ?? 1024 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr ?? "").trim();
    throw new Error(detail || `${command} exited with status ${result.status}`);
  }
  return result.stdout ?? "";
}

export function runJson(command, args = [], options = {}) {
  return JSON.parse(run(command, args, options));
}

export async function importValueModule(file) {
  return import(pathToFileURL(path.resolve(file)).href);
}

export function readJson(file) {
  return readJsonArchive(file, { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 });
}

export function writeJson(value, spacing = 2) {
  return `${JSON.stringify(value, null, spacing)}\n`;
}

export function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function isRepository(value) {
  return /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

export function isSlug(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

export function isIsoUtc(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

export function shiftDays(value, days) {
  return new Date(Date.parse(value) + days * 86_400_000)
    .toISOString()
    .replace(".000Z", "Z");
}

export function observationWindows(definition, startAt, endAt, retained = []) {
  const { durationDays, cadenceDays, maturationDays } = definition.evidence.window;
  const start = Date.parse(startAt), end = Date.parse(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end
    || !["interval", "snapshot"].includes(definition.evidence.measurementKind)
    || ![durationDays, cadenceDays].every(value => Number.isFinite(value) && value > 0)
    || !Number.isFinite(maturationDays) || maturationDays < 0) {
    throw new Error("Invalid bounded observation schedule");
  }
  const iso = value => new Date(value).toISOString().replace(".000Z", "Z");
  if (definition.evidence.measurementKind === "interval") {
    const windows = [], maturation = maturationDays * 86_400_000;
    const duration = durationDays * 86_400_000;
    const step = Math.max(durationDays, cadenceDays) * 86_400_000;
    for (let at = end; at - maturation > start; at -= step) {
      const windowEnd = at - maturation;
      windows.push({ observedAt: iso(at), windowStart: iso(Math.max(start, windowEnd - duration)),
        windowEnd: iso(windowEnd) });
    }
    return windows.length ? windows.reverse()
      : [{ observedAt: endAt, windowStart: startAt, windowEnd: endAt }];
  }
  const attainment = definition.evaluation?.mode === "attainment-only";
  const cadence = cadenceDays * 86_400_000;
  const times = [];
  for (let at = attainment ? start + cadence : start; at <= end; at += cadence) times.push(iso(at));
  times.push(endAt);
  for (let period = 1; period < Math.max(2, definition.review?.periods ?? 0); period += 1) {
    const at = shiftDays(endAt, -cadenceDays * period);
    if (Date.parse(at) > start) times.push(at);
  }
  if (!attainment && definition.adoption.baselineAt) times.push(definition.adoption.baselineAt);
  times.push(...retained.map(snapshot => snapshot.observedAt).filter(at =>
    Date.parse(at) <= end && (!attainment || Date.parse(at) > start)));
  return [...new Set(times)].sort((left, right) => Date.parse(left) - Date.parse(right)).map(observedAt => {
    const interim = attainment && Date.parse(observedAt) < Date.parse(shiftDays(
      definition.adoption.adoptedAt, durationDays + maturationDays));
    const windowEnd = interim ? observedAt : shiftDays(observedAt, -maturationDays);
    return { observedAt, windowStart: interim ? definition.adoption.adoptedAt : shiftDays(windowEnd, -durationDays),
      windowEnd };
  });
}

export function nowUtc() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function sha256File(file) {
  return execFileSync("shasum", ["-a", "256", file], { encoding: "utf8" }).split(/\s+/)[0];
}
