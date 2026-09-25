#!/usr/bin/env node

import { fail, isRepository, requireArgs, requireCommand, run, runJson, writeJson } from "./common.mjs";

const args = process.argv.slice(2);
requireArgs(args, 2, 2, "extract-workflow-intent.mjs <owner/repo> <.github/workflows/name.md>");
const [repository, workflowPath] = args;
if (!isRepository(repository)) fail("repository must use owner/repo format");
if (!/^\.github\/workflows\/[^/]+\.md$/.test(workflowPath)) {
  fail("workflow path must be .github/workflows/<name>.md");
}
requireCommand("gh");

const lockPath = workflowPath.replace(/\.md$/, ".lock.yml");
const pages = runJson("gh", ["api", "--paginate", "--slurp", `repos/${repository}/commits?path=${lockPath}&per_page=100`]);
const commits = pages.flat();
const commit = commits.at(-1);
if (!commit) fail("compiled workflow path has no commit history");
const adoption = {
  commit: commit.sha,
  adoptedAt: commit.commit.committer.date ?? commit.commit.author.date,
  baselineCommit: commit.parents[0]?.sha ?? null,
};
const rawArgs = (target) => [
  "api", "--method", "GET", "-f", `ref=${adoption.commit}`,
  "-H", "Accept: application/vnd.github.raw+json",
  `repos/${repository}/contents/${target}`,
];
const workflowSource = run("gh", rawArgs(workflowPath));
const compiledWorkflow = run("gh", rawArgs(lockPath));
const lines = workflowSource.split(/\r?\n/);
let closing = -1;
if (lines[0] === "---") closing = lines.indexOf("---", 1);
const frontmatter = closing > 0 ? lines.slice(1, closing).join("\n") : "";
const instructions = closing > 0 ? lines.slice(closing + 1).join("\n") : workflowSource;
const frontmatterLines = frontmatter.split("\n");
const importsStart = frontmatterLines.findIndex((line) => line === "imports:");
let imports = "";
if (importsStart >= 0) {
  let importsEnd = importsStart + 1;
  while (importsEnd < frontmatterLines.length && !/^[A-Za-z0-9_-]+:/.test(frontmatterLines[importsEnd])) importsEnd += 1;
  imports = frontmatterLines.slice(importsStart, importsEnd).join("\n");
}

process.stdout.write(writeJson({
  schemaVersion: 1,
  repository,
  workflowPath,
  lockPath,
  adoption,
  intentSources: { frontmatter, imports, instructions, compiledWorkflow },
}));
