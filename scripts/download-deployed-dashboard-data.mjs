#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const defaultUrl = "https://githubnext.github.io/gh-aw-cao/cao/gh-aw-logs.jsonl";
const usage = `Usage:
  npm run dashboard:data:download -- [--url URL] [--output DIRECTORY]

Defaults:
  URL        DASHBOARD_DATA_URL or ${defaultUrl}
  DIRECTORY  _activity`;

function parseOptions(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "help") return { help: true };
    if (!["--url", "--output"].includes(argument)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}`);
    }
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

function deployedUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Dashboard data URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Dashboard data URL must not contain credentials.");
  }
  return url;
}

async function download(url, destination) {
  const response = await fetch(url, {
    headers: { accept: "application/x-ndjson, application/json, text/plain" },
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Unable to download ${url}: HTTP ${response.status}`);
  }
  if (!response.body) throw new Error(`Unable to download ${url}: response body is empty`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: "wx" }));
  if ((await stat(destination)).size === 0) {
    throw new Error(`Unable to download ${url}: response body is empty`);
  }
}

async function replaceFile(source, destination) {
  await rm(destination, { force: true });
  await rename(source, destination);
}

export async function downloadDeployedDashboardData({
  url = process.env.DASHBOARD_DATA_URL || defaultUrl,
  output = "_activity",
} = {}) {
  const logsUrl = deployedUrl(url);
  const databaseUrl = new URL("gh-aw-logs.sqlite", logsUrl);
  const outputDirectory = path.resolve(output);
  await mkdir(outputDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(path.join(outputDirectory, ".deployed-dashboard-"));
  const temporaryLogs = path.join(temporaryDirectory, "gh-aw-logs.jsonl");
  const temporaryDatabase = path.join(temporaryDirectory, "gh-aw-logs.sqlite");
  const logsPath = path.join(outputDirectory, "gh-aw-logs.jsonl");
  const databasePath = path.join(outputDirectory, "gh-aw-logs.sqlite");

  try {
    await Promise.all([
      download(logsUrl, temporaryLogs),
      download(databaseUrl, temporaryDatabase),
    ]);
    await replaceFile(temporaryLogs, logsPath);
    await replaceFile(temporaryDatabase, databasePath);
    return {
      logsUrl: logsUrl.href,
      databaseUrl: databaseUrl.href,
      logs: logsPath,
      database: databasePath,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const result = await downloadDeployedDashboardData(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
