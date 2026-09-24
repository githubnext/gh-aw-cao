#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fail, isSlug, repoRoot, requireArgs, scriptDir } from "./common.mjs";

const args = process.argv.slice(2);
let root = repoRoot;
const rootIndex = args.indexOf("--root");
if (rootIndex >= 0) {
  const requestedRoot = args[rootIndex + 1];
  if (!requestedRoot) fail("--root requires a directory");
  root = path.resolve(requestedRoot);
  args.splice(rootIndex, 2);
}
requireArgs(args, 2, 2, "wire-campaign.mjs CAMPAIGN-SLUG WORKFLOW-SLUG [--root DIRECTORY]");
const [campaign, workflow] = args;
if (!isSlug(campaign) || !isSlug(workflow)) {
  fail("campaign and workflow slugs must contain lowercase letters, numbers, and single hyphens");
}

const campaignDirectory = path.join(root, campaign);
const manifest = path.join(campaignDirectory, "aw.yml");
const adapter = path.join(campaignDirectory, "operational-value.mjs");
const valueModule = path.join(campaignDirectory, "operational-value", `${workflow}.mjs`);
const template = path.join(scriptDir, "../templates/campaign-operational-value.mjs");
if (!existsSync(manifest)) fail(`campaign manifest not found: ${campaign}/aw.yml`);
if (!existsSync(valueModule)) {
  fail(`value module not found: ${campaign}/operational-value/${workflow}.mjs`);
}

const templateSource = readFileSync(template, "utf8");
if (existsSync(adapter)) {
  const adapterSource = readFileSync(adapter, "utf8");
  if (adapterSource !== templateSource) {
    fail(`${campaign}/operational-value.mjs already exists and is not the standard campaign adapter`);
  }
} else {
  writeFileSync(adapter, templateSource, { flag: "wx" });
}

const source = readFileSync(manifest, "utf8");
const lines = source.split("\n");
const includesIndex = lines.findIndex((line) => line === "includes:");
if (includesIndex < 0) fail(`${campaign}/aw.yml has no includes list`);
let insertIndex = includesIndex + 1;
while (insertIndex < lines.length && /^\s+-\s+/.test(lines[insertIndex])) {
  insertIndex += 1;
}
const valueModuleInclude = `operational-value/${workflow}.mjs`;
const includeAdditions = lines.some((line) => line.trim() === `- ${valueModuleInclude}`)
  ? []
  : [`  - ${valueModuleInclude}`];
if (includeAdditions.length > 0) {
  lines.splice(insertIndex, 0, ...includeAdditions);
}
const adapterDestination = `${campaign}/operational-value.mjs`;
if (!lines.some((line) => line.trim() === `destination: ${adapterDestination}`)) {
  let resourcesIndex = lines.findIndex((line) => line === "resources:");
  if (resourcesIndex < 0) {
    if (lines.at(-1) === "") lines.pop();
    lines.push("resources:");
    resourcesIndex = lines.length - 1;
  }
  let resourceInsertIndex = resourcesIndex + 1;
  while (resourceInsertIndex < lines.length && (lines[resourceInsertIndex] === "" || /^\s+/.test(lines[resourceInsertIndex]))) {
    resourceInsertIndex += 1;
  }
  lines.splice(resourceInsertIndex, 0,
    "  - source: operational-value.mjs",
    `    destination: ${adapterDestination}`);
}
if (includeAdditions.length > 0 || !source.includes(`destination: ${adapterDestination}`)) {
  writeFileSync(manifest, `${lines.join("\n")}\n`);
}

console.log(`wired ${campaign}/aw.yml: operational-value.mjs, ${valueModuleInclude}`);
