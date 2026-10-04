import assert from "node:assert/strict";
import test from "node:test";
import { workflow } from "./workflow-contract.helpers.mjs";

test("hosted health is a four-hour, policy-gated SelfCare worker", () => {
  const orchestrator = workflow("self-care.md");
  const worker = workflow("self-care-hosted-health.md");

  assert.match(orchestrator, /self-care-hosted-health.*preceding four hours/);
  assert.match(orchestrator, /If any run history is unavailable or ambiguous, fail closed/);
  assert.match(orchestrator, /`review` permits only `self-care-hosted-health`/);
  assert.match(orchestrator, /Never dispatch a worker other than `self-care-hosted-health` in review mode/);
  assert.match(worker, /worker: hosted-health/);
  assert.match(worker, /cao_authorized == 'true'/);
  assert.match(worker, /precomputed `target_repo` is exactly `githubnext\/gh-aw-cao` and `safe_output_mode` is either `review` or `live`/);
  assert.match(worker, /In `review` mode, publish only through the configured review safe-output repository/);
  assert.doesNotMatch(worker, /inputs\.safe_output_mode \|\| 'review'\) == 'live'/);
  assert.doesNotMatch(worker, /^\s+schedule:/m);
});

test("hosted health reads CAO and OTEL through scoped MCP and replaces its report", () => {
  const worker = workflow("self-care-hosted-health.md");

  assert.match(worker, /url: https:\/\/cao\.githubnext\.com\/mcp/);
  assert.match(worker, /allowed: \[cao_catalog, cao_query\]/);
  assert.match(worker, /url: \$\{\{ vars\.CAO_OTEL_MCP_URL \}\}/);
  assert.match(worker, /CAO_OTEL_MCP_READ_AUTHORIZATION/);
  assert.match(worker, /allowed: \[SearchSQL, StreamList, StreamSchema, GetLatestTraces\]/);
  assert.doesNotMatch(worker, /PrometheusRangeQuery/);
  assert.doesNotMatch(worker, /allowed: \[[^\]]*(tool_search|tools_call)/);
  assert.match(worker, /name: Verify OpenObserve MCP read access/);
  assert.match(worker, /openobserve-smoke\.json/);
  assert.match(worker, /"method":"tools\/list"/);
  assert.match(worker, /name: "SearchSQL"/);
  assert.match(worker, /name: "GetLatestTraces"/);
  assert.match(worker, /trace_stream: \$trace_stream/);
  assert.match(worker, /read_pull_requests: read/);
  assert.match(worker, /id-token: write/);
  assert.match(worker, /cache-memory:/);
  assert.match(worker, /rolling four-hour UTC window/);
  assert.match(worker, /close-older-issues: true/);
  assert.match(worker, /deduplicate-by-title: true/);
  assert.match(worker, /If the OTEL MCP URL, credential, server, smoke result, or query capabilities are absent/);
  assert.match(worker, /do not assume Prometheus-compatible query access/);
  assert.match(worker, /Do not use `tool_search`, `tools_call`, or any mutation-capable OpenObserve tool/);
  assert.doesNotMatch(worker, /^\s+(contents|actions|issues|pull-requests): write$/m);
});
