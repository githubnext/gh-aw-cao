#!/usr/bin/env node

import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as githubToolkit from "@actions/github";
import * as io from "@actions/io";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateRepositoryVisibility } from "./repository-visibility.mjs";

function input(name) {
  return core.getInput(name) || "";
}

export async function run() {
  const script = input("script") || process.argv[2];
  const rawArguments = input("arguments");
  const args = rawArguments ? JSON.parse(rawArguments) : process.argv.slice(3);
  if (!script) throw new Error("An activity script is required");
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
    throw new Error("Activity script arguments must be a JSON array of strings");
  }

  const token = input("github-token") || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "local-action";
  const modulePath = path.resolve(process.env.GITHUB_WORKSPACE || ".", script);
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.main !== "function") {
    throw new Error(`${script} does not export main`);
  }

  const actions = {
    core,
    github: githubToolkit.getOctokit(token),
    context: githubToolkit.context,
    exec,
    io,
    getOctokit: githubToolkit.getOctokit,
  };
  if (process.env.GITHUB_ACTIONS === "true") {
    const policyPath = path.resolve(process.env.GITHUB_WORKSPACE || ".", ".github/workflows/cao.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    await validateRepositoryVisibility({
      controlRepository: process.env.GITHUB_REPOSITORY || "",
      allowedRepositories: policy["control-plane"]?.scope?.["allowed-repositories"] || [],
      request: actions.github.request,
      paginate: actions.github.paginate,
    });
  }
  await module.main(actions, args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run().catch((error) => {
    core.setFailed(error instanceof Error ? error.stack || error.message : String(error));
  });
}
