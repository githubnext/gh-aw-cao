#!/usr/bin/env node

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fail, isRepository, requireArgs, requireCommand, run, scriptDir } from "./common.mjs";

const args = process.argv.slice(2);
requireArgs(args, 1, 4, "list-repository-workflows.mjs OWNER/REPO [WORKFLOW-NAME] [--campaign CAMPAIGN-SLUG]");
if (!isRepository(args[0])) fail("repository must use OWNER/REPO format");
requireCommand("gh");

const work = mkdtempSync(path.join(os.tmpdir(), ".aw-value-work."));
try {
  const checkout = path.join(work, "repository");
  run("gh", ["repo", "clone", args[0], checkout, "--", "--depth=1", "--quiet"]);
  process.stdout.write(run(path.join(scriptDir, "list-workflows.mjs"), args.slice(1), { cwd: checkout }));
} finally {
  rmSync(work, { recursive: true, force: true });
}
