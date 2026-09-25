#!/usr/bin/env node

import { existsSync } from "node:fs";
import { fail, requireArgs, sha256File } from "./common.mjs";

const args = process.argv.slice(2);
requireArgs(args, 1, 1, "fingerprint-value-function.mjs <value-function.mjs>");
if (!existsSync(args[0])) fail(`value function not found: ${args[0]}`);
console.log(sha256File(args[0]));
