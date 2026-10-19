#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { writeCensusJson } from "./operational-value-census-io.mjs";

const receiptsOnly = process.argv[2] === "--receipts";
if (process.argv.length > (receiptsOnly ? 3 : 2)) throw new Error("usage: discover-daily-cli-performance-native.mjs [--receipts]");
const output = `docs/operational-value/proof/daily-cli-performance/native-${receiptsOnly ? "receipts" : "discovery"}.json.gz`;
if (existsSync(output)) throw new Error("Acquisition already recorded; an additional slot is required for any new request");
const endpoints = receiptsOnly ? [
  "repos/github/gh-aw/actions/artifacts/12126257720/zip",
  "repos/github/gh-aw/actions/runs/39099938569/jobs?per_page=100",
  "repos/github/gh-aw/actions/runs/39099938569/logs",
  "repos/github/gh-aw/commits/10f9281950798beb307862f81caf03807d48e89e/check-runs?per_page=100",
] : [
  "repos/github/gh-aw/actions/workflows/cgo.yml/runs?branch=main&created=%3C2026-10-18T15%3A00%3A12Z&per_page=100",
  "repos/github/gh-aw/actions/artifacts?name=benchmark-results&per_page=100",
  "repos/github/gh-aw/actions/workflows/daily-cli-performance.lock.yml/runs?created=2025-12-31T17%3A50%3A25Z..2026-10-18T15%3A00%3A12Z&per_page=100",
];
const allowedHeaders = new Set([
  "content-type", "date", "etag", "x-github-request-id", "x-ratelimit-limit",
  "x-ratelimit-remaining", "x-ratelimit-reset", "x-ratelimit-resource", "retry-after", "link",
  "content-length", "last-modified", "x-ms-request-id",
]);
const discovery = {
  schemaVersion: 1, repository: "github/gh-aw", repositoryId: 1036865607,
  revision: "c86377ec47b38f0b5af463277ee55d1d03d08da8", cutoff: "2026-10-18T15:00:12Z",
  authority: `Coordinator-released slot: exactly ${endpoints.length} listed GETs, serial, 1500ms pacing; no pagination or other follow-up authorized.`,
  requests: endpoints, receipts: [], complete: false, nativeMeasurementCredit: false,
};
for (const endpoint of endpoints) {
  if (discovery.receipts.length) await setTimeout(1500);
  const result = spawnSync("gh", ["api", "--include", "--method", "GET", endpoint], {
    timeout: 45000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  const windowsBoundary = result.stdout.indexOf("\r\n\r\n");
  const boundary = windowsBoundary >= 0 ? windowsBoundary : result.stdout.indexOf("\n\n");
  const headerText = result.stdout.subarray(0, boundary).toString("utf8");
  const match = /^HTTP\/[\d.]+ (\d+)[^\r\n]*\r?\n([\s\S]*)$/.exec(headerText);
  if (!match) throw new Error("Provider did not return an auditable HTTP response; do not retry without a slot");
  const status = Number(match[1]), body = result.stdout.subarray(boundary + (windowsBoundary >= 0 ? 4 : 2));
  const headers = {};
  for (const line of match[2].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    const name = line.slice(0, separator).toLowerCase();
    if (separator > 0 && allowedHeaders.has(name)) headers[name] = line.slice(separator + 1).trim();
  }
  const binary = endpoint.endsWith("/zip") || endpoint.endsWith("/logs");
  const payload = binary ? {} : JSON.parse(body);
  for (const run of payload.workflow_runs ?? []) {
    if (run.repository?.id !== discovery.repositoryId) throw new Error("Run discovery repository identity mismatch");
  }
  const receipt = {
    endpoint, status, receivedAt: new Date().toISOString(), headers,
    bodyEncoding: "base64", bodySha256: createHash("sha256").update(body).digest("hex"),
    originalBody: body.toString("base64"), totalCount: payload.total_count ?? null,
    binary,
    returned: (payload.workflow_runs ?? payload.artifacts ?? payload.jobs ?? payload.check_runs ?? []).length,
    next: headers.link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null,
  };
  discovery.receipts.push(receipt);
  discovery.pendingEndpoints = endpoints.slice(discovery.receipts.length);
  if (status !== 200 || result.status !== 0 || headers["retry-after"] || headers["x-ratelimit-remaining"] === "0") {
    discovery.stopped = "Provider refusal, quota/backoff signal or command failure; pending requests require a new coordinated slot.";
    writeCensusJson(output, discovery);
    console.log(JSON.stringify({ stopped: discovery.stopped, receipt: { ...receipt, originalBody: undefined } }));
    process.exitCode = 1;
    break;
  }
  writeCensusJson(output, discovery);
}
discovery.complete = discovery.receipts.length === endpoints.length
  && discovery.receipts.every(receipt => receipt.status === 200) && !discovery.stopped;
discovery.historyComplete = false;
writeCensusJson(output, discovery);
console.log(JSON.stringify({ complete: discovery.complete, historyComplete: false,
  receipts: discovery.receipts.map(({ originalBody, ...receipt }) => receipt) }));
