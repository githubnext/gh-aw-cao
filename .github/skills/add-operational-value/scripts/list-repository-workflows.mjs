#!/usr/bin/env node

import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fail, isRepository, repoRoot, requireArgs, requireCommand, run, scriptDir } from "./common.mjs";

const args = process.argv.slice(2);
requireArgs(args, 1, 2, "list-repository-workflows.mjs OWNER/REPO [WORKFLOW-NAME]");
if (!isRepository(args[0])) fail("repository must use OWNER/REPO format");
requireCommand("gh");

const work = mkdtempSync(path.join(repoRoot, ".aw-value-work."));
try {
  const checkout = path.join(work, "repository");
  run("gh", ["repo", "clone", args[0], checkout, "--", "--depth=1", "--quiet"]);
  process.stdout.write(run(path.join(scriptDir, "list-workflows.mjs"), args.slice(1), { cwd: checkout }));
} finally {
  rmSync(work, { recursive: true, force: true });
}
