#!/usr/bin/env node

import { fail, isRepository, isSlug, requireArgs } from "./common.mjs";

const args = process.argv.slice(2);
requireArgs(args, 2, 2, "value-function-path.mjs OWNER/REPO WORKFLOW-SLUG");
if (!isRepository(args[0])) fail("repository must use OWNER/REPO format");
if (!isSlug(args[1])) fail("workflow slug must contain lowercase letters, numbers, and single hyphens");
console.log(`functions/${args[0].toLowerCase().replace("/", "-")}/${args[1]}.mjs`);
