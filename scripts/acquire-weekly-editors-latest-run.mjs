import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const directory = process.argv[2];
if (!directory || !path.isAbsolute(directory)) throw new Error("Absolute receipt directory required");
const previous = path.join(path.dirname(directory), "weekly-editors-run-discovery-20261019", "quota-refusal.json");
if (existsSync(previous) || existsSync(path.join(directory, "quota-refusal.json"))) {
  throw new Error("Persisted quota refusal blocks acquisition");
}
mkdirSync(directory, { recursive: true });
const invocation = path.join(directory, "invocation.json");
if (existsSync(invocation)) throw new Error("Latest-run batch already invoked; no retries authorized");
const prefix = "repos/github/gh-aw/actions/runs/39014584632";
const requests = [
  { name: "artifacts", endpoint: `${prefix}/artifacts?per_page=100&page=1` },
  { name: "jobs", endpoint: `${prefix}/attempts/1/jobs?per_page=100&page=1` },
  { name: "logs", endpoint: `${prefix}/attempts/1/logs` },
];
writeFileSync(invocation, JSON.stringify({ startedAt: new Date().toISOString(), requests,
  concurrency: 1, minimumPacingMilliseconds: 1600, attemptsPerEndpoint: 1 }));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const allow = new Set(["content-type", "content-length", "date", "etag", "link", "retry-after",
  "x-github-request-id", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-ratelimit-resource",
  "last-modified", "content-disposition"]);
const receipts = [];
for (const request of requests) {
  await setTimeout(1600);
  const result = spawnSync("gh", ["api", "--hostname", "github.com", "--method", "GET", "--include", request.endpoint], {
    timeout: 90000, maxBuffer: 12 * 1024 * 1024, encoding: null,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = result.stdout ?? Buffer.alloc(0);
  const crlf = output.indexOf("\r\n\r\n"), lf = output.indexOf("\n\n");
  const boundary = crlf >= 0 ? crlf : lf;
  const headersText = boundary >= 0 ? output.subarray(0, boundary).toString("utf8") : "";
  const body = boundary >= 0 ? output.subarray(boundary + (crlf >= 0 ? 4 : 2)) : output;
  const status = Number(headersText.match(/^HTTP\/\S+\s+(\d+)/i)?.[1]) || null;
  const headers = {};
  for (const line of headersText.split(/\r?\n/).slice(1)) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match && allow.has(match[1].toLowerCase())) headers[match[1].toLowerCase()] = match[2];
  }
  const refusal = status === 403 || status === 429 || Object.hasOwn(headers, "retry-after")
    || headers["x-ratelimit-remaining"] === "0";
  const extension = request.name === "logs" && body.subarray(0, 2).toString() === "PK" ? "zip" : "json";
  writeFileSync(path.join(directory, `${request.name}.body.${extension}`), body);
  const receipt = {
    schemaVersion: 1, name: request.name, endpoint: request.endpoint, method: "GET",
    receivedAt: new Date().toISOString(), status, headers, exitStatus: result.status,
    errorCode: result.error?.code ?? null, bodyBytes: body.length, bodySha256: hash(body),
    refusal, automaticRedirect: request.name === "logs"
      ? "Only provider-required log-download redirects permitted; signed redirect URLs not retained." : "none authorized",
    stderr: (result.stderr ?? Buffer.alloc(0)).toString("utf8").replace(/https:\/\/\S+/g, "[redacted-provider-error-url]"),
  };
  writeFileSync(path.join(directory, `${request.name}.receipt.json`), `${JSON.stringify(receipt, null, 2)}\n`);
  writeJsonArchive(`docs/operational-value/proof/weekly-editors-health-check/latest-run-${request.name}.json`, {
    receipt, encoding: "base64-original-provider-body", originalBody: body.toString("base64"),
  });
  receipts.push(receipt);
  console.log(JSON.stringify(receipt));
  if (refusal) {
    writeFileSync(path.join(directory, "quota-refusal.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    break;
  }
  if (result.error || status === null) break;
}
const manifest = { requestsAuthorized: 3, requestsAttempted: receipts.length, receipts,
  nativeHttpEvidence: "Not inspected; source/run metadata and API statuses do not establish editor availability.",
  remainingEndpoints: requests.slice(receipts.length).map(request => request.endpoint) };
writeFileSync(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ requestsAttempted: receipts.length, statuses: receipts.map(row => row.status),
  refused: receipts.some(row => row.refusal), remaining: manifest.remainingEndpoints }));
