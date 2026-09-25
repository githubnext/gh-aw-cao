#!/usr/bin/env node

import { fail, isRepository, isSlug, requireArgs } from "./common.mjs";

const args = process.argv.slice(2);
requireArgs(args, 2, 3, "value-function-path.mjs OWNER/REPO WORKFLOW-SLUG [CAMPAIGN-SLUG]");
if (!isRepository(args[0])) fail("repository must use OWNER/REPO format");
if (!isSlug(args[1])) fail("workflow slug must contain lowercase letters, numbers, and single hyphens");
const campaign = args[2] ?? args[1];
if (!isSlug(campaign)) fail("campaign slug must contain lowercase letters, numbers, and single hyphens");
console.log(`${campaign}/operational-value/${args[1]}.mjs`);
