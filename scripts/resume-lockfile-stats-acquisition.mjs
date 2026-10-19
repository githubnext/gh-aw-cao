import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout } from "node:timers/promises";

const directory = "docs/operational-value/proof/lockfile-stats";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function parseIncludedResponse(bytes) {
  const blocks = [];
  let body = bytes;
  while (/^HTTP\/\d(?:\.\d)? \d{3}(?:[ \r\n])/.test(body.subarray(0, 80).toString("ascii"))) {
    let end = body.indexOf("\r\n\r\n"), separator = 4;
    if (end < 0) { end = body.indexOf("\n\n"); separator = 2; }
    if (end < 0 || end > 65536) throw new Error("Missing or over-budget HTTP response headers");
    const [statusLine, ...lines] = body.subarray(0, end).toString("utf8").split(/\r?\n/);
    const headers = {};
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon < 1) throw new Error("Malformed included response header");
      const name = line.slice(0, colon).toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (["authorization", "cookie", "set-cookie", "location"].includes(name)
        || /https?:\/\/\S+\?/.test(value)) headers[name] = "[credential-bearing header omitted]";
      else headers[name] = value;
    }
    blocks.push({ status: Number(statusLine.split(" ")[1]), statusLine, headers });
    body = body.subarray(end + separator);
  }
  if (!blocks.length) throw new Error("No actual HTTP response headers captured");
  return { blocks, body };
}

export function quotaStop(blocks) {
  return blocks.some(({ status, headers }) => status === 403 || status === 429
    || Object.hasOwn(headers, "retry-after")
    || headers["x-ratelimit-remaining"] !== undefined && Number(headers["x-ratelimit-remaining"]) === 0);
}

export function queueTarget(row, endpoint) {
  if (!Number.isSafeInteger(row.runId) || !Number.isSafeInteger(row.artifactId)) throw new Error("Invalid queued identity");
  const prefix = "repos/github/gh-aw/actions";
  if (endpoint === `${prefix}/artifacts/${row.artifactId}/zip`) {
    return { file: `${row.artifactId}.zip`, maxBytes: 16 * 1024 * 1024, kind: "artifact" };
  }
  if (endpoint === `${prefix}/runs/${row.runId}/attempts/1/jobs?per_page=100`) {
    return { file: `${row.runId}-jobs.json`, maxBytes: 8 * 1024 * 1024, kind: "jobs" };
  }
  if (endpoint === `${prefix}/runs/${row.runId}/attempts/1/logs`) {
    return { file: `${row.runId}-logs.zip`, maxBytes: 64 * 1024 * 1024, kind: "logs" };
  }
  throw new Error("Endpoint is outside the exact coordinated queue scope");
}

export async function resumeLockfileAcquisition(cache, releaseId) {
  if (releaseId !== "coordinated-2026-10-19-17-item-release") throw new Error("Explicit coordinated release is required");
  const queueBytes = readFileSync(`${directory}/resume.json`);
  const queue = JSON.parse(queueBytes);
  if (queue.repository !== "github/gh-aw" || queue.until !== "2026-10-18T15:00:12Z"
    || queue.pending.length !== 17 || queue.contractSha256 !== "e1efbb89684712dd6b2e1ad8728e1985d403afa55ccc5b8c44e6f7e1902b2143") {
    throw new Error("Frozen 17-item acquisition queue changed");
  }
  const receiptFile = `${directory}/acquisition-2026-10-19.json`;
  if (existsSync(receiptFile)) throw new Error("This release has already run; no automatic retry is permitted");
  const receipt = { schemaVersion: 1, releaseId, concurrency: 1, minimumDelayMilliseconds: 1500,
    queueSha256: sha256(queueBytes), queue: queue.pending, startedAt: new Date().toISOString(),
    status: "acquiring-exact-queue", requests: [], automaticRetry: false,
    headerPolicy: "Actual response headers, excluding credential-bearing cookies, authorization and signed redirect URLs." };
  const save = () => writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + "\n");
  save();
  try {
    for (const row of queue.pending) for (const endpoint of row.endpoints) {
      const target = queueTarget(row, endpoint);
      const file = path.join(cache, target.file);
      if (existsSync(file)) throw new Error(`Queued acquisition unexpectedly already cached: ${target.file}`);
      if (receipt.requests.length) await setTimeout(receipt.minimumDelayMilliseconds);
      const startedAt = new Date().toISOString();
      const result = spawnSync("gh", ["api", "--include", "--method", "GET", endpoint], {
        timeout: 90000, maxBuffer: target.maxBytes + 65536, env: { ...process.env, GH_PAGER: "cat" },
      });
      const response = parseIncludedResponse(result.stdout ?? Buffer.alloc(0));
      const record = { endpoint, runId: row.runId, artifactId: row.artifactId,
        startedAt, endedAt: new Date().toISOString(), headers: response.blocks,
        bytes: response.body.length, sha256: sha256(response.body), accepted: false };
      receipt.requests.push(record);
      if (quotaStop(response.blocks)) {
        receipt.status = "stopped-quota-signal";
        save();
        return receipt;
      }
      if (result.error || result.status !== 0 || response.blocks.at(-1).status !== 200) {
        throw new Error(`Acquisition failed for ${endpoint}; exit ${result.status}, HTTP ${response.blocks.at(-1).status}`);
      }
      if (response.body.length > target.maxBytes) throw new Error("Individual acquisition byte budget exceeded");
      if (target.kind === "jobs") {
        const jobs = JSON.parse(response.body);
        if (jobs.total_count !== jobs.jobs?.length || jobs.jobs.some(job => job.run_id !== row.runId)) {
          throw new Error("Incomplete or wrong-run jobs response");
        }
      } else if (response.body.subarray(0, 4).toString("hex") !== "504b0304") {
        throw new Error("Acquired archive is not a ZIP");
      }
      writeFileSync(file, response.body, { flag: "wx" });
      record.accepted = true;
      save();
      console.error(`${receipt.requests.length}: acquired ${target.file}`);
    }
    receipt.status = "exact-queue-acquired";
    receipt.completedAt = new Date().toISOString();
    save();
    return receipt;
  } catch (error) {
    receipt.status = "stopped-acquisition-error";
    receipt.error = error.message;
    save();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await resumeLockfileAcquisition(process.argv[2], process.argv[3]);
  console.log(JSON.stringify({ status: result.status, requests: result.requests.length,
    accepted: result.requests.filter(request => request.accepted).length,
    lastHeaders: result.requests.at(-1)?.headers }));
}
