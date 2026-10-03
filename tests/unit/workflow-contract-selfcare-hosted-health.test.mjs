import assert from "node:assert/strict";
import test from "node:test";
import { workflow } from "./workflow-contract.helpers.mjs";

test("hosted health is a four-hour, policy-gated SelfCare worker", () => {
  const orchestrator = workflow("self-care.md");
  const worker = workflow("self-care-hosted-health.md");

  assert.match(orchestrator, /self-care-hosted-health.*preceding four hours/);
  assert.match(orchestrator, /If any run history is unavailable or ambiguous, fail closed/);
  assert.match(worker, /worker: hosted-health/);
  assert.match(worker, /cao_authorized == 'true'/);
  assert.match(worker, /precomputed `target_repo` is exactly `githubnext\/gh-aw-cao` and `safe_output_mode` is `live`/);
  assert.doesNotMatch(worker, /^\s+schedule:/m);
});

test("hosted health reads CAO and OTEL through scoped MCP and replaces its report", () => {
  const worker = workflow("self-care-hosted-health.md");

  assert.match(worker, /url: https:\/\/cao\.githubnext\.com\/mcp/);
  assert.match(worker, /allowed: \[cao_catalog, cao_query\]/);
  assert.match(worker, /url: \$\{\{ vars\.CAO_OTEL_MCP_URL \}\}/);
  assert.match(worker, /CAO_OTEL_MCP_READ_AUTHORIZATION/);
  assert.match(worker, /cache-memory:/);
  assert.match(worker, /rolling four-hour UTC window/);
  assert.match(worker, /close-older-issues: true/);
  assert.match(worker, /If the OTEL MCP URL, credential, server, or query capabilities are absent/);
  assert.doesNotMatch(worker, /^\s+(contents|actions|issues|pull-requests): write$/m);
});
