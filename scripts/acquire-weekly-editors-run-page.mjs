import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const endpoint = "repos/github/gh-aw/actions/workflows/weekly-editors-health-check.lock.yml/runs?created=2026-02-21T22%3A11%3A11Z..2026-10-18T15%3A00%3A12Z&per_page=100&page=1";
const directory = process.argv[2];
if (!directory || !path.isAbsolute(directory)) throw new Error("An absolute acquisition receipt directory is required");
mkdirSync(directory, { recursive: true });
const receiptFile = path.join(directory, "receipt.json");
const refusalFile = path.join(directory, "quota-refusal.json");
if (existsSync(receiptFile) || existsSync(refusalFile)) throw new Error("Single request already attempted or quota refusal persisted");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const invocation = path.join(directory, "invocation.json");
if (existsSync(invocation)) throw new Error("Single acquisition invocation already persisted; do not retry");
writeFileSync(invocation, JSON.stringify({ endpoint, method: "GET", concurrency: 1, attempts: 1,
  authorizedAt: "2026-10-19T09:26:47Z", startedAt: new Date().toISOString() }));
await setTimeout(1600);
const result = spawnSync("gh", ["api", "--hostname", "github.com", "--method", "GET", "--include", endpoint], {
  timeout: 60000, maxBuffer: 4 * 1024 * 1024, encoding: null,
  env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" },
  stdio: ["ignore", "pipe", "pipe"],
});
const output = result.stdout ?? Buffer.alloc(0);
const boundary = output.indexOf("\r\n\r\n") >= 0 ? output.indexOf("\r\n\r\n") : output.indexOf("\n\n");
const separator = boundary >= 0 && output.subarray(boundary, boundary + 4).equals(Buffer.from("\r\n\r\n")) ? 4 : 2;
const headerText = boundary >= 0 ? output.subarray(0, boundary).toString("utf8") : "";
const body = boundary >= 0 ? output.subarray(boundary + separator) : output;
const status = Number(headerText.match(/^HTTP\/\S+\s+(\d+)/i)?.[1]) || null;
const allow = new Set(["content-type", "content-length", "date", "etag", "link", "retry-after",
  "x-github-request-id", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-ratelimit-resource"]);
const headers = {};
for (const line of headerText.split(/\r?\n/).slice(1)) {
  const match = line.match(/^([^:]+):\s*(.*)$/);
  if (match && allow.has(match[1].toLowerCase())) headers[match[1].toLowerCase()] = match[2];
}
const refused = status === 403 || status === 429 || Object.hasOwn(headers, "retry-after")
  || headers["x-ratelimit-remaining"] === "0";
writeFileSync(path.join(directory, "response.body.json"), body);
writeFileSync(path.join(directory, "response.headers.json"), `${JSON.stringify({ status, headers }, null, 2)}\n`);
const receipt = {
  schemaVersion: 1, endpoint, method: "GET", receivedAt: new Date().toISOString(),
  status, headers, exitStatus: result.status, errorCode: result.error?.code ?? null,
  bodySha256: hash(body), bodyBytes: body.length, stdoutSha256: hash(output),
  refusal: refused, attempts: 1, additionalRequests: 0,
  stderr: (result.stderr ?? Buffer.alloc(0)).toString("utf8"),
};
writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
if (refused) writeFileSync(refusalFile, `${JSON.stringify(receipt, null, 2)}\n`);
const packet = { receipt, originalBody: body.toString("base64"), encoding: "base64-original-provider-body" };
writeJsonArchive("docs/operational-value/proof/weekly-editors-health-check/run-discovery-page-1.json", packet);
console.log(JSON.stringify(receipt));
if (status !== 200 || result.status !== 0 || refused) process.exitCode = 1;
else {
  const document = JSON.parse(readFileSync(path.join(directory, "response.body.json"), "utf8"));
  if (!Array.isArray(document.workflow_runs) || !Number.isSafeInteger(document.total_count)) throw new Error("Invalid run page");
  console.log(JSON.stringify({ total: document.total_count, returned: document.workflow_runs.length, link: headers.link ?? null }));
}
