import fs from "node:fs";
import { createRequire } from "node:module";
import core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import exec from "@actions/exec";
import io from "@actions/io";
const require = createRequire(import.meta.url);
const github = getOctokit(process.env.GITHUB_TOKEN, { baseUrl: process.env.GITHUB_API_URL });
const script = fs.readFileSync(process.argv[2], "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

await new AsyncFunction("require", "core", "github", "context", "exec", "io", "getOctokit", script)(
  require, core, github, context, exec, io, getOctokit,
).catch(error => {
  core.setFailed(error.stack || error.message);
});
