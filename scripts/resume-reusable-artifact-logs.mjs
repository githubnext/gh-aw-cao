import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { sha256 } from "./reusable-artifact-value.mjs";

const [manifestFile, outputDirectory] = process.argv.slice(2);
if (!manifestFile || !outputDirectory) throw new Error("Usage: resume-reusable-artifact-logs.mjs MANIFEST PRIVATE_OUTPUT_DIRECTORY");
const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
if (manifest.repository !== "github/gh-aw" || manifest.until !== "2026-10-18T15:00:12Z"
  || manifest.remainingCount !== 950 || manifest.requests?.length !== 950
  || new Set(manifest.requests.map(row => row.endpoint)).size !== 950) throw new Error("Frozen remaining queue changed");
const allowed = new Set(["date", "x-github-request-id", "x-ratelimit-resource", "x-ratelimit-limit",
  "x-ratelimit-used", "x-ratelimit-remaining", "x-ratelimit-reset", "retry-after", "content-type"]);
mkdirSync(outputDirectory, { recursive: true });
const receipts = [], cursorFile = path.join(outputDirectory, "cursor.json");
let lastRequest = 0;
for (const row of manifest.requests) {
  if (!Number.isSafeInteger(row.runId) || row.endpoint !== `repos/github/gh-aw/actions/runs/${row.runId}/attempts/1/logs`
    || path.basename(row.cacheFile) !== `${row.runId}-attempt-1-log-probe.json`) throw new Error("Unsafe queue endpoint");
  const receiptFile = path.join(outputDirectory, `${row.runId}-transport.json`);
  if (existsSync(receiptFile)) {
    const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
    if (receipt.endpoint !== row.endpoint || receipt.stop) throw new Error("Prior stop receipt requires fresh coordinated clearance");
    receipts.push(receipt);
    continue;
  }
  if (existsSync(row.cacheFile)) throw new Error("Queue changed outside the coordinated receiver; reconcile before continuing");
  await setTimeout(Math.max(0, 1500 - (Date.now() - lastRequest)));
  lastRequest = Date.now();
  let bytes, failure = null;
  try {
    bytes = execFileSync("gh", ["api", "--include", row.endpoint], {
      timeout: 60000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (!Number.isInteger(error.status)) throw error;
    bytes = error.stdout;
    failure = error.status;
  }
  if (!Buffer.isBuffer(bytes)) throw new Error("No response bytes; no retry or new discovery is authorized");
  const boundary = bytes.indexOf("\r\n\r\n") >= 0 ? bytes.indexOf("\r\n\r\n") : bytes.indexOf("\n\n");
  const separator = bytes.indexOf("\r\n\r\n") >= 0 ? 4 : 2;
  if (boundary < 0) throw new Error("No provider response headers; stop acquisition");
  const headerText = bytes.subarray(0, boundary).toString("utf8"), headers = {};
  const status = Number(headerText.match(/^HTTP\/[\d.]+ (\d{3})/)?.[1]);
  for (const line of headerText.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const key = line.slice(0, colon).toLowerCase();
    if (allowed.has(key)) headers[key] = line.slice(colon + 1).trim();
  }
  if (!Number.isInteger(status)) throw new Error("No valid provider HTTP status; stop acquisition");
  const body = bytes.subarray(boundary + separator);
  const stop = [403, 429].includes(status) || Object.hasOwn(headers, "retry-after")
    || headers["x-ratelimit-remaining"] === "0";
  const receipt = { endpoint: row.endpoint, runId: row.runId, at: new Date().toISOString(),
    httpStatus: status, headers, bodySha256: sha256(body), bytes: body.length, stop };
  writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
  receipts.push(receipt);
  writeFileSync(cursorFile, `${JSON.stringify({ complete: false, attempted: receipts.length,
    remaining: 950 - receipts.length, stop, lastEndpoint: row.endpoint }, null, 2)}\n`);
  if (stop) throw new Error(`Coordinated quota STOP at ${row.endpoint}: HTTP ${status}; slot must be returned`);
  if (status === 200 && !failure) {
    writeFileSync(path.join(path.dirname(row.cacheFile), `${row.runId}-attempt-1-logs.zip`), body);
    writeFileSync(row.cacheFile, JSON.stringify({ status: "available-uninterpreted", sha256: sha256(body), bytes: body.length,
      httpStatus: status, headers }));
  } else if ([404, 410].includes(status)) {
    writeFileSync(row.cacheFile, JSON.stringify({ status: "unavailable", httpStatus: status, headers,
      reason: "Provider does not supply original-attempt logs; no outcome is inferred." }));
  } else throw new Error(`Unexpected HTTP ${status}; queue stopped without retry`);
  if (receipts.length % 50 === 0) console.log(JSON.stringify({ attempted: receipts.length, remaining: 950 - receipts.length, status }));
}
writeFileSync(cursorFile, `${JSON.stringify({ complete: true, attempted: receipts.length, remaining: 0, stop: false }, null, 2)}\n`);
console.log(JSON.stringify({ complete: true, attempted: receipts.length, statuses: receipts.reduce((out, row) => {
  out[row.httpStatus] = (out[row.httpStatus] ?? 0) + 1;
  return out;
}, {}) }));
