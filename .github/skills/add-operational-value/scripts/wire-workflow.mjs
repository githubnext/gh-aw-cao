#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fail, isSlug, repoRoot, requireArgs, scriptDir } from "./common.mjs";

const args = process.argv.slice(2);
let root = repoRoot;
const rootIndex = args.indexOf("--root");
if (rootIndex >= 0) {
  if (!args[rootIndex + 1]) fail("--root requires a directory");
  root = path.resolve(args[rootIndex + 1]);
  args.splice(rootIndex, 2);
}
requireArgs(args, 1, 1, "wire-workflow.mjs WORKFLOW-SLUG [--root DIRECTORY]");
const [workflow] = args;
if (!isSlug(workflow)) fail("workflow must contain lowercase letters, numbers, and single hyphens");
const directory = path.join(root, ".github");
const valueModule = path.join(directory, "operational-value", `${workflow}.mjs`);
if (!existsSync(valueModule)) fail(`value module not found: ${valueModule}`);
const adapter = path.join(directory, "operational-value.mjs");
const template = readFileSync(path.join(scriptDir, "../templates/campaign-operational-value.mjs"), "utf8");
if (existsSync(adapter)) {
  if (readFileSync(adapter, "utf8") !== template) {
    fail(`${adapter} already exists and is not the standard adapter`);
  }
} else {
  writeFileSync(adapter, template, { flag: "wx" });
}
console.log(`verified ${adapter}`);
