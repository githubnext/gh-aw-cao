#!/usr/bin/env node

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fail, isSlug, requireArgs } from "./common.mjs";

const args = process.argv.slice(2);
requireArgs(args, 0, 1, "list-workflows.mjs [WORKFLOW-NAME]");

let workflowDir;
if (existsSync(".github/workflows")) workflowDir = ".github/workflows";
else if (process.cwd().endsWith(`${path.sep}.github${path.sep}workflows`)) workflowDir = ".";
else fail("run from a repository root or its .github/workflows directory");

const names = readdirSync(workflowDir)
  .filter((name) => name.endsWith(".md"))
  .map((name) => name.slice(0, -3))
  .sort();
if (names.length === 0) fail("no GitHub Agentic Workflow Markdown files found");

if (args.length === 1) {
  if (!isSlug(args[0])) fail("workflow name must contain lowercase letters, numbers, and single hyphens");
  if (!names.includes(args[0])) fail(`workflow not found: ${args[0]}`);
  console.log(`.github/workflows/${args[0]}.md`);
} else {
  console.log(names.join("\n"));
}
