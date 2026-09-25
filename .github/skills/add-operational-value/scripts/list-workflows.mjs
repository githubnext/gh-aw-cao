#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { fail, isSlug, requireArgs } from "./common.mjs";

const args = process.argv.slice(2);
let campaign;
const campaignIndex = args.indexOf("--campaign");
if (campaignIndex >= 0) {
  campaign = args[campaignIndex + 1];
  if (!campaign || !isSlug(campaign)) fail("--campaign requires a valid campaign slug");
  args.splice(campaignIndex, 2);
}
requireArgs(args, 0, 1, "list-workflows.mjs [WORKFLOW-NAME] [--campaign CAMPAIGN-SLUG]");

let workflowDir;
if (existsSync(".github/workflows")) workflowDir = ".github/workflows";
else if (process.cwd().endsWith(`${path.sep}.github${path.sep}workflows`)) workflowDir = ".";
else fail("run from a repository root or its .github/workflows directory");

let names;
if (campaign) {
  const manifest = path.resolve(campaign, "aw.yml");
  if (!existsSync(manifest)) fail(`campaign manifest not found: ${campaign}/aw.yml`);
  let parsed;
  try {
    parsed = parse(readFileSync(manifest, "utf8"));
  } catch (error) {
    fail(`campaign manifest is invalid: ${error.message}`);
  }
  const includedNames = [...new Set((parsed?.includes ?? []).flatMap((include) => {
    const match = String(include).match(/^\.github\/workflows\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/);
    return match ? [match[1]] : [];
  }))].sort();
  names = includedNames.filter((name) => {
    const workflowPath = path.join(workflowDir, `${name}.md`);
    if (!existsSync(workflowPath)) {
      fail(`campaign workflow not found: .github/workflows/${name}.md`);
    }
    const source = readFileSync(workflowPath, "utf8");
    const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!frontmatter) return false;
    let workflow;
    try {
      workflow = parse(frontmatter[1]);
    } catch (error) {
      fail(`campaign workflow is invalid: .github/workflows/${name}.md: ${error.message}`);
    }
    return (workflow?.imports ?? []).some(
      (entry) => entry?.uses === "shared/control.md" && entry?.with?.role === "worker",
    );
  });
} else {
  names = readdirSync(workflowDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3))
    .sort();
}
if (names.length === 0) fail("no GitHub Agentic Workflow Markdown files found");

if (args.length === 1) {
  if (!isSlug(args[0])) fail("workflow name must contain lowercase letters, numbers, and single hyphens");
  if (!names.includes(args[0])) fail(`workflow not found: ${args[0]}`);
  console.log(`.github/workflows/${args[0]}.md`);
} else {
  console.log(names.join("\n"));
}
