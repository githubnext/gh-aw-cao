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
while (insertIndex < lines.length && (/^\s+-\s+/.test(lines[insertIndex]) || lines[insertIndex] === "")) {
  insertIndex += 1;
}
const required = [
  "operational-value.mjs",
  `operational-value/${workflow}.mjs`,
];
const additions = required
  .filter((include) => !lines.some((line) => line.trim() === `- ${include}`))
  .map((include) => `  - ${include}`);
if (additions.length > 0) {
  lines.splice(insertIndex, 0, ...additions);
  writeFileSync(manifest, lines.join("\n"));
}

console.log(`wired ${campaign}/aw.yml: ${required.join(", ")}`);
