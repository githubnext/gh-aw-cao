import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const output = "docs/operational-value/proof/blog-auditor";
const objects = [
  "df3ea140fda9a2e77f44426d64b58e7fd22b383e",
  "61296b06dd6643ed2f0ecedcb50b0e2ae7bfee83",
];
const allowed = new Set(["content-type", "date", "etag", "x-github-request-id",
  "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-ratelimit-resource", "retry-after"]);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
mkdirSync(output, { recursive: true });
for (const [index, id] of objects.entries()) {
  if (index) await setTimeout(1600);
  const endpoint = `repos/github/gh-aw/git/blobs/${id}`;
  let bytes;
  let exitStatus = 0;
  try {
    bytes = execFileSync("gh", ["api", "--method", "GET", "--include", endpoint], {
      timeout: 45000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (!Number.isInteger(error.status)) throw error;
    exitStatus = error.status;
    bytes = error.stdout;
  }
  const raw = bytes.toString("utf8");
  const separator = raw.match(/\r?\n\r?\n/);
  if (!separator) throw new Error("Provider response did not contain HTTP headers; stop without retry");
  const headerBlock = raw.slice(0, separator.index);
  const body = raw.slice(separator.index + separator[0].length);
  const status = Number(headerBlock.match(/^HTTP\/[\d.]+ (\d+)/)?.[1]);
  const headers = {};
  for (const line of headerBlock.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0 && allowed.has(line.slice(0, colon).toLowerCase())) {
      headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    }
  }
  const receipt = { endpoint, status, exitStatus, receivedAt: new Date().toISOString(),
    headers, responseSha256: hash(body), response: Buffer.from(body).toString("base64") };
  const file = path.join(output, `adoption-${id}.json.gz`);
  writeJsonArchive(file, receipt);
  if ([403, 429].includes(status) || headers["retry-after"] !== undefined || headers["x-ratelimit-remaining"] === "0") {
    throw new Error(`Provider acquisition paused at ${id}; actual failure headers retained; remaining object requests pending`);
  }
  if (status !== 200 || exitStatus !== 0) throw new Error(`Provider GET ${id} failed: ${status}; no retry`);
  const response = JSON.parse(body);
  const encoded = response.content?.replace(/\n/g, "");
  const content = Buffer.from(encoded ?? "", "base64");
  if (response.sha !== id || response.encoding !== "base64" || content.length !== response.size
    || content.toString("base64") !== encoded
    || createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex") !== id) {
    throw new Error(`Immutable source identity mismatch at ${id}; original response retained`);
  }
  Object.assign(receipt, { gitBlob: id, sha256: hash(content), bytes: content.length,
    content: content.toString("base64"), verified: true });
  writeJsonArchive(file, receipt);
  console.log(JSON.stringify({ id, status, sha256: receipt.sha256, bytes: content.length,
    remaining: headers["x-ratelimit-remaining"], file }));
}
