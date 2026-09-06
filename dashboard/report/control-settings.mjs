#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setActionsGlobals } from "../../activity/actions-context.mjs";
import { actionsLog as log } from "../../activity/actions-log.mjs";

const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

function diagnostic(value, fallback) {
  const message = String(value || "").replace(/\s+/g, " ").trim();
  return (message || fallback).slice(0, 700);
}

function policySnapshot(policyPath, readPolicy) {
  try {
    const source = readPolicy(policyPath, "utf8");
    let document = null;
    try {
      document = JSON.parse(source);
    } catch {
      // The runtime resolver supplies the authoritative parse diagnostic.
    }
    return { policy_document: document, policy_source: source };
  } catch {
    return { policy_document: null, policy_source: "" };
  }
}

function unavailableSettings(repository, reason, snapshot) {
  return {
    allowed_owners: [repository.split("/", 1)[0]],
    allowed_repositories: [repository],
    web: { favicon: "./favicon.svg" },
    packages: {},
    publishing_enabled: false,
    publishing_control_repositories: [repository],
    publishing_reviewers: [],
    policy_resolution: {
      status: "unavailable",
      reason,
    },
    ...snapshot,
  };
}

export function resolveDashboardControlSettings({
  repository,
  controlProgram,
  policyPath,
  execute = spawnSync,
  readPolicy = readFileSync,
}) {
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error("GITHUB_REPOSITORY must use owner/repository form");
  const snapshot = policySnapshot(policyPath, readPolicy);

  let result;
  try {
    result = execute(process.execPath, [controlProgram, "control-settings", policyPath], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_REPOSITORY: repository },
    });
  } catch (error) {
    return unavailableSettings(repository, diagnostic(error?.message, "control policy resolver crashed"), snapshot);
  }

  if (result.error || result.status !== 0) {
    const reason = diagnostic(
      result.stderr || result.error?.message || result.stdout,
      `control policy resolver exited with status ${result.status ?? "unknown"}`,
    );
    return unavailableSettings(repository, reason, snapshot);
  }

  try {
    const settings = JSON.parse(result.stdout);
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error("control policy resolver returned invalid settings");
    }
    return {
      ...settings,
      policy_resolution: {
        status: "available",
        reason: "",
      },
      ...snapshot,
    };
  } catch (error) {
    return unavailableSettings(repository, diagnostic(error?.message, "control policy resolver returned invalid JSON"), snapshot);
  }
}

export async function main(actions = {}, args = process.argv.slice(2)) {
  setActionsGlobals(actions);
  const [controlProgram, policyPath, outputPath] = args;
  if (!controlProgram || !policyPath || !outputPath) {
    throw new Error("usage: control-settings.mjs <control.mjs> <policy.json> <output.json>");
  }
  log.group`Resolve dashboard control settings`;
  try {
    const settings = resolveDashboardControlSettings({
      repository: process.env.GITHUB_REPOSITORY || "",
      controlProgram,
      policyPath,
    });
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(settings, null, 2)}\n`);
    if (settings.policy_resolution.status !== "available") {
      log.warning`Control policy resolution unavailable: ${settings.policy_resolution.reason}`;
    }
    log.info`Wrote dashboard control settings to ${outputPath}`;
  } finally {
    log.endGroup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    log.error`${error.stack || error.message || error}`;
    process.exitCode = 1;
  });
}